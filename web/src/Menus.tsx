import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { beginSetting, currentSummary, patchMcpList, patchSummary, setDefaults, setMcpAuth, settingReq, useStore, type McpAuth } from './store.ts';
import { send } from './socket.ts';
import { Check, Chev, reduceMotion } from './bits.tsx';
import { Led } from './led.tsx';
import { isNarrow, useFoldChips } from './narrow.ts';
import { useSetup, useClaudeReady, loadCodexModels } from './setup.ts';
import {
  CODEX_EFFORTS, EFFORTS, providerOf, type ClientMessage, type CodexModel, type Effort, type McpGroup, type McpPhase, type McpRow, type Mode, type Provider, type SessionSummary, type Settings,
} from '../../server/protocol.ts';

// Names map to the SDK's PermissionMode.
export const PM: [Mode, string, string][] = [
  ['default', 'Ask', 'Asks before edits and commands'],
  ['acceptEdits', 'Accept edits', 'Edits go through, commands ask'],
  ['plan', 'Plan', 'Reads and plans, changes nothing'],
  ['auto', 'Auto', 'A classifier decides each call'],
  ['bypassPermissions', 'Bypass', 'Runs everything without asking'],
];
export const M: [string, string, string][] = [
  ['claude-opus-5-5', 'Opus 5.5', 'Complex, multi-step work'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'Everyday coding'],
  ['claude-haiku-5-5', 'Haiku 5.5', 'Quick reads and searches'],
  ['claude-fable-5-1', 'Fable 5.1', 'Small, precise edits'],
];
export const E: Record<Effort, string> = {
  low: 'Quick answers', medium: 'Balanced', high: 'Thinks it through', xhigh: 'Very thorough, slower', max: 'Everything it has', ultra: 'Deepest, hands parts to helper agents',
};

// The current session's settings, or the ones the next new session starts with.
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const summary = useStore(currentSummary);
  const defaults = useStore((s) => s.defaults);
  const settings: Settings = summary ? { mode: summary.mode, model: summary.model, effort: summary.effort } : defaults;
  const apply = (patch: Partial<Settings>) => {
    // Read fresh state: two calls in one tick must not both start from the same render.
    const live = currentSummary(useStore.getState());
    if (!live) return setDefaults(patch);
    const next = { mode: live.mode, model: live.model, effort: live.effort, ...patch };
    // Shown only once it went out; the server's answer confirms it or puts the old value back.
    const go = (sent: Partial<Settings>, msg: (req: string) => ClientMessage) => {
      const req = settingReq();
      if (send(msg(req))) beginSetting(live.id, req, sent);
      else useStore.setState({ notice: 'Not connected', noticeInfo: false });
    };
    if (patch.mode) go({ mode: next.mode }, (req) => ({ type: 'set-mode', sessionId: live.id, mode: next.mode, req }));
    if (patch.model || patch.effort) {
      go({ model: next.model, effort: next.effort }, (req) => ({ type: 'set-model', sessionId: live.id, model: next.model, effort: next.effort, req }));
    }
  };
  return [settings, apply];
}

// True while a change to these fields of the current session waits for the server.
function usePending(fields: (keyof Settings)[]) {
  return useStore((s) => !!s.current && !!s.settingsPending[s.current]?.some((p) => fields.some((f) => p.patch[f] !== undefined)));
}

// Shift+Tab never lands on Auto or Bypass; those take a click. From either, it goes back to Ask.
const CYCLE: Mode[] = ['default', 'acceptEdits', 'plan'];
export const nextMode = (m: Mode) => CYCLE[(CYCLE.indexOf(m) + 1) % CYCLE.length];

// Popovers sit above their button, right-aligned to it.
function usePopover(popId: string) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const pop = popRef.current!;
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      const r = btnRef.current!.getBoundingClientRect();
      pop.style.right = Math.max(12, innerWidth - r.right) + 'px';
      pop.style.bottom = innerHeight - r.top + 10 + 'px';
      // A short narrow window has little room above the chip; the menu scrolls instead of leaving the top edge.
      pop.style.maxHeight = isNarrow() ? r.top - 22 + 'px' : '';
    };
    pop.addEventListener('beforetoggle', onToggle);
    return () => pop.removeEventListener('beforetoggle', onToggle);
  }, [popId]);
  return { btnRef, popRef, open };
}

