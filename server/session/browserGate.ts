import type { AgentDefinition, HookCallback, HookInput, HookJSONOutput, Query } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserChoice, BrowserTool } from '../protocol.ts';
import { PANEL_PACKS, PANEL_SERVERS, browserToolOf, panelServersFor, serversFor, type PanelTool } from '../mcp.ts';
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
// How long a Claude in Chrome call waits for the panel's extension to reach the bridge.
const CHROME_CONNECT_MS = 25_000;
// The browser check of one call, once the session's choice is known.
const BROWSER_CHECK_MS = 75_000;
// How long the first browser call waits for the user to answer the choice card.
const CHOICE_WAIT_MS = 10 * 60_000;
// The hook's own timeout. A hook that times out lets the call through, so every wait inside ends before it.
export const BROWSER_HOOK_SEC = (CHOICE_WAIT_MS + BROWSER_CHECK_MS) / 1000 + 15;
// Claude in Chrome tools that only list or pick browsers; the model calls them itself when the user asks.
const CHROME_PICKS = ['list_connected_browsers', 'select_browser', 'switch_browser'];
const CHROME_ON_PANEL = "Checked by the app: Claude in Chrome's selected browser is the Browser panel's Chrome, so its calls act on the panel, not the user's own Chrome.";
const CHROME_RESET = "The Browser panel's Chrome or this session's Claude restarted while Claude in Chrome was checked. Try again.";
const CHROME_ELSEWHERE = "Claude in Chrome could not be pointed at the Browser panel's Chrome. Try the call again.";
const OWN_ELSEWHERE = "Claude in Chrome could not be pointed at the user's own Chrome. Try the call again.";
const NO_CHOICE = 'The user has not chosen a browser for this session, so the call did not run. Do not retry it on your own: ask the user, or go on without the browser.';
const NO_CHOICE_SAID = (said: string) => `The user did not pick a browser for this session, so the call did not run. On the card they wrote: "${said}". Do not retry it on your own; answer what they wrote.`;
const SAID = (said: string) => `On the browser card the user also wrote: "${said}"`;
const PANEL_LATER = 'Background turned on Playwright (panel) for this session. Its tools load when this reply ends, so tell the user and use them in the next reply.';
const PANEL_LATER_CODEX = "Background turned on Playwright (panel) for this session. It is not in this Codex thread's tools: they arrive when this reply ends and the thread reopens, so tell the user and use them in the next reply.";
const PANEL_ONLY = "This session uses Background, so Claude in Chrome stays on the Browser panel's Chrome. If the user wants their own Chrome, call mcp__app__browser_choice with choice chrome first.";
const OWN_ONLY = "This session uses My Chrome, so Claude in Chrome stays off the Browser panel's Chrome. If the user wants the panel, call mcp__app__browser_choice with choice background first.";
const NO_OWN_CHROME = "The user's own Chrome is not connected to Claude in Chrome. Ask the user to open Chrome with the Claude extension signed in, then try again.";
const MANY_OWN_CHROME = "More than one of the user's own Chrome browsers is connected. Call list_connected_browsers, ask the user which one to use, then select_browser it.";
const OWN_WINDOW = (server: string) =>
  `${server} drives its own Chrome, which would open a window, so the app refused it. Use the Browser panel's tools (mcp__${PANEL_SERVERS.playwright}__*, mcp__${PANEL_SERVERS.devtools}__*); if they are off, ask the user to turn them on in the MCP menu.`;
