import type { AgentDefinition, HookCallback, Query } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserTool } from '../protocol.ts';
import { PANEL_PACKS, PANEL_SERVERS, browserToolOf, mcpPacks } from '../mcp.ts';
import { browser } from '../browser.ts';
import { BROWSER_RECORD } from '../tools.ts';
import type { BrowserLayers } from '../prompt.ts';
import { config } from '../config.ts';
import { oneLine } from '../text.ts';
import { livePrompt } from './promptReload.ts';
import { CHROME } from './mcpMenu.ts';
import { PROGRESS_NOTE, PROGRESS_TOOL } from './util.ts';

export const CHROME_TOOL = `mcp__${CHROME}__`;
const BROWSER_AGENT = 'browser';
export const agentKey = (a: Record<string, AgentDefinition> | null) => (a ? `${a[BROWSER_AGENT].model}:${a[BROWSER_AGENT].tools?.join()}` : '');
// Packs in ~/.claude/mcp that drive a Chrome other than the panel's; the browser prompt steers away from them.
const OTHER_BROWSER_PACKS = ['chrome', 'playwright'];
// How long a Claude in Chrome call waits for the panel's extension to reach the bridge.
const CHROME_CONNECT_MS = 25_000;
// The whole browser check of one call, under the hook's 90 s timeout: a hook that times out lets the call through.
const BROWSER_CHECK_MS = 75_000;
// Claude in Chrome tools that only list or pick browsers; the model calls them itself when the user asks.
const CHROME_PICKS = ['list_connected_browsers', 'select_browser', 'switch_browser'];
const CHROME_ON_PANEL = "Checked by the app: Claude in Chrome's selected browser is the Browser panel's Chrome, so its calls act on the panel, not the user's own Chrome.";
const CHROME_RESET = "The Browser panel's Chrome or this session's Claude restarted while Claude in Chrome was checked. Try again.";
const CHROME_ELSEWHERE = (id: string) =>
  `Claude in Chrome is pointed at another browser, not the Browser panel. Ask the user, then use select_browser with deviceId ${id} to use the Browser panel.`;
const CHROME_UNSET = (id: string) =>
  `Claude in Chrome has no browser selected for this session. Ask the user, then use select_browser with deviceId ${id} to use the Browser panel.`;
const BROWSER_OFF = 'The Browser panel is off for agents. Ask the user to turn on "Use the Browser panel for agents" in the Browser panel.';
// inUse marks the browser this CLI's calls go to, once that is settled.
type ChromeBrowser = { deviceId: string; inUse?: boolean };

export type BrowserHost = {
  id: string;
  q: () => Query | null;
  busy: () => boolean;
  turnNo: () => number;
  packs: () => string[];
  cliChrome: () => boolean;
};

// The session's side of the Browser panel: its layers, the browser subagent, and the hooks that gate browser calls.
export class BrowserGate {
  private host: BrowserHost;
  // Another browser this CLI verifiably selected through select_browser or switch_browser, next to the panel device
  // it was told apart from. Cleared before every new selection runs.
  private chromeOther: { q: Query; panel: string; device: string } | null = null;
  // The CLI already told that Claude in Chrome acts on the panel; its tool output never says which browser it drives.
  private chromeNoted: Query | null = null;

  constructor(host: BrowserHost) {
    this.host = host;
  }

  cliStarted() {
    this.chromeOther = null;
  }

  // The browser layers this session's running CLI has, so the panel keeps Chrome up and shows them.
  hold() {
    const tools: BrowserTool[] = [];
    if (this.host.q()) {
      const packs = this.host.packs();
      if (this.host.cliChrome() && !browser.claudeWhyNot) tools.push('claude');
      if (packs.includes(PANEL_PACKS.playwright)) tools.push('playwright');
      if (packs.includes(PANEL_PACKS.devtools)) tools.push('devtools');
    }
    browser.hold(this.host.id, tools);
  }

  layers(): BrowserLayers {
    if (!browser.agents) return { playwright: false, devtools: false, claude: false, other: [] };
    const packs = this.host.packs();
    const other = mcpPacks().filter((p) => OTHER_BROWSER_PACKS.includes(p.key) && packs.includes(p.key)).flatMap((p) => Object.keys(p.servers).map((s) => `mcp__${s}__`));
    const chrome = packs.includes(CHROME);
    const own = !!browser.claudeWhyNot;
    return { playwright: packs.includes(PANEL_PACKS.playwright), devtools: packs.includes(PANEL_PACKS.devtools), claude: chrome && !own, claudeOwn: chrome && own, other };
  }