// A pick blinks the highlight once; returns false while a blink is running.
function blink(list: HTMLElement, done: () => void) {
  if (list.classList.contains('busy')) return false;
  const fast = reduceMotion();
  list.classList.add('busy', 'blink');
  setTimeout(() => list.classList.remove('blink'), fast ? 0 : 90);
  setTimeout(() => {
    list.classList.remove('busy');
    done();
  }, fast ? 0 : 190);
  return true;
}

export function ModeMenu() {
  const [settings, apply] = useSettings();
  const { btnRef, popRef, open } = usePopover('modePop');
  const listRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Mode | null>(null);
  const checked = picked ?? settings.mode;
  const name = PM.find((x) => x[0] === settings.mode)![1];
  const pending = usePending(['mode']);

  const pick = (k: Mode) => {
    const ok = blink(listRef.current!, () => {
      apply({ mode: k });
      setPicked(null);
      popRef.current!.hidePopover();
    });
    if (ok) setPicked(k);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = +e.key;
    if (k >= 1 && k <= PM.length) pick(PM[k - 1][0]);
  };

  return (
    <>
      <button
        type="button" ref={btnRef} className={`seg${settings.mode === 'bypassPermissions' ? ' risk' : ''}${pending ? ' pending' : ''}`} popoverTarget="modePop"
        aria-haspopup="menu" aria-expanded={open} aria-busy={pending || undefined} aria-label={`Permission mode: ${name}`}
      >
        <span className="md">{name}</span><Chev />
      </button>
      <div className="pop mpop" id="modePop" popover="auto" ref={popRef} aria-label="Permission mode" onKeyDown={onKeyDown}>
        <div className="pg"><span>Permissions</span><span><kbd>⇧⇥</kbd> cycles</span></div>
        <div className="mlist" ref={listRef}>
          <div role="menu">
            {PM.map(([k, n, d], i) => (
              <button key={k} className="mi" role="menuitemradio" aria-checked={k === checked} onClick={() => pick(k)}>
                <span className="nm2">{n}</span><small>{d}</small>
                <span className="side"><span className="ck"><Check /></span><kbd>{i + 1}</kbd></span>
              </button>
            ))}
          </div>
          <i className="hl"></i>
        </div>
      </div>
    </>
  );
}

type ModelItem = { id: string; name: string; desc: string; provider: Provider; efforts: Effort[]; defaultEffort: Effort };
const CLAUDE_ITEMS: ModelItem[] = M.map(([id, name, desc]) => ({ id, name, desc, provider: 'claude', efforts: EFFORTS, defaultEffort: 'high' }));
const GROUP: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

function codexItems(models: CodexModel[] | null): ModelItem[] {
  return (models ?? []).map((m) => {
    const efforts = CODEX_EFFORTS.filter((e) => m.efforts.includes(e));
    const def = efforts.includes(m.defaultEffort as Effort) ? (m.defaultEffort as Effort) : efforts[0] ?? 'medium';
    return { id: m.id, name: m.name, desc: oneLineDesc(m.description), provider: 'codex', efforts: efforts.length ? efforts : ['medium'], defaultEffort: def };
  });
}
const oneLineDesc = (s: string) => (s.length > 60 ? `${s.slice(0, 57).replace(/\s+\S*$/, '')}…` : s);