// What browser_choice tells the model once the session has a choice.
const CHOICE_REPLY: Record<BrowserChoice, string> = {
  background: 'Browser for this session: Background. Browser tools run in the Browser panel, without a window.',
  chrome: "Browser for this session: My Chrome. Claude in Chrome acts in the user's own Chrome; Playwright and DevTools still run in the Browser panel, without a window.",
};
// The card's inputs. adds: Background has nothing to run on the panel here, so picking it turns on Playwright (panel).
export type BrowserCard = { limit: string | null; chrome: boolean; adds: boolean };
// inUse marks the browser this CLI's calls go to, once that is settled.
type ChromeBrowser = { deviceId: string; inUse?: boolean };
const deny = (why: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
const note = (text: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type BrowserHost = {
  id: string;
  cwd: string;
  q: () => Query | null;
  // What holds the session's tool list: the CLI's query, or a Codex thread's tool grant; a new one has the current packs.
  run: () => object | null;
  codex: () => boolean;
  // The running CLI's classification of its own servers (mcpMenu.liveBrowsers).
  liveBrowsers: () => Record<string, PanelTool>;
  busy: () => boolean;
  turnNo: () => number;
  packs: () => string[];
  cliChrome: () => boolean;
  // Shows the choice card; choice is null when it was skipped, cancelled or timed out. said: the user's own words on it.
  ask: (card: BrowserCard, signal: AbortSignal) => Promise<{ choice: BrowserChoice | null; said: string }>;
  // Turns on Playwright (panel) for this session, through the MCP menu's own apply.
  panelOn: () => void;
  // The choice changed: the roster and the CLI's browser note follow.
  changed: () => void;
};

// The session's side of the Browser panel: where its browser work goes, its layers, the browser subagent, and the hooks
// that gate browser calls.
export class BrowserGate {
  // null until the user answers the card.
  choice: BrowserChoice | null;
  private host: BrowserHost;
  // The open card, shared by every call that waits on it; resolves to what the user wrote on it.
  private asking: Promise<string> | null = null;
  private stopAsk: AbortController | null = null;
  // The CLI already told that Claude in Chrome acts on the panel; its tool output never says which browser it drives.
  private chromeNoted: Query | null = null;
  // Background turned Playwright (panel) on once, so switching it off later in the MCP menu stands.
  private panelAdded = false;
  // The run that was mid-reply then (host.run); it gets the tools only once it is replaced.
  private panelLater: object | null = null;

  // saved: a restored tab's choice, kept as is; undefined (a new session) takes the Settings default.
  constructor(host: BrowserHost, saved?: BrowserChoice | null) {
    this.host = host;
    this.choice = saved !== undefined ? saved : config.browserDefault === 'ask' ? null : config.browserDefault;
  }

  setChoice(choice: BrowserChoice | null) {
    if (choice === this.choice) return;
    this.choice = choice;
    // A pick in the panel header answers an open card.
    if (choice) this.stopAsk?.abort(choice);
    this.panelForBackground();
    this.hold();
    this.host.changed();
  }

  // The session's choice, asking once for every call that comes before the answer; said is what the user wrote on that card.
  async choose(signal: AbortSignal): Promise<{ choice: BrowserChoice; said: string }> {
    const said = this.choice ? '' : await (this.asking ??= this.ask(signal));
    if (signal.aborted) throw new Error('The browser call was cancelled.');
    if (!this.choice) throw new Error(said ? NO_CHOICE_SAID(said) : NO_CHOICE);
    // A Background that came from the Settings default or a restored tab is checked on first use.
    this.panelForBackground();
    return { choice: this.choice, said };
  }

  private async ask(signal: AbortSignal) {
    const stop = (this.stopAsk = new AbortController());
    try {
      const card = { limit: browser.claudeWhyNot, chrome: this.host.packs().includes(CHROME), adds: this.needsPanel() };
      const { choice, said } = await this.host.ask(card, AbortSignal.any([signal, stop.signal, AbortSignal.timeout(CHOICE_WAIT_MS)]));
      if (choice && !this.choice) this.setChoice(choice);
      return said;
    } finally {
      this.asking = null;
      this.stopAsk = null;
    }
  }

  // What browser_choice tells the model: the choice, the user's own words, and tools that arrive only after this reply.
  reply({ choice, said }: { choice: BrowserChoice; said: string }) {
    return [CHOICE_REPLY[choice], said && SAID(said), this.laterNote()].filter(Boolean).join(' ');
  }

  // Background would have no tool here, and was not given one before: no Playwright or DevTools server on the panel, and no
  // Claude in Chrome the panel can host (a Codex thread never gets Claude in Chrome).
  private needsPanel() {
    const l = this.layers();
    return !this.panelAdded && !panelServersFor(this.host.packs()).length && !(l.claude && !l.claudeWhyNot && !this.host.codex());
  }

  // Background with nothing to run on the panel turns on Playwright (panel); the session's other MCP choices stay as they are.
  private panelForBackground() {
    if (this.choice !== 'background' || !this.needsPanel()) return;
    this.panelAdded = true;
    if (this.host.busy()) this.panelLater = this.host.run();
    this.host.panelOn();
  }

  // What the model hears while the run it is in still lacks the Playwright (panel) that Background turned on.
  private laterNote() {
    if (!this.panelLater || this.panelLater !== this.host.run()) return '';
    return this.host.codex() ? PANEL_LATER_CODEX : PANEL_LATER;
  }

  // The browser layers this session's running CLI has on the panel, so the panel keeps Chrome up and shows them.
  hold() {
    const tools: BrowserTool[] = [];
    if (this.host.q()) {
      const l = this.layers();
      if (this.host.cliChrome() && this.claudeOnPanel(l)) tools.push('claude');
      if (l.playwright) tools.push('playwright');
      if (l.devtools) tools.push('devtools');
    }
    browser.hold(this.host.id, tools);
  }

  // Playwright and DevTools always drive the panel; Claude in Chrome follows the choice.
  layers(): BrowserLayers {
    const packs = this.host.packs();
    return {
      choice: this.choice, playwright: packs.includes(PANEL_PACKS.playwright), devtools: packs.includes(PANEL_PACKS.devtools),
      claude: packs.includes(CHROME), claudeWhyNot: browser.claudeWhyNot,
    };
  }

  private claudeOnPanel(l: BrowserLayers) {
    return l.claude && l.choice === 'background' && !l.claudeWhyNot;
  }

  // The browser subagent, while a panel pack is on and the user did not pick their own Chrome. Server-level tool entries
  // resolve when it spawns, so panel packs switched live reach it without a restart; Claude in Chrome only on the panel.
  agent(): Record<string, AgentDefinition> | null {
    const l = this.layers();
    if (l.choice === 'chrome' || (!l.playwright && !l.devtools)) return null;
    const chrome = this.claudeOnPanel(l);
    const servers = [PANEL_SERVERS.playwright, PANEL_SERVERS.devtools, ...(chrome ? [CHROME] : [])].map((s) => `mcp__${s}`);
    const tools = [...servers, BROWSER_RECORD, PROGRESS_TOOL, 'Read', 'Grep', 'Glob', 'ToolSearch'];
    const prompt = livePrompt.browserAgentPromptOf(chrome) + PROGRESS_NOTE;
    return { [BROWSER_AGENT]: { description: livePrompt.browserAgentDescription, prompt, tools, model: config.browserAgentModel } };
  }

  // Asks for the session's choice on its first browser call, then routes the call. Panel calls need Chrome up first, and
  // Claude in Chrome must be pointed at the chosen browser; whatever cannot be confirmed denies the call.
  preHook: HookCallback = async (input, _id, { signal }) => {
    const said = { text: '' };
    const out = await this.check(input, signal, said);
    if (!said.text) return out;
    // What the user wrote on the card goes to the model with the call's own outcome.
    const h = 'hookSpecificOutput' in out && out.hookSpecificOutput?.hookEventName === 'PreToolUse' ? out.hookSpecificOutput : undefined;
    if (h?.permissionDecision === 'deny') return deny(`${h.permissionDecisionReason} ${SAID(said.text)}`);
    return note(h?.additionalContext ? `${h.additionalContext}\n${SAID(said.text)}` : SAID(said.text));
  };

  private async check(input: HookInput, signal: AbortSignal, said: { text: string }): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const name = input.tool_name;
    const tool = browserToolOf(name, this.host.cwd, this.host.liveBrowsers());
    if (!tool) return {};
    // A browser server the app did not point at the panel starts a Chrome of its own.
    const server = name.slice(5, name.indexOf('__', 5));
    if (tool !== 'claude' && !(server in serversFor(this.host.packs()))) return deny(OWN_WINDOW(server));
    try {
      said.text = (await this.choose(signal)).said;
    } catch (err) {
      return deny(message(err));
    }
    const until = Date.now() + BROWSER_CHECK_MS;
    const args = (input.tool_input ?? {}) as { deviceId?: unknown };
    if (tool === 'claude' && this.choice === 'chrome') {
      try {
        return await this.ownChrome(name.slice(CHROME_TOOL.length), args.deviceId, until, signal);
      } catch (err) {
        return deny(message(err));
      }
    }
    if (tool === 'claude' && browser.claudeWhyNot) return deny([`Claude in Chrome cannot run in the Browser panel on this machine. ${browser.claudeWhyNot}`, this.laterNote()].filter(Boolean).join(' '));
    const id = this.host.id;
    const q = this.host.q();
    // Held from here until the call ends (Post hooks, turn end or CLI stop), so Chrome cannot idle out under it.
    browser.acquire(id, input.tool_use_id, () => this.host.q() === q && this.host.busy());
    let on: 'panel' | 'pick' = 'panel';
    // A check still running near its deadline denies, so it never runs into the hook's own timeout.
    let late: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, no) => (late = setTimeout(() => no(new Error('The browser check timed out. Try the call again.')), BROWSER_CHECK_MS + 5000)));
    try {
      if (tool !== 'claude') await Promise.race([browser.ensure(until), deadline]);
      else on = await Promise.race([this.chromeCheck(name, args.deviceId, until, signal), deadline]);
    } catch (err) {
      browser.release(id, input.tool_use_id);
      return deny(message(err));
    } finally {
      clearTimeout(late);
    }
    if (on === 'panel') browser.activity(tool, id, this.host.turnNo());
    // Its list names browsers "Browser 1, 2…", so the model cannot tell which one is the panel without the id.
    if (on === 'pick' && name === `${CHROME_TOOL}list_connected_browsers`) {
      const device = await browser.claudeDevice().catch(() => null);
      if (device) return note(`Checked by the app: the Browser panel's Chrome is the browser with deviceId ${device}.`);
    }
    if (on === 'panel' && tool === 'claude' && this.chromeNoted !== q) {
      this.chromeNoted = q;
      return note(CHROME_ON_PANEL);
    }
    return {};
  }

  // A browser call ended (done, failed or refused), so Chrome may count down to idle again.
  doneHook: HookCallback = async (input) => {
    if ('tool_use_id' in input && typeof input.tool_use_id === 'string') browser.release(this.host.id, input.tool_use_id);
    return {};
  };

  // My Chrome: moves Claude in Chrome off the panel's device when this CLI still points at it or at nothing. Without the
  // panel's extension on the bridge, every connected browser is the user's own and the call runs as in stock Claude Code.
  private async ownChrome(action: string, picked: unknown, until: number, signal: AbortSignal): Promise<HookJSONOutput> {
    const q = this.host.q();
    if (!q) throw new Error(CHROME_RESET);
    const device = await browser.claudeDevice();
    if (CHROME_PICKS.includes(action)) {
      if (device && action === 'list_connected_browsers') return note(`Checked by the app: deviceId ${device} is the Browser panel's Chrome, not the user's own.`);
      if (device && picked === device) throw new Error(OWN_ONLY);
      return {};
    }
    if (!device) return {};
    const list = await this.chromeBrowsers(q, until, signal);
    const used = list.find((b) => b.inUse)?.deviceId;
    if (used && used !== device) return {};
    const own = list.filter((b) => b.deviceId !== device);
    if (!own.length) throw new Error(NO_OWN_CHROME);
    if (own.length > 1) throw new Error(MANY_OWN_CHROME);
    await this.chromeCall(q, 'select_browser', { deviceId: own[0].deviceId }, until, signal);
    if ((await this.chromeBrowsers(q, until, signal)).find((b) => b.inUse)?.deviceId !== own[0].deviceId) throw new Error(OWN_ELSEWHERE);
    return {};
  }

  // Background: points Claude in Chrome at the identified panel device and verifies it before any page action runs.
  private async chromeCheck(name: string, picked: unknown, until: number, signal: AbortSignal): Promise<'panel' | 'pick'> {
    const action = name.slice(CHROME_TOOL.length);
    const q = this.host.q();
    if (!q) throw new Error(CHROME_RESET);
    if (CHROME_PICKS.includes(action)) {
      // The panel starts so it shows up in the list.
      await browser.ensure(Math.min(until, Date.now() + 40_000)).catch(() => {});
      if (action !== 'list_connected_browsers' && picked !== (await browser.claudeDevice())) throw new Error(PANEL_ONLY);
      return 'pick';
    }
    try {
      await browser.ensure(Math.min(until, Date.now() + 40_000));
    } catch (err) {
      throw new Error(`The Browser panel's Chrome did not start: ${message(err)}`);
    }
    // The start may have found that this machine's Chrome cannot host Claude in Chrome.
    if (browser.claudeWhyNot) throw new Error(`Claude in Chrome cannot run in the Browser panel on this machine. ${browser.claudeWhyNot}`);
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
      if (device && list?.some((b) => b.deviceId === device)) {
        if (list.find((b) => b.inUse)?.deviceId === device) return 'panel';
        // The user's Background choice is what allows this selection.
        await this.chromeCall(q, 'select_browser', { deviceId: device }, until, signal);
        if ((await this.chromeBrowsers(q, until, signal)).find((b) => b.inUse)?.deviceId === device) return 'panel';
        throw new Error(CHROME_ELSEWHERE);
      }
      if (Date.now() + 1000 > connectBy) {
        if (!list) throw new Error(`Could not check which browser Claude in Chrome uses: ${message(err)}`);
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
}
