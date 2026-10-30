import type { McpServerConfig, Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpAuthReply, McpGroup, McpPack, McpPhase, McpRow, ServerEvent, ServerMessage } from '../protocol.ts';
import { MODS, browserOf, catalog, defaultOn, groupOf, isPanelPack, mcpPacks, packOf, rememberSeen, saveChoices, saveMcp, savedChoices, seenServers, serversFor, toolServerOf, type Catalog, type PanelTool } from '../mcp.ts';
import { oneLine } from '../text.ts';
import { saveSettings } from '../settings.ts';

// Claude in Chrome, offered in the MCP menu but started with the CLI's --chrome flag (no extra process).
export const CHROME = 'claude-in-chrome';
const LIVE_MAX = 200;
// How long a sign-in started from the MCP menu keeps the CLI alive and its state polled.
const AUTH_WAIT_MS = 5 * 60_000;

export type McpHost = {
  id: string;
  cwd: string;
  q: () => Query | null;
  // A flag change (Chrome) waits for the turn to end before the CLI restarts.
  stale: () => boolean;
  markStale: () => void;
  busy: () => boolean;
  restartCli: () => Promise<void>;
  // Whether a changed browser subagent restarted the CLI now.
  restartForAgent: () => Promise<boolean>;
  holdBrowser: () => void;
  syncBrowserNote: () => void;
  appMcp: () => McpServerConfig | null;
  armIdle: () => void;
  toast: (text: string) => void;
  push: (e: ServerEvent) => void;
  onChange: () => void;
};