export function ModelMenu() {
  const [settings, apply] = useSettings();
  const summary = useStore(currentSummary);
  const codexStatus = useSetup((s) => s.codex);
  const codexModels = useSetup((s) => s.codexModels);
  const codexError = useSetup((s) => s.codexModelsError);
  const { btnRef, popRef, open } = usePopover('modelPop');
  const listRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  // The catalog loads on the first open; it boots Codex's app-server, so never on page load.
  const wantCodex = codexStatus?.installed !== false && codexStatus?.signedIn !== false;
  // One request per open; reopening after an error clears it and tries again.
  const asked = useRef(false);
  useEffect(() => {
    if (!open) asked.current = false;
    if (!open || asked.current || codexModels || !wantCodex) return;
    asked.current = true;
    if (codexError) useSetup.setState({ codexModelsError: null });
    loadCodexModels();
  }, [open, codexModels, codexError, wantCodex]);
  const codex = codexItems(codexModels);
  // Signed out of Claude, its models stay out of the menu like Codex's do.
  const claudeOk = useClaudeReady();
  const claude = claudeOk ? CLAUDE_ITEMS : [];
  const all = [...claude, ...codex];
  const provider: Provider = summary?.provider ?? providerOf(settings.model);
  // A tab with messages keeps its provider; a model of the other one opens a new tab with a handoff of this one.
  const locked = !!summary && !summary.fresh;
  const usable = (m: ModelItem) => !locked || m.provider === provider;
  const current = [...CLAUDE_ITEMS, ...codex].find((x) => x.id === settings.model);
  const efforts = current?.efforts ?? (provider === 'codex' ? CODEX_EFFORTS : EFFORTS);
  const checked = picked ?? settings.model;
  const eff = Math.max(0, efforts.indexOf(settings.effort));
  const hintAt = Math.min(preview ?? eff, efforts.length - 1);
  const label = current?.name ?? settings.model;
  const keyed = all.filter(usable);
  const pending = usePending(['model', 'effort']);

  // The menu stays open after a model pick so effort can be set right after.
  const pick = (m: ModelItem) => {
    if (!usable(m)) {
      if (!summary) return;
      const effort = m.efforts.includes(settings.effort) ? settings.effort : m.provider === 'claude' && settings.effort === 'ultra' ? 'max' : m.defaultEffort;
      send({ type: 'switch-provider', sessionId: summary.id, model: m.id, effort });
      popRef.current?.hidePopover();
      return;
    }
    const ok = blink(listRef.current!, () => {
      apply({ model: m.id, ...(m.efforts.includes(settings.effort) ? {} : { effort: m.provider === 'claude' && settings.effort === 'ultra' ? 'max' : m.defaultEffort }) });
      setPicked(null);
      itemsRef.current!.querySelector<HTMLElement>(`[data-m="${m.id}"]`)?.focus({ preventScroll: true });
    });
    if (ok) setPicked(m.id);
  };
  const setEffort = (i: number) => apply({ effort: efforts[Math.max(0, Math.min(efforts.length - 1, i))] });
  const onKeyDown = (e: KeyboardEvent) => {
    const k = +e.key;
    if (k >= 1 && k <= keyed.length) {
      itemsRef.current!.querySelector<HTMLElement>(`[data-m="${keyed[k - 1].id}"]`)?.focus();
      pick(keyed[k - 1]);
    }
  };
  const groups: [Provider, ModelItem[]][] = [['claude', claude], ['codex', codex]];
  // Without codex installed the group stays out of the menu.
  const codexNote = codexStatus?.installed === false || (codexError && codexStatus?.signedIn !== false) ? null
    : codexStatus?.signedIn === false ? 'Sign in to Codex in Settings › Account to use it'
    : !codexModels ? 'Loading Codex models…' : null;
  const onBarsKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    setEffort(eff + (e.key === 'ArrowRight' ? 1 : -1));
  };

  return (
    <>
      <button type="button" ref={btnRef} className={`seg${pending ? ' pending' : ''}`} popoverTarget="modelPop" aria-haspopup="menu" aria-expanded={open} aria-busy={pending || undefined}>
        <span className="md">{label}</span><span>·</span><span>{settings.effort}</span><Chev />
      </button>
      <div className="pop mpop" id="modelPop" popover="auto" ref={popRef} aria-label="Model and effort" onKeyDown={onKeyDown}>
        <div className="mlist" ref={listRef}>
          <div role="menu" ref={itemsRef}>
            {groups.map(([p, items]) => {
              const other = locked && p !== provider;
              const note = p === 'codex' ? codexNote : claudeOk ? null : 'Sign in to Claude in Settings › Account to use it';
              if (!items.length && !note) return null;
              return (
                <div key={p} role="group" aria-label={GROUP[p]} className="mgroup">
                  <div className="pg" role="presentation"><span>{GROUP[p]}</span>{other && <span>Opens a new tab with a handoff</span>}</div>
                  {items.map((m) => {
                    const k = keyed.indexOf(m);
                    return (
                      <button
                        key={m.id} className="mi" role={other ? 'menuitem' : 'menuitemradio'} aria-checked={other ? undefined : m.id === checked} data-m={m.id}
                        onClick={() => pick(m)}
                      >
                        <span className="nm2">{m.name}</span><small>{m.desc}</small>
                        <span className="side"><span className="ck"><Check /></span>{k >= 0 && k < 9 && <kbd>{k + 1}</kbd>}</span>
                      </button>
                    );
                  })}
                  {note && <p className="mnote">{note}</p>}
                </div>
              );
            })}
          </div>
          <i className="hl"></i>
        </div>
        <div className="sep"></div>
        <div className="effh"><b style={{ fontWeight: 400 }}>Effort</b><span>{efforts[hintAt]} · {E[efforts[hintAt]]}</span></div>
        <div
          className={`bars${preview !== null ? ' pv' : ''}`} role="slider" tabIndex={0} aria-label="Effort" aria-valuemin={1} aria-valuemax={efforts.length}
          aria-valuenow={eff + 1} aria-valuetext={settings.effort} onKeyDown={onBarsKey} onMouseLeave={() => setPreview(null)}
          style={{ gridTemplateColumns: `repeat(${efforts.length},1fr)` }}
        >
          {efforts.map((e, i) => (
            <button
              key={e} tabIndex={-1} aria-label={e} className={`${i <= eff ? 'on' : ''}${preview !== null && i <= preview ? ' pvon' : ''}`}
              onClick={() => setEffort(i)} onMouseOver={() => setPreview(i)}
            >
              <i style={{ height: 8 + Math.round((i * 20) / Math.max(1, efforts.length - 1)) }}></i>
            </button>
          ))}
        </div>
        <div className="effn"><span>faster</span><span>deeper</span></div>
      </div>
    </>
  );
}