  // The browser subagent, when the switch and a panel layer are on. Server-level tool entries resolve when it spawns,
  // so panel packs switched live reach it without a restart; Claude in Chrome only when it acts on the panel.
  agent(): Record<string, AgentDefinition> | null {
    const l = this.layers();
    if (!l.playwright && !l.devtools && !l.claude) return null;
    const servers = [PANEL_SERVERS.playwright, PANEL_SERVERS.devtools, ...(l.claude ? [CHROME] : [])].map((s) => `mcp__${s}`);
    const tools = [...servers, BROWSER_RECORD, PROGRESS_TOOL, 'Read', 'Grep', 'Glob', 'ToolSearch'];
    const prompt = livePrompt.browserAgentPromptOf(l.claude) + PROGRESS_NOTE;
    return { [BROWSER_AGENT]: { description: livePrompt.browserAgentDescription, prompt, tools, model: config.browserAgentModel } };
  }

  // Lights the panel's badge. The panel packs connect on first use and Claude in Chrome needs the panel's extension on
  // the bridge, so Chrome must be up before the tool runs; a failure denies the call instead of using another browser.
  preHook: HookCallback = async (input, _id, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = browserToolOf(input.tool_name);
    if (!tool) return {};
    // Switch off, or a panel that cannot host it here: Claude in Chrome runs as in stock Claude Code; a panel pack left
    // loaded in this CLI has no browser.
    if (tool === 'claude' && browser.claudeWhyNot) return {};
    if (!browser.agents) {
      if (tool === 'claude') return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BROWSER_OFF } };
    }
    const id = this.host.id;
    const q = this.host.q();
    const until = Date.now() + BROWSER_CHECK_MS;
    // Held from here until the call ends (Post hooks, turn end or CLI stop), so Chrome cannot idle out under it.
    browser.acquire(id, input.tool_use_id, () => this.host.q() === q && this.host.busy());
    let on: 'panel' | 'other' | 'pick' = 'panel';
    // A check still running near the hook's own timeout denies, since a timed-out hook lets the call through.
    let late: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, no) => (late = setTimeout(() => no(new Error('The browser check timed out. Try the call again.')), BROWSER_CHECK_MS + 5000)));
    try {
      if (tool !== 'claude') await Promise.race([browser.ensure(until), deadline]);
      else on = await Promise.race([this.chromeCheck(input.tool_name, until, signal), deadline]);
    } catch (err) {
      browser.release(id, input.tool_use_id);
      const why = err instanceof Error ? err.message : String(err);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
    } finally {
      clearTimeout(late);
    }
    if (on === 'other') browser.release(id, input.tool_use_id);
    if (on === 'panel') browser.activity(tool, id, this.host.turnNo());
    // Its list names browsers "Browser 1, 2…", so the model cannot tell which one is the panel without the id.
    if (on === 'pick' && input.tool_name === `${CHROME_TOOL}list_connected_browsers`) {
      const device = await browser.claudeDevice().catch(() => null);
      if (device) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Checked by the app: the Browser panel's Chrome is the browser with deviceId ${device}.` } };
    }
    if (on === 'panel' && tool === 'claude' && this.chromeNoted !== q) {
      this.chromeNoted = q;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: CHROME_ON_PANEL } };
    }
    return {};
  };

  // A browser call ended (done, failed or refused), so Chrome may count down to idle again.
  doneHook: HookCallback = async (input) => {
    if ('tool_use_id' in input && typeof input.tool_use_id === 'string') browser.release(this.host.id, input.tool_use_id);
    return {};
  };

  // Lets a Claude in Chrome call through when it acts on the panel browser, or on another browser this CLI verifiably
  // selected. It never changes the selection itself; whatever it cannot confirm denies the call.
  private async chromeCheck(name: string, until: number, signal: AbortSignal): Promise<'panel' | 'other' | 'pick'> {
    const action = name.slice(CHROME_TOOL.length);
    const q = this.host.q();
    if (!q) throw new Error(CHROME_RESET);
    if (CHROME_PICKS.includes(action)) {
      // A new selection voids the old one before it runs; the panel starts so it shows up in the list.
      if (action !== 'list_connected_browsers') this.chromeOther = null;
      await browser.ensure(Math.min(until, Date.now() + 40_000)).catch(() => {});
      return 'pick';
    }
    try {
      await browser.ensure(Math.min(until, Date.now() + 40_000));
    } catch (err) {
      throw new Error(`The Browser panel's Chrome did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The start may have found that this machine's Chrome cannot host Claude in Chrome.
    if (browser.claudeWhyNot) return 'other';
    const run = browser.runId;
    const connectBy = Math.min(until, Date.now() + CHROME_CONNECT_MS);
    for (;;) {
      if (this.host.q() !== q || browser.runId !== run) throw new Error(CHROME_RESET);
      const device = await browser.claudeDevice();
      let list: ChromeBrowser[] | null = null;
      let err: unknown = null;
      try {
        list = await this.chromeBrowsers(q, until, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        err = e;
      }
      if (this.host.q() !== q || browser.runId !== run) throw new Error(CHROME_RESET);
      if (device && list) {
        const used = list.find((b) => b.inUse)?.deviceId;
        if (used === device) return 'panel';
        const other = this.chromeOther;
        if (used && other?.q === q && other.panel === device && other.device === used) return 'other';
        // With the panel's extension on the bridge the answer is settled: the user decides, nothing switches here.
        if (list.some((b) => b.deviceId === device)) throw new Error(used ? CHROME_ELSEWHERE(device) : CHROME_UNSET(device));
      }
      if (Date.now() + 1000 > connectBy) {
        if (!list) throw new Error(`Could not check which browser Claude in Chrome uses: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(device
          ? "The Browser panel's Claude extension did not connect. Open the Browser panel and check that Claude in Chrome is signed in there."
          : 'Claude in Chrome is not set up in the Browser panel. Open the panel, install the Claude extension there and sign in.');
      }
      await new Promise<void>((ok) => {
        const done = () => {
          clearTimeout(t);
          signal.removeEventListener('abort', done);
          ok();
        };
        const t = setTimeout(done, 1000);
        signal.addEventListener('abort', done);
      });
      if (signal.aborted) throw new Error('The browser check was cancelled.');
    }
  }

  // Claude in Chrome's own tools, called on the control channel: no model turn, no permission prompt. A timeout or the
  // hook's abort cancels the request in the CLI too.
  private async chromeCall(q: Query, action: string, args: Record<string, unknown>, until: number, signal: AbortSignal) {
    type Request = (req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{ response?: unknown }>;
    const ctl = q as Query & { request?: Request };
    if (!ctl.request) throw new Error('This Claude Code version cannot check the Claude in Chrome browser.');
    const ms = Math.min(15_000, until - Date.now());
    if (ms <= 0) throw new Error('Claude in Chrome did not answer in time.');
    const late = AbortSignal.timeout(ms);
    let r: { response?: unknown };
    try {
      r = await ctl.request({ subtype: 'mcp_call', tool: `${CHROME_TOOL}${action}`, arguments: args }, { signal: AbortSignal.any([signal, late]) });
    } catch (err) {
      if (late.aborted && !signal.aborted) throw new Error('Claude in Chrome did not answer in time.');
      throw err;
    }
    const res = r.response as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    const text = res?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (res?.isError) throw new Error(`Claude in Chrome: ${oneLine(text, 200)}`);
    return text;
  }

  // Throws when the list cannot be read, so an error never passes for "no browser" or "another browser".
  private async chromeBrowsers(q: Query, until: number, signal: AbortSignal): Promise<ChromeBrowser[]> {
    const list = JSON.parse(await this.chromeCall(q, 'list_connected_browsers', {}, until, signal));
    if (!Array.isArray(list)) throw new Error('Claude in Chrome sent an unexpected browser list.');
    return list.filter((b) => typeof b?.deviceId === 'string');
  }

  // The model selected a browser (the user asked). It counts only when this CLI now verifiably uses a browser other than
  // the identified panel device; anything unclear leaves later calls checked against the panel.
  pickHook: HookCallback = async (input, _id, { signal }) => {
    const q = this.host.q();
    if (input.hook_event_name !== 'PostToolUse' || !q) return {};
    this.chromeOther = null;
    try {
      const res = input.tool_response as { isError?: unknown } | null;
      if (res && typeof res === 'object' && res.isError) return {};
      const device = await browser.claudeDevice();
      if (!device) return {};
      const used = (await this.chromeBrowsers(q, Date.now() + 15_000, signal)).find((b) => b.inUse)?.deviceId;
      const asked = (input.tool_input as { deviceId?: unknown } | null)?.deviceId;
      if (this.host.q() !== q || !used || used === device || (typeof asked === 'string' && asked !== used)) return {};
      this.chromeOther = { q, panel: device, device: used };
    } catch {}
    return {};
  };
}