// The session's MCP menu: the packs and servers it loads, their live states and sign-ins.
export class McpMenu {
  private host: McpHost;
  // Optional MCP sets this session loads, and what their servers last reported.
  packs: string[];
  private state: Record<string, Pick<McpPack, 'state' | 'error'>> = {};
  // Settings-loaded servers (user, folder, claude.ai, plugins) this session switched away from defaultOn.
  private choices: Record<string, boolean>;
  // The running CLI's own server list; null while no CLI runs. Capped at LIVE_MAX.
  live: { name: string; status: string; source?: string; error?: string; tools?: number }[] | null = null;
  // From the last list: servers whose reported definition runs a panel package, by the server part of their tool names.
  // Plugin servers are known only here; kept across CLI restarts, since a definition rarely changes.
  liveBrowsers: Record<string, PanelTool> = {};
  private catalog: Catalog | null = null;
  private rows: McpRow[] = [];
  private json = '';
  private listeners = new Set<(json: string) => void>();
  count = { on: 0, bad: false };
  // What the running CLI was started with, so the menu can mark choices it does not have yet.
  private cliOff = new Set<string>();
  private cliPacks = new Set<string>();
  cliChrome = false;
  // A restart for MCP changes until the new CLI reports its servers; the last boot failure for the menu.
  restarting = false;
  error: string | null = null;
  // Sign-ins started from the menu, until the server connects or the wait runs out.
  private authUntil = new Map<string, number>();
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: McpHost, packs: string[], choices?: Record<string, boolean>) {
    this.host = host;
    this.packs = packs;
    this.choices = choices ? { ...choices } : savedChoices(host.id);
    if (choices) {
      saveMcp(host.id, packs);
      saveChoices(host.id, this.choices);
    }
    void this.loadCatalog();
  }

  // Each pack with its last state, for the session list.
  summary() {
    return [...mcpPacks().map((p) => p.key), CHROME].map((key) => ({ key, on: this.packs.includes(key), ...(this.packs.includes(key) ? this.state[key] : {}) }));
  }

  // What a new CLI starts with.
  cliStarted() {
    this.cliPacks = new Set(this.packs);
    this.cliOff = new Set(this.off());
    this.cliChrome = this.packs.includes(CHROME);
    this.error = null;
  }

  subscribe(fn: (json: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // The menu for a client that opened it; a running CLI's fresh states follow through subscribe.
  async menu() {
    await this.loadCatalog();
    return this.json;
  }

  private async loadCatalog() {
    try {
      this.catalog = await catalog(this.host.cwd);
    } catch {}
    this.changed();
  }

  // Every server the session has or can load: packs, config files, the running CLI's list, connectors and plugins seen before, built-ins.
  private buildRows(): McpRow[] {
    const q = this.host.q();
    const live = new Map(this.live?.map((s) => [s.name, s]));
    const rows: McpRow[] = [...mcpPacks().map((p) => p.key), CHROME].map((key) => ({ key, group: 'pack', on: this.packs.includes(key), ...(this.packs.includes(key) ? this.state[key] : {}) }));
    const added = new Set<string>();
    const add = (name: string, group: McpGroup) => {
      if (group === 'pack' || added.has(name)) return;
      added.add(name);
      const s = live.get(name);
      const state = s && { state: s.status as McpRow['state'], ...(s.error ? { error: oneLine(s.error, 200) } : {}), ...(s.tools !== undefined ? { tools: s.tools } : {}) };
      if (group === 'builtin') return void rows.push({ key: name, group, on: true, locked: true, ...state });
      // Switched off with /mcp in Claude Code: saved for the whole folder, so this menu leaves it alone.
      if (s ? s.status === 'disabled' : this.catalog?.disabled.includes(name)) return void rows.push({ key: name, group, on: false, locked: true, state: 'disabled' });
      const on = this.choices[name] ?? defaultOn(name);
      const pending = q && this.cliOff.has(name) === on;
      rows.push({ key: name, group, on, ...(on && !pending ? state : {}), ...(pending ? { pending: true as const } : {}) });
    };
    for (const s of this.live ?? []) add(s.name, s.name === CHROME ? 'pack' : groupOf(s.name, s.source));
    for (const n of this.catalog?.user ?? []) add(n, packOf(n) ? 'pack' : 'user');
    for (const n of this.catalog?.project ?? []) add(n, packOf(n) ? 'pack' : 'project');
    for (const [n, g] of Object.entries(seenServers())) add(n, g);
    for (const n of Object.keys(this.choices)) add(n, groupOf(n));
    for (const n of ['app', ...MODS]) add(n, 'builtin');
    // Chrome is a CLI flag, so its pack also waits for a restart.
    const chrome = rows.find((r) => r.key === CHROME);
    if (chrome && q && chrome.on !== this.cliChrome) Object.assign(chrome, { pending: true, state: undefined, error: undefined });
    for (const r of rows) {
      const states = r.group === 'pack'
        ? [...live.values()].filter((s) => (s.name === CHROME ? CHROME : packOf(s.name)) === r.key).map((s) => s.status)
        : [live.get(r.key)?.status];
      r.active = !!q && !r.needs && states.length > 0 && states.every((s) => s === 'connected')
        && (r.group === 'pack' ? this.cliPacks.has(r.key) : !this.cliOff.has(r.key));
      if (q && r.group === 'pack' && r.on !== this.cliPacks.has(r.key)) r.pending = true;
    }
    // Packs keep their file order; the rest by name, so a toggle does not move a row.
    const packs = rows.filter((r) => r.group === 'pack');
    return [...packs, ...rows.filter((r) => r.group !== 'pack').sort((a, b) => a.key.localeCompare(b.key))];
  }

  // Clients showing the menu get the new list once; the roster only when the chip's count moved.
  changed() {
    const rows = this.buildRows();
    const phase: McpPhase | undefined = this.host.stale() ? 'waiting' : this.restarting ? 'restarting' : this.host.q() && !this.live ? 'starting' : undefined;
    const ev: ServerMessage = { type: 'mcp', sessionId: this.host.id, servers: rows, live: !!this.live, ...(phase ? { phase } : {}), ...(this.error ? { error: this.error } : {}) };
    const json = JSON.stringify(ev);
    if (json === this.json) return;
    this.rows = rows;
    this.json = json;
    const on = rows.filter((r) => r.on && !r.locked && r.group !== 'builtin');
    const count = { on: on.length, bad: on.some((r) => r.state === 'failed' || (r.group === 'pack' && r.state === 'needs-auth')) };
    const moved = count.on !== this.count.on || count.bad !== this.count.bad;
    this.count = count;
    for (const fn of this.listeners) fn(json);
    if (moved) this.host.onChange();
  }

  // Settings-loaded servers to deny when the CLI starts. Per session on purpose: toggleMcpServer saves its change for the whole folder.
  off() {
    const names = new Set([...this.rows.filter((r) => r.group !== 'pack' && !r.locked).map((r) => r.key), ...Object.keys(this.choices)]);
    return [...names].filter((n) => !(this.choices[n] ?? defaultOn(n))).sort();
  }

  // Apply one batch. Busy sessions defer packs too; older clients may omit servers.
  async set(keys: string[], servers?: Record<string, boolean>, keepDefault = false) {
    const known = [...mcpPacks().map((p) => p.key), CHROME];
    const hadChrome = this.packs.includes(CHROME);
    const wasOff = this.off().join('\n');
    const wasPacks = this.packs.join('\n');
    if (keepDefault) {
      const error = await saveSettings({ mcpDefaults: { keys: known.filter((k) => keys.includes(k)), servers: servers ?? { ...this.choices } } });
      if (error) {
        this.error = error;
        this.changed();
        return;
      }
      this.host.toast('MCP default saved for new sessions');
    }
    this.error = null;
    this.packs = known.filter((k) => keys.includes(k));
    saveMcp(this.host.id, this.packs);
    this.state = Object.fromEntries(Object.entries(this.state).filter(([k]) => this.packs.includes(k)));
    if (servers) {
      const fixed = new Set(this.rows.filter((r) => r.locked).map((r) => r.key));
      const kept = Object.entries(servers).filter(([n, on]) => !fixed.has(n) && n !== CHROME && !packOf(n) && on !== defaultOn(n));
      this.choices = Object.fromEntries(kept.slice(0, LIVE_MAX));
      saveChoices(this.host.id, this.choices);
    }
    this.changed();
    this.host.onChange();
    if (this.host.q() && this.host.busy() && (this.host.stale() || wasPacks !== this.packs.join('\n') || wasOff !== this.off().join('\n'))) {
      this.host.markStale();
      this.changed();
      return;
    }
    this.host.holdBrowser();
    this.host.syncBrowserNote();
    // Chrome is a CLI flag and a denied server cannot come back live: both need a fresh CLI, now or once the turn ends.
    if ((hadChrome !== this.packs.includes(CHROME) || wasOff !== this.off().join('\n')) && this.host.q()) {
      if (!this.host.busy()) return void (await this.host.restartCli());
      this.host.markStale();
      this.changed();
    } else if (await this.host.restartForAgent()) return;
    const q = this.host.q();
    const app = this.host.appMcp();
    if (!q || !app) return;
    try {
      const res = await q.setMcpServers({ app, ...serversFor(this.packs) });
      this.cliPacks = new Set(this.packs);
      for (const [name, error] of Object.entries(res.errors)) {
        const k = packOf(name);
        if (k) this.state[k] = { state: 'failed', error };
        this.host.toast(`${k ?? name} did not connect: ${oneLine(error, 90)}`);
      }
    } catch (err) {
      this.host.push({ type: 'error', message: `MCP change failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    await this.refresh();
  }

  // The owner flipped the agents switch: the menu, the prompt note and a running CLI's panel packs follow.
  async syncBrowserAgents() {
    this.changed();
    this.host.holdBrowser();
    this.host.syncBrowserNote();
    if (await this.host.restartForAgent()) return;
    const q = this.host.q();
    const app = this.host.appMcp();
    if (!q || !app || !this.packs.some(isPanelPack)) return;
    try {
      await q.setMcpServers({ app, ...serversFor(this.packs) });
    } catch (err) {
      this.host.push({ type: 'error', message: `MCP change failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    await this.refresh();
  }

  async refresh() {
    const q = this.host.q();
    if (!q) return;
    const rank = ['connected', 'pending', 'needs-auth', 'failed'] as const;
    try {
      const list = (await q.mcpServerStatus()).slice(0, LIVE_MAX);
      if (this.host.q() !== q) return;
      const next: typeof this.state = {};
      for (const s of list) {
        const k = s.name === CHROME ? CHROME : packOf(s.name);
        if (!k || !this.packs.includes(k)) continue;
        const state = s.status === 'disabled' ? 'failed' : s.status;
        const cur = next[k]?.state;
        if (!cur || rank.indexOf(state) > rank.indexOf(cur)) next[k] = { state, ...(s.error ? { error: s.error } : {}) };
      }
      const packsMoved = JSON.stringify(next) !== JSON.stringify(this.state);
      this.state = next;
      this.live = list.map((s) => ({
        name: s.name, status: s.status, source: s.source ?? s.scope, ...(s.error ? { error: s.error } : {}), ...(s.tools ? { tools: s.tools.length } : {}),
      }));
      this.liveBrowsers = Object.fromEntries(list.flatMap((s) => {
        const tool = browserOf(s.config);
        return tool ? [[toolServerOf(s.name), tool] as const] : [];
      }));
      const shared = this.live.map((s) => [s.name, groupOf(s.name, s.source)] as [string, McpGroup]).filter(([, g]) => g === 'claudeai' || g === 'plugin');
      rememberSeen(shared, new Set(this.off()));
      this.restarting = false;
      for (const s of list) if (s.status === 'connected' || s.status === 'failed') this.authUntil.delete(s.name);
      this.changed();
      if (packsMoved) this.host.onChange();
    } catch {}
  }

  // Servers start as pending: ask at once, then every 1.5 s while one still connects (about 20 s at most).
  poll(q: Query, left = 14) {
    void this.refresh().then(() => {
      if (this.host.q() !== q || left <= 0) return;
      if (!this.live || this.live.some((s) => s.status === 'pending')) setTimeout(() => this.poll(q, left - 1), 1500);
    });
  }

  // Starts a server's sign-in. mcpAuthenticate is on the SDK's Query class but not in its types yet.
  async auth(name: string): Promise<McpAuthReply> {
    const q = this.host.q() as (Query & { mcpAuthenticate?: (server: string) => Promise<{ authUrl?: string; callbackExpected?: boolean } | undefined> }) | null;
    if (!q) return { error: "Claude Code isn't running for this session" };
    if (typeof q.mcpAuthenticate !== 'function') return { error: "This Claude Code version can't sign in from here" };
    try {
      const r = await q.mcpAuthenticate(name);
      const url = r?.authUrl && /^https?:\/\//.test(r.authUrl) ? r.authUrl : undefined;
      if (!url) {
        await this.refresh();
        return {};
      }
      // OAuth servers call back to the CLI, which reconnects them itself; keep it alive and watch for that.
      this.authUntil.set(name, Date.now() + AUTH_WAIT_MS);
      this.watchAuth(q);
      return { url, ...(r?.callbackExpected ? {} : { manual: true as const }) };
    } catch (err) {
      return { error: oneLine(err instanceof Error ? err.message : String(err), 200) };
    }
  }

  // claude.ai connectors finish on claude.ai, so the CLI only sees the sign-in after a reconnect.
  async reconnect(name: string): Promise<McpAuthReply> {
    const q = this.host.q();
    if (!q) return { checked: true, error: "Claude Code isn't running for this session" };
    try {
      await q.reconnectMcpServer(name);
    } catch {}
    await this.refresh();
    return { checked: true };
  }

  private watchAuth(q: Query) {
    if (this.authTimer) return;
    const tick = () => {
      this.authTimer = null;
      const now = Date.now();
      for (const [n, until] of this.authUntil) if (until < now) this.authUntil.delete(n);
      if (this.host.q() !== q || !this.authUntil.size) return;
      this.host.armIdle();
      void this.refresh().finally(() => {
        if (this.host.q() === q && this.authUntil.size) this.authTimer = setTimeout(tick, 3000);
      });
    };
    this.authTimer = setTimeout(tick, 3000);
  }

  // Without a CLI the menu falls back to config files and unknown states.
  gone() {
    this.live = null;
    this.changed();
  }
}