// Under 900px these chips fold behind one button; wider windows render the set as display: contents, so nothing moves.
export function MoreTools({ children }: { children: ReactNode }) {
  const { btnRef, popRef, open } = usePopover('moreTools');
  // Widening past the breakpoint puts the chips back inline, so an open set must close first.
  const folded = useFoldChips();
  useEffect(() => {
    if (!folded && popRef.current?.matches(':popover-open')) popRef.current.hidePopover();
  }, [folded]);
  return (
    <>
      <button
        type="button" ref={btnRef} className="seg more-btn" popoverTarget="moreTools" aria-expanded={open}
        aria-label="Model and usage" title="Model and usage"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h.01M7 7h.01M11 7h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
      </button>
      <div className="more-set" id="moreTools" popover="auto" ref={popRef} role="group" aria-label="Model and usage">{children}</div>
    </>
  );
}

// Built-in packs get a blurb; files in ~/.claude/mcp show their name only.
const MCP_INFO: Record<string, string> = {
  'claude-in-chrome': 'Your Chrome: browse, click, read pages',
  'playwright (panel)': 'Playwright on the Browser panel',
  'devtools (panel)': 'Chrome DevTools on the Browser panel',
};
const MCP_GROUPS: [McpGroup, string][] = [['pack', 'Optional'], ['user', 'Your servers'], ['project', 'Project'], ['claudeai', 'claude.ai'], ['plugin', 'Plugins'], ['other', 'Other']];
// Chrome is a CLI flag, so unlike the other packs it needs a restart.
const CHROME = 'claude-in-chrome';
const CONNECTORS_URL = 'https://claude.ai/customize/connectors';
const GROUP_NAME = Object.fromEntries(MCP_GROUPS) as Record<McpGroup, string>;

// "claude.ai Gmail" reads "Gmail" under claude.ai; "plugin:figma:figma" reads "figma".
function mcpLabel(r: McpRow) {
  if (r.group === 'claudeai') return r.key.replace(/^claude\.ai /, '');
  const [tag, plugin, server] = r.key.split(':');
  if (r.group === 'plugin' && tag === 'plugin' && plugin && server) return plugin === server ? plugin : `${plugin} · ${server}`;
  return r.key;
}

const isBad = (r: McpRow) => r.state === 'failed' || (r.group === 'pack' && r.state === 'needs-auth');

function mcpCount(rows: McpRow[]) {
  const on = rows.filter((r) => r.on && !r.locked && r.group !== 'builtin');
  return { on: on.length, bad: on.some(isBad) };
}

const restarts = (r: McpRow) => r.group !== 'pack' || r.key === CHROME;

// What a row says at a glance: a mark and a short word on the right, and a line under the name only when something needs attention.
type Mark = 'ok' | 'wait' | 'warn' | 'bad' | 'done' | null;
type RowView = { mark: Mark; word: string; sub?: string; tone?: 'warn' | 'bad' };

function mcpView(r: McpRow, live: boolean, phase: McpPhase | undefined, applying: boolean, auth: McpAuth | undefined, flash: string | undefined): RowView {
  if (flash) return { mark: 'done', word: flash };
  if (r.needs) return { mark: null, word: 'Paused', sub: r.needs };
  if (r.state === 'disabled') return { mark: null, word: 'Off in /mcp', sub: 'Turned off in Claude Code for this folder' };
  if (r.pending || (applying && phase)) return { mark: 'wait', word: phase === 'waiting' ? 'After this reply' : phase ? 'Restarting' : 'Applying' };
  if (auth && r.on) {
    if (auth.step === 'opening') return { mark: 'wait', word: 'Opening', sub: 'Asking for the sign-in page' };
    if (auth.step === 'checking') return { mark: 'wait', word: 'Checking', sub: 'Looking for your sign-in' };
    if (auth.error) return { mark: 'warn', word: '', sub: auth.error, tone: 'bad' };
    return auth.manual ? { mark: 'wait', word: '', sub: 'Finish in the new tab, then come back' } : { mark: 'wait', word: 'Waiting', sub: 'Finish in the new tab; this updates itself' };
  }
  if (!r.on || !live) return { mark: null, word: '' };
  switch (r.state) {
    case 'connected': return { mark: 'ok', word: r.tools ? `${r.tools} ${r.tools === 1 ? 'tool' : 'tools'}` : 'Connected' };
    case 'pending': return { mark: 'wait', word: 'Connecting' };
    case 'needs-auth': return { mark: 'warn', word: '', sub: 'Needs sign-in', tone: 'warn' };
    case 'failed': return { mark: 'bad', word: 'Failed', sub: r.error, tone: 'bad' };
  }
  return { mark: null, word: 'Not loaded' };
}

// Opened inside the click so popup blockers allow it, then pointed at the sign-in page once the server answers.
const authTabs = new Map<string, Window>();
const tabKey = (sid: string, server: string) => `${sid}\n${server}`;

// Every MCP server of this session; packs switch live, the rest restart the session's Claude Code. The menu stays open for several toggles.
export function McpMenu() {
  const summary = useStore(currentSummary);
  // Mounted only with a session, so the popover hook always finds its element. An older server without mcpCount lists packs only.
  return summary && summary.caps?.mcpMenu !== false && (summary.mcpCount || summary.mcp?.length) ? <McpPop summary={summary} /> : null;
}

function McpPop({ summary }: { summary: SessionSummary }) {
  const { btnRef, popRef, open } = usePopover('mcpPop');
  const list = useStore((s) => s.mcpLists[summary.id]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    send({ type: 'mcp-status', sessionId: summary.id });
    if (!isNarrow()) searchRef.current?.focus({ preventScroll: true });
  }, [open, summary.id]);
  const rows: McpRow[] = list?.servers ?? summary.mcp.map((p) => ({ ...p, group: 'pack' }));
  const count = summary.mcpCount ?? mcpCount(rows);
  const live = list?.live ?? false;
  const phase = list?.phase;
  const auth = list?.auth;
  const servers = list?.servers;

  // Short "Applied" / "Signed in" marks after a change lands, by row key; '' is the footer.
  const [flash, setFlash] = useState<Record<string, { word: string; at: number }>>({});
  // Rows whose change waits for a restart; kept through the restart, when the list has no live states.
  const [applying, setApplying] = useState<string[]>([]);
  const prevRows = useRef(new Map<string, McpRow>());
  const prevPhase = useRef<McpPhase | undefined>(undefined);
  useEffect(() => {
    const now = servers ?? [];
    const pend = now.filter((r) => r.pending).map((r) => r.key);
    const all = [...new Set([...applying, ...pend])];
    const add: Record<string, { word: string; at: number }> = {};
    const at = Date.now();
    for (const r of now) {
      const p = prevRows.current.get(r.key);
      if (p?.state === 'needs-auth' && r.state === 'connected') add[r.key] = { word: 'Signed in', at };
    }
    prevRows.current = new Map(now.map((r) => [r.key, r]));
    const was = prevPhase.current;
    prevPhase.current = phase;
    if (!phase && live) {
      for (const k of all) if (!pend.includes(k)) add[k] = { word: 'Applied', at };
      if (was === 'restarting' || was === 'waiting') add[''] = { word: 'Applied', at };
      if (all.length !== pend.length) setApplying(pend);
    } else if (all.length !== applying.length) setApplying(all);
    if (Object.keys(add).length) setFlash((f) => ({ ...f, ...add }));
  }, [servers, phase, live, applying]);
  useEffect(() => {
    if (!Object.keys(flash).length) return;
    const t = setTimeout(() => setFlash((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => Date.now() - v.at < 2400))), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  // Points the tab opened on click at the sign-in page, or closes it when there is nothing to open.
  useEffect(() => {
    for (const [k, tab] of authTabs) {
      const [sid, server] = k.split('\n');
      if (sid !== summary.id) continue;
      const a = auth?.[server];
      if (a?.step === 'opening') continue;
      authTabs.delete(k);
      if (a?.url && !tab.closed) {
        tab.opener = null;
        tab.location.href = a.url;
      } else tab.close();
    }
  }, [auth, summary.id]);

  const check = (server: string) => {
    setMcpAuth(summary.id, server, { ...auth?.[server], step: 'checking', error: undefined });
    send({ type: 'mcp-reconnect', sessionId: summary.id, server });
  };
  // claude.ai connectors finish on claude.ai; coming back to this tab checks them.
  const manual = Object.entries(auth ?? {}).filter(([, a]) => a.step === 'waiting' && a.manual && !a.error).map(([k]) => k).join('\n');
  useEffect(() => {
    if (!manual) return;
    const onFocus = () => {
      for (const k of manual.split('\n')) {
        setMcpAuth(summary.id, k, { ...useStore.getState().mcpLists[summary.id]?.auth?.[k], step: 'checking', error: undefined });
        send({ type: 'mcp-reconnect', sessionId: summary.id, server: k });
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [manual, summary.id]);

  const signIn = (row: McpRow) => {
    const tab = window.open('', '_blank');
    if (tab) {
      tab.document.title = 'Signing in…';
      tab.document.body.textContent = `Opening the sign-in page for ${mcpLabel(row)}…`;
      authTabs.set(tabKey(summary.id, row.key), tab);
    }
    setMcpAuth(summary.id, row.key, { step: 'opening' });
    send({ type: 'mcp-auth', sessionId: summary.id, server: row.key });
  };

  const toggle = (row: McpRow) => {
    if (row.locked) return;
    const pending = live && restarts(row) && !row.pending;
    // Set here, not from the list: the server's restart can land before the optimistic row renders.
    if (pending && !applying.includes(row.key)) setApplying([...applying, row.key]);
    const next =rows.map((r) => (r === row ? { key: r.key, group: r.group, on: !r.on, ...(pending ? { pending: true as const } : {}) } : r));
    const packs = next.filter((r) => r.group === 'pack');
    patchMcpList(summary.id, { servers: next });
    patchSummary(summary.id, { mcp: packs.map(({ key, on, state, error }) => ({ key, on, ...(state && state !== 'disabled' ? { state } : {}), ...(error ? { error } : {}) })), mcpCount: mcpCount(next) });
    const servers = Object.fromEntries(next.filter((r) => r.group !== 'pack' && !r.locked && r.group !== 'builtin').map((r) => [r.key, r.on]));
    send({ type: 'set-mcp', sessionId: summary.id, keys: packs.filter((r) => r.on).map((r) => r.key), servers });
  };
  // Boots this session's Claude Code without a message, so connectors, plugins and live states show up.
  const start = () => {
    patchMcpList(summary.id, { phase: 'starting', error: undefined });
    send({ type: 'warm', sessionId: summary.id });
  };

  const q = query.trim().toLowerCase();
  const match = (r: McpRow) => !q || [r.key, GROUP_NAME[r.group] ?? ''].some((s) => s.toLowerCase().includes(q));
  const shown = rows.filter((r) => r.group !== 'builtin' && match(r));
  const builtins = rows.filter((r) => r.group === 'builtin');

  return (
    <>
      <button type="button" ref={btnRef} className={`seg${count.bad ? ' risk' : ''}`} popoverTarget="mcpPop" aria-haspopup="menu" aria-expanded={open}>
        <span className="md">MCP</span>{count.on > 0 && <span>· {count.on}</span>}<Chev />
      </button>
      <div className="pop mpop" id="mcpPop" popover="auto" ref={popRef} aria-label="MCP servers">
        <div className="pg"><span>MCP servers</span><span>This session</span></div>
        <p className="mcp-hint">Choices stay with this session. New sessions start with optional packs off and the rest on.</p>
        <div className="mcp-sbox">
          <input
            ref={searchRef} className="mcp-search" placeholder="Search by name or source" aria-label="Search MCP servers" value={query}
            autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {query && (
            <button type="button" className="mcp-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
        <div className="mcp-scroll" role="group" aria-label="Servers">
          {MCP_GROUPS.map(([g, label]) => {
            const items = shown.filter((r) => r.group === g);
            // Says what a click does before it happens; with no Claude Code running a toggle only saves.
            const note = g === 'pack' ? 'switch live' : live || phase ? 'restarts Claude Code · chat kept' : '';
            return items.length ? (
              <Fragment key={g}>
                <div className="mcp-gh" role="presentation"><span>{label}</span>{note && <span>{note}</span>}</div>
                {items.map((r) => (
                  <McpItem
                    key={r.key} row={r} onToggle={toggle} onSignIn={signIn} onCheck={check}
                    view={mcpView(r, live, phase, applying.includes(r.key), auth?.[r.key], flash[r.key]?.word)} auth={auth?.[r.key]}
                  />
                ))}
              </Fragment>
            ) : null;
          })}
          {!shown.length && <div className="mcp-empty">{q ? `No server matches “${query.trim()}”` : 'No servers'}</div>}
        </div>
        {list && <McpFoot live={live} phase={phase} error={list.error} done={!!flash['']} onStart={start} />}
        {builtins.length > 0 && (
          <div className="mcp-built" title="The app needs these, so they stay on">Built-in, always on: {builtins.map((b) => b.key).join(', ')}</div>
        )}
      </div>
    </>
  );
}

// The status line under the list: why states are missing, what Claude Code is doing, or that a change landed.
function McpFoot({ live, phase, error, done, onStart }: { live: boolean; phase?: McpPhase; error?: string; done: boolean; onStart: () => void }) {
  if (phase) {
    const text = phase === 'waiting' ? 'Your change applies when this reply ends. Claude Code restarts then; the chat continues.'
      : phase === 'restarting' ? 'Restarting Claude Code to apply your change. The chat continues.' : 'Starting Claude Code…';
    return <div className="mcp-foot" role="status"><span className="mcp-mk"><Led size="sm" pattern="calm" /></span><span>{text}</span></div>;
  }
  if (error) {
    return (
      <div className="mcp-foot bad" role="alert">
        <span title={error}>Claude Code didn't start: {error}</span>
        <button type="button" onClick={onStart}>Try again</button>
      </div>
    );
  }
  if (done) return <div className="mcp-foot ok" role="status"><span className="mcp-mk"><Check /></span><span>Applied. Same conversation, fresh Claude Code.</span></div>;
  if (live) return null;
  return (
    <div className="mcp-foot">
      <span>Claude Code isn't running here yet, so connections are unchecked.</span>
      <button type="button" onClick={onStart}>Check now</button>
    </div>
  );
}

const MARK: Record<Exclude<Mark, null>, ReactNode> = {
  ok: <i className="mcp-dot ok" />, warn: <i className="mcp-dot warn" />, bad: <i className="mcp-dot bad" />,
  done: <span className="mcp-done"><Check /></span>, wait: <Led size="sm" pattern="calm" />,
};

type ItemProps = {
  row: McpRow; view: RowView; auth?: McpAuth;
  onToggle: (r: McpRow) => void; onSignIn: (r: McpRow) => void; onCheck: (server: string) => void;
};

// The whole row toggles for a big mouse target; the switch is the control keyboards and screen readers use.
function McpItem({ row, view, auth, onToggle, onSignIn, onCheck }: ItemProps) {
  const id = useId();
  const stop = (e: MouseEvent) => e.stopPropagation();
  const needsAuth = row.on && row.state === 'needs-auth' && !row.pending;
  let action: ReactNode = null;
  if (needsAuth && (!auth || auth.error)) action = <button type="button" className="mcp-act" onClick={(e) => { stop(e); onSignIn(row); }}>{auth ? 'Try again' : 'Sign in'}</button>;
  else if (needsAuth && auth?.step === 'waiting' && auth.manual) action = <button type="button" className="mcp-act" onClick={(e) => { stop(e); onCheck(row.key); }}>Check</button>;
  // The tab may have been blocked, and claude.ai keeps its own connector settings.
  const link = needsAuth && auth?.step === 'waiting' && auth.url ? <a href={auth.url} target="_blank" rel="noopener noreferrer" onClick={stop}>Reopen</a>
    : needsAuth && auth?.error && row.group === 'claudeai' ? <a href={CONNECTORS_URL} target="_blank" rel="noopener noreferrer" onClick={stop}>Connect on claude.ai</a> : null;
  return (
    <div className={`mcp-row${row.locked ? ' locked' : ''}`} onClick={() => onToggle(row)} title={row.error}>
      <span className="mcp-nm"><span id={id}>{mcpLabel(row)}</span>{MCP_INFO[row.key] && <span className="mcp-inf" title={MCP_INFO[row.key]}>{MCP_INFO[row.key]}</span>}</span>
      <span className="mcp-st">
        {view.mark && <span className="mcp-mk">{MARK[view.mark]}</span>}
        {view.word && <span className={`mcp-w${view.mark === 'done' ? ' ok' : ''}`}>{view.word}</span>}
        {action}
      </span>
      <button
        type="button" role="switch" className="mcp-sw" aria-checked={row.on} aria-labelledby={id} disabled={row.locked}
        onClick={(e) => { stop(e); onToggle(row); }}
      >
        <i></i>
      </button>
      {(view.sub || link) && (
        <small className={`mcp-sub${view.tone ? ` ${view.tone}` : ''}`}>{view.sub}{view.sub && link ? ' · ' : ''}{link}</small>
      )}
    </div>
  );
}
