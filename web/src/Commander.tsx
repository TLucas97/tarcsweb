import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { PROVIDER_LABEL, type CmdrAgents, type CmdrAnswerBy, type CmdrRef, type CmdrSide, type CommanderLogEntry, type PinnedAsk, type RelayFrom, type SessionSummary } from '../../server/protocol.ts';
import { M } from './Menus.tsx';
import { openText } from './Focus.tsx';
import { Source, folderTabs, pickAgent, useStore, type Item } from './store.ts';
import { openSession, send } from './socket.ts';
import { Check, Chev, ProviderTag, PowerIcon, baseName, pref, useEscape } from './bits.tsx';
import { turnOffCommander } from './actions.ts';
import { setNoticeSlot, useLayoutVars } from './layoutVars.ts';
import { useCmdrWide } from './narrow.ts';
import { FolderIcon, needsYou, subLabel } from './DockFolders.tsx';
import { SessionTile } from './sessionColor.tsx';
import { Flap } from './flap.tsx';
import { answerAsk, useAnswering } from './answering.ts';
import { DiffFrame } from './Tools.tsx';

// The commander tab's own parts: the counters bar with the session list, the pinned asks and the notes in its conversation.
// It loads with the commander's tab, and in a main session once a sub-session's card or ask reaches it.

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// How long to wait for a session's tab before an agent pick for it is dropped.
const AGENT_PICK_MS = 10_000;

// A session named in the commander; a click goes to its tab, and a closed one says so.
type Named = Pick<CmdrRef, 'sessionId' | 'name'>;
function goSession(r: Named) {
  if (useStore.getState().roster.some((x) => x.id === r.sessionId)) openSession(r.sessionId);
  else useStore.setState({ notice: `${r.name} is closed`, noticeInfo: true });
}
// The agent view lives in the session's own tab, so the pick waits until that tab is on screen.
function goAgent(sessionId: string, id: string) {
  openSession(sessionId);
  const timer = setTimeout(() => off(), AGENT_PICK_MS);
  const off = useStore.subscribe((s) => {
    if (s.current !== sessionId) return;
    off();
    clearTimeout(timer);
    requestAnimationFrame(() => pickAgent(sessionId, id));
  });
}
type AgentBrief = CmdrAgents['agents'][number];
const isLive = (a: AgentBrief) => a.state === 'running' || a.state === 'waiting';
function AgentButton({ a, session, onGo }: { a: AgentBrief; session: Named; onGo?: () => void }) {
  return (
    <button type="button" className="cmd-ag" data-state={a.state} title={`Open ${a.name} in ${session.name}`} onClick={() => { onGo?.(); goAgent(session.sessionId, a.id); }}>
      <i aria-hidden="true"></i>
      <span className="cmd-ag-nm" dir="auto">{a.name}</span>
      <small>{a.state}</small>
    </button>
  );
}
function SessionLink({ r }: { r: Named }) {
  return <button type="button" className="cmd-sn" title={`Go to ${r.name}`} onClick={() => goSession(r)}><b dir="auto">{r.name}</b></button>;
}

// Another session's card in the commander's or its main's conversation: a strip naming that session, then the card, which answers there.
export function RelayedCard({ id, from, gone, children }: { id: string; from: RelayFrom; gone: boolean; children: ReactNode }) {
  return (
    <div className="cmd-relay" data-id={id}>
      <div className="cmd-relay-h">
        <button type="button" title={`Go to ${from.name} · ${from.cwd}`} onClick={() => goSession(from)}><b dir="auto">{from.name}</b> · {baseName(from.cwd)}</button>
        {gone && <span>No longer waiting</span>}
      </div>
      <Source.Provider value={from.sessionId}><div className="cmd-relay-b" inert={gone}>{children}</div></Source.Provider>
    </div>
  );
}

// Lower ranks lead: waiting on the user, then failed or cut off, working, finished, idle.
const rankOf = (r: SessionSummary) => (needsYou(r) ? 0 : r.failed || r.interrupted ? 1 : r.state === 'working' ? 2 : r.state === 'done' ? 3 : 4);

type Entry = { row: SessionSummary; kids: SessionSummary[]; rank: number };
type Block = { cwd: string; entries: Entry[]; count: number; rank: number };

const ListRow = memo(function ListRow({ r, agents, wait, onGo }: { r: SessionSummary; agents?: CmdrAgents; wait?: string; onGo: () => void }) {
  const [open, setOpen] = useState(false);
  const need = needsYou(r);
  const bad = !need && (r.failed || r.interrupted);
  const tone = need ? 'needs' : bad ? undefined : r.state === 'done' ? 'done' : undefined;
  const doing = !need && r.state === 'working';
  const line = need ? (wait ?? 'Waiting for you') : r.interrupted ? 'Interrupted by a server restart' : r.failed ? 'Its last turn failed'
    : doing ? r.activity || 'Thinking' : (r.lastReply ?? '').replace(/\s+/g, ' ').trim();
  const live = agents?.live ?? 0;
  return (
    <>
      <div className="dp-row cmd-row" data-tone={tone}>
        <button type="button" className="dp-main" title={`Go to ${r.name}`} onClick={() => { onGo(); openSession(r.id); }}>
          <SessionTile id={r.id} state={r.state} needsYou={r.needsYou} background={r.background} />
          <span className="dp-l1">
            <span className="dp-nm" dir="auto">{r.name}</span>
            <ProviderTag p={r.provider} />
            <span className={`dp-st${tone ? ` ${tone}` : ''}${bad ? ' cmd-bad' : ''}`}>{r.interrupted && !need ? 'interrupted' : bad ? 'failed' : subLabel(r)}</span>
          </span>
          {line && <span className={`dp-l3${doing ? ' doing' : ''}`} dir="auto" title={line}>{line}</span>}
        </button>
        {agents && (
          <button
            type="button" className="cmd-xp" aria-expanded={open} onClick={() => setOpen(!open)}
            aria-label={`${open ? 'Hide' : 'Show'} the subagents of ${r.name}`} title={open ? 'Hide subagents' : 'Show subagents'}
          >
            {live ? `${live} running` : `${agents.agents.length + agents.more} agents`}<Chev />
          </button>
        )}
      </div>
      {open && agents && (
        <div className="cmd-ags" role="group" aria-label={`Subagents of ${r.name}`}>
          {agents.agents.map((a) => <AgentButton key={a.id} a={a} session={{ sessionId: r.id, name: r.name }} onGo={onGo} />)}
          {agents.more > 0 && <span className="cmd-ag-more">{agents.more} more in its agents panel</span>}
        </div>
      )}
    </>
  );
});

// Every other session by folder, sub-sessions under their main, the ones that need the user first.
function SessionList({ tabs, onGo }: { tabs: SessionSummary[]; onGo: () => void }) {
  const agentRows = useStore((s) => (s.current ? s.maps[s.current]?.cmdr?.agents : undefined));
  const asks = useStore((s) => (s.current ? s.maps[s.current]?.cmdr?.asks : undefined));
  // A row with tasks only has no subagents to list here.
  const agents = useMemo(() => new Map((agentRows ?? []).filter((a) => a.agents.length).map((a) => [a.id, a])), [agentRows]);
  // A waiting session's line names its oldest pinned ask.
  const waits = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of asks ?? []) if (!m.has(p.ask.sessionId)) m.set(p.ask.sessionId, `${p.ask.tool} · ${p.ask.command ?? p.ask.summary}`.replace(/\s+/g, ' '));
    return m;
  }, [asks]);
  const blocks = useMemo(() => {
    const ids = new Set(tabs.map((r) => r.id));
    const sub = (r: SessionSummary) => !!r.group && r.group.mainId !== r.id && ids.has(r.group.mainId);
    const kids = new Map<string, SessionSummary[]>();
    for (const r of tabs) if (sub(r)) kids.set(r.group!.mainId, [...(kids.get(r.group!.mainId) ?? []), r]);
    const out = new Map<string, Block>();
    for (const r of tabs) {
      if (sub(r)) continue;
      const ks = (kids.get(r.id) ?? []).sort((a, b) => rankOf(a) - rankOf(b));
      const rank = Math.min(rankOf(r), ...ks.map(rankOf));
      const cwd = r.worktreeRepo ?? r.cwd;
      let b = out.get(cwd);
      if (!b) out.set(cwd, (b = { cwd, entries: [], count: 0, rank }));
      b.entries.push({ row: r, kids: ks, rank });
      b.count += 1 + ks.length;
      b.rank = Math.min(b.rank, rank);
    }
    const list = [...out.values()];
    for (const b of list) b.entries.sort((x, y) => x.rank - y.rank);
    return list.sort((x, y) => x.rank - y.rank);
  }, [tabs]);
  const row = (r: SessionSummary) => <ListRow key={r.id} r={r} agents={agents.get(r.id)} wait={waits.get(r.id)} onGo={onGo} />;
  return (
    <div className="cmd-list" id="cmd-list" role="group" aria-label="Sessions">
      {blocks.length ? blocks.map((b) => (
        <div key={b.cwd} className="dp-folder">
          <div className="cmd-fh" title={b.cwd}>
            <FolderIcon />
            <span className="dp-folder-name">{baseName(b.cwd)}</span>
            <span className="dp-folder-count">{b.count}</span>
          </div>
          <div className="dp-folder-rows">
            {b.entries.map((e) => (
              <Fragment key={e.row.id}>
                {row(e.row)}
                {e.kids.length > 0 && <div className="dp-tree" role="group" aria-label={`Sub-sessions of ${e.row.name}`}>{e.kids.map(row)}</div>}
              </Fragment>
            ))}
          </div>
        </div>
      )) : <p className="cmd-empty">No other session is open.</p>}
    </div>
  );
}

// The server owns the switch and starts it off; a click shows its new state until the server's next value arrives,
// which then wins, also when another window flipped it.
function AutoSwitch() {
  const on = useStore((s) => (s.current ? s.maps[s.current]?.cmdrAuto === true : false));
  const [want, setWant] = useState<boolean | null>(null);
  const [seen, setSeen] = useState(on);
  if (seen !== on) {
    setSeen(on);
    setWant(null);
  }
  const shown = want ?? on;
  const flip = () => {
    if (send({ type: 'commander-auto', on: !shown })) setWant(!shown);
    else useStore.setState({ notice: 'Not connected', noticeInfo: false });
  };
  return (
    <label className="sk-sw cmd-auto" title="The commander answers permission asks from other sessions for you. Asks the app's checker cannot clear wait for you. Turns off when the app restarts.">
      <button type="button" role="switch" className="set-sw" aria-checked={shown} aria-label="Auto-approve" onClick={flip}><i /></button>
      <span className="cmd-w">Auto-approve</span>
    </label>
  );
}

// Under this width the header bar's notice slot cannot hold a notice card.
const NOTICE_ROOM = 320;
// The slot's CSS box changes size whenever it moves (vw edges, 1px taller under the player), so the observer sees every move. Hidden (under 1024px) it has no box.
function watchSlot(el: HTMLElement | null) {
  if (!el) return;
  const ro = new ResizeObserver(([e]) => {
    const r = e.target.getBoundingClientRect();
    setNoticeSlot(r.height ? { left: Math.round(r.left), right: Math.round(document.documentElement.clientWidth - r.right), top: Math.round(r.top), tight: r.width < NOTICE_ROOM } : null);
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    setNoticeSlot(null);
  };
}

// In the commander's title row: counts over every other session; a click opens the full list.
export default function CommanderBar() {
  const tabs = useStore(folderTabs);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const n = useMemo(() => {
    const c = { working: 0, need: 0, done: 0, failed: 0 };
    for (const r of tabs) {
      if (needsYou(r)) c.need++;
      else if (r.failed || r.interrupted) c.failed++;
      else if (r.state === 'working') c.working++;
      else if (r.state === 'done') c.done++;
    }
    return c;
  }, [tabs]);
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const counts: [keyof typeof n, string, string][] = [
    ['working', 'working', 'Sessions with a turn running'],
    ['need', n.need === 1 ? 'needs you' : 'need you', 'Sessions waiting on you'],
    ['done', 'finished', 'Sessions that finished a turn you have not seen'],
    ['failed', 'failed', 'Sessions whose last turn failed or was interrupted'],
  ];
  return (
    <div className="cmd-bar" ref={ref}>
      <button
        type="button" className="cmd-counts" aria-expanded={open} aria-controls="cmd-list"
        aria-label={`${tabs.length} other sessions: ${counts.map(([k, word]) => `${n[k]} ${word}`).join(', ')}`} title={open ? 'Hide the session list' : 'Show every session'}
        onClick={() => setOpen(!open)}
      >
        {counts.map(([k, word, hint]) => (
          <span key={k} className="cmd-c" data-k={k} data-zero={n[k] ? undefined : ''} title={`${n[k]} ${word} · ${hint}`}><i aria-hidden="true"></i>{n[k]}<span className="cmd-w">{word}</span></span>
        ))}
        <Chev />
      </button>
      {open && <SessionList tabs={tabs} onGo={() => setOpen(false)} />}
      {/* From 1024px this is the row under the bar's centred group, where the notices (.hin) go. */}
      <span className="cmd-slot" ref={watchSlot} aria-hidden="true"></span>
      <div className="cmd-end">
        <AutoSwitch />
        <button type="button" className="cmd-off" title="Turn off the Commander" onClick={turnOffCommander}><PowerIcon /><span className="cmd-w">Turn off</span></button>
      </div>
    </div>
  );
}

// An open session with something going, and what the commander's map holds of its plan and subagents.
export type WorkRow = { r: SessionSummary; w: CmdrAgents };

// On the commander's tab, the part of the side card's Tasks or Agents tab under the commander's own: the other sessions
// with a step list, or with subagents running, one group each.
export function CommanderWork({ tab, rows }: { tab: 'tasks' | 'agents'; rows: WorkRow[] }) {
  const byAgents = tab === 'agents';
  const shown = rows.filter((x) => (byAgents ? x.w.live > 0 : !!x.w.tasks));
  const live = shown.reduce((n, x) => n + x.w.live, 0);
  const done = shown.reduce((n, x) => n + (x.w.tasks?.done ?? 0), 0);
  const total = shown.reduce((n, x) => n + (x.w.tasks?.total ?? 0), 0);
  return (
    <div className="cmd-others" role="group" aria-label="Other sessions">
      <div className="pr-h"><span>Other sessions</span>{shown.length > 0 && <span>{byAgents ? <Flap text={`${live} running`} /> : `${done} of ${total}`}</span>}</div>
      <div className="cmd-ol">
        {shown.length ? shown.map(({ r, w }) => {
          const t = byAgents ? undefined : w.tasks;
          const agents = w.agents.filter(isLive);
          const more = t ? t.total - t.steps.length : 0;
          return (
            <div key={r.id} className={`wk-g cmd-wg${byAgents || r.state === 'working' ? ' live' : ''}`}>
              <button type="button" className="wk-gh" title={`Go to ${r.name} · ${r.cwd}`} onClick={() => openSession(r.id)}>
                <SessionTile id={r.id} state={r.state} needsYou={r.needsYou} background={r.background} />
                <b dir="auto">{r.name}</b>
                <ProviderTag p={r.provider} />
                <span className="wk-gc">{t ? `${t.done} of ${t.total}` : subLabel(r)}</span>
              </button>
              {t && (
                <ol className="wk-steps">
                  {t.steps.length ? t.steps.map((st, i) => (
                    <li key={i} className={st.status}><i><Check /></i><span dir="auto">{st.text}</span></li>
                  )) : <li className="done"><i><Check /></i><span>All tasks done</span></li>}
                </ol>
              )}
              {t && t.steps.length > 0 && more > 0 && <p className="wk-more">+{more} more</p>}
              {byAgents && (
                <div className="cmd-ags" role="group" aria-label={`Running subagents of ${r.name}`}>
                  {agents.map((a) => <AgentButton key={a.id} a={a} session={{ sessionId: r.id, name: r.name }} />)}
                  {w.live > agents.length && (
                    <button type="button" className="cmd-ag cmd-ag-more" title={`Go to ${r.name}`} onClick={() => openSession(r.id)}>+{w.live - agents.length} more</button>
                  )}
                </div>
              )}
            </div>
          );
        }) : byAgents ? <div className="empty">No agent is running in another session.</div> : <p className="wk-empty">No other session has a task list.</p>}
      </div>
    </div>
  );
}

// Under auto-approve, the pin's state line; the user's Allow and Deny keep working in every state.
const autoLine = (p: PinnedAsk) =>
  p.auto === 'reviewing' ? 'Commander is reviewing' : p.auto === 'queued' ? 'Waiting for the commander' : p.auto === 'held' ? p.why
    : p.auto === 'left' ? `Commander left this to you: ${p.why}` : null;

// One plain permission waiting in another session; Allow and Deny answer it there, Ask commander asks for a recommendation.
// group: the pin sits in a main session's tab, which has no commander to ask and no auto-approve.
const Pin = memo(function Pin({ p, group }: { p: PinnedAsk; group?: boolean }) {
  const { ask } = p;
  const sent = useAnswering((s) => !!s.ids[ask.id]);
  const [asked, setAsked] = useState(false);
  const [diff, setDiff] = useState(false);
  const what = ask.command ?? ask.summary;
  // With the commander, the pin steps back from the coral "needs you" look.
  const busy = !group && (p.auto === 'queued' || p.auto === 'reviewing');
  const line = group ? null : autoLine(p);
  const consult = () => {
    if (send({ type: 'commander-consult', sessionId: ask.sessionId, id: ask.id })) setAsked(true);
    else useStore.setState({ notice: 'Not connected', noticeInfo: false });
  };
  return (
    <div className={`hub tq cmd-pin${busy ? '' : ' need'}`} data-auto={p.auto}>
      <i className="d"></i>
      <span className="tx" title={`${p.name} · ${p.cwd}\n${ask.tool}: ${what}`}>
        <span className="tq-w"><SessionLink r={{ sessionId: ask.sessionId, name: p.name }} /> · {baseName(p.cwd)}{ask.title ? ` · ${ask.title}` : ''}</span>
        <b>{ask.tool}</b> <span className="mono">{what}</span>
      </span>
      {ask.detail && <button className="hu-act" aria-expanded={diff} onClick={() => setDiff(!diff)}>{diff ? 'Hide' : 'Diff'}</button>}
      {!busy && !group && <button className="hu-act" disabled={asked} title="Ask the commander for a recommendation; you still decide" onClick={consult}>{asked ? 'Asked' : 'Ask commander'}</button>}
      <button className="hu-act" disabled={sent} data-robot-react="tense" onClick={() => answerAsk(ask.sessionId, ask.id, false)}>Deny</button>
      <button className="hu-act allow" disabled={sent} data-robot-react="happy" onClick={() => answerAsk(ask.sessionId, ask.id, true)}>Allow</button>
      {line && <span className="cmd-why" title={line}>{line}</span>}
      {diff && ask.detail && <div className="tq-d"><DiffFrame d={ask.detail} state={null} /></div>}
    </div>
  );
});

// Above the message box until answered; a long stack scrolls inside its own capped height.
function Pins({ asks, where, group }: { asks: PinnedAsk[]; where: string; group?: boolean }) {
  return (
    <div className="cmd-pins" role="region" aria-label={`Asks waiting in ${where}`}>
      {asks.length > 1 && <div className="cmd-pins-h">{asks.length} asks waiting in {where}</div>}
      {asks.map((p) => <Pin key={p.id} p={p} group={group} />)}
    </div>
  );
}

export function CommanderPins() {
  const asks = useStore((s) => (s.current ? s.maps[s.current]?.cmdr?.asks : undefined));
  return asks?.length ? <Pins asks={asks} where="other sessions" /> : null;
}

// A main session's tab: the plain permissions waiting in its sub-sessions.
export function GroupPins() {
  const asks = useStore((s) => (s.current ? s.maps[s.current]?.groupAsks : undefined));
  return asks?.length ? <Pins asks={asks} where="sub-sessions" group /> : null;
}

const WROTE = { commander: 'Commander', app: 'App' } as const;
// Newest first; each entry is one line saying when, whether it is still open, who wrote it and about which session, then its text.
const logText = (entries: CommanderLogEntry[]) => entries.toReversed().map((e) => {
  const day = new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `**${day} ${clock(e.at)}**${e.open ? ' · Open' : ''} · ${WROTE[e.by]}${e.sessionName ? ` · ${e.sessionName}` : ''}  \n${e.text}`;
}).join('\n\n');

// The title menu's request opens the reader when the answer lands, growing out of the menu's button.
let logFrom: Element | null = null;
export function readCommanderLog(from: Element) {
  if (!send({ type: 'commander-log-read' })) return void useStore.setState({ notice: 'Not connected', noticeInfo: false });
  logFrom = from;
}
useStore.subscribe((s, prev) => {
  const got = s.commanderLog;
  if (!logFrom || !got || got === prev.commanderLog) return;
  const from = logFrom;
  logFrom = null;
  useStore.setState({ commanderLog: null });
  openText({ paste: logText(got) || 'Nothing has been recorded yet.', md: true, label: 'Commander log' }, from);
});

// A done group with a "turn ended" row: work may remain in those sessions, so it is not titled finished.
const ENDED = 'sessions ended a turn';
const GROUP = { ask: 'sessions are waiting for you', failed: 'sessions failed or were interrupted', done: 'sessions finished' } as const;
// allow is null when the phone answered and the decision is not known here.
const answerText = (by: CmdrAnswerBy, allow: boolean | null) =>
  by === 'cancelled' ? 'No longer waiting:' : by === 'commander' ? (allow ? 'Commander allowed' : 'Commander denied') : allow === null ? 'Answered on your phone:' : by === 'phone' ? (allow ? 'Allowed on your phone:' : 'Denied on your phone:') : allow ? 'You allowed' : 'You denied';

// Claude models show their menu name; a Codex one shows its id, since its catalog may not be loaded.
const sideName = (s: CmdrSide) => `${PROVIDER_LABEL[s.provider]} ${M.find(([id]) => id === s.model)?.[1] ?? s.model}`;

// A note the app drew about other sessions; a run of one kind shows as one line that opens into the list.
// card: the row sits in the Activity card, which leads with the time.
export function CmdrNoteRow({ item, card }: { item: Extract<Item, { kind: 'cmdr' }>; card?: boolean }) {
  const [open, setOpen] = useState(false);
  const n = item.note;
  const time = item.at ? <time className="mono" dateTime={new Date(item.at).toISOString()}>{clock(item.at)}</time> : null;
  if (n.kind === 'answered') {
    return (
      <div className="upd cmd-note" data-id={item.id} data-k={n.by === 'cancelled' || n.allow === null ? 'cancelled' : n.allow ? 'allowed' : 'denied'}>
        {card && time}
        <span className="upd-dot" aria-hidden="true"></span>
        <span className="upd-t">
          {answerText(n.by, n.allow)} {n.tool} in <SessionLink r={n.ref} /> · <span className="mono" title={n.command}>{n.command}</span>{n.reason && <> — {n.reason}</>}
        </span>
        {!card && time}
      </div>
    );
  }
  if (n.kind === 'handoff') {
    return (
      <div className="cmd-handoff" data-id={item.id} role="separator" aria-label={`Context handoff from ${sideName(n.from)} to ${sideName(n.to)}`}>
        <span>Context handoff · <b>{sideName(n.from)}</b> → <b>{sideName(n.to)}</b></span>
        {time}
      </div>
    );
  }
  // One line per session and text: the same session ending twice is not two sessions.
  const rows: { r: CmdrRef; n: number }[] = [];
  for (const r of n.refs) {
    const same = rows.find((x) => x.r.sessionId === r.sessionId && x.r.text === r.text);
    if (same) same.n++;
    else rows.push({ r, n: 1 });
  }
  const times = (k: number) => (k > 1 ? ` ${k}×` : '');
  if (rows.length === 1) {
    return (
      <div className="upd cmd-note" data-id={item.id} data-k={n.kind}>
        {card && time}
        <span className="upd-dot" aria-hidden="true"></span>
        <span className="upd-t"><SessionLink r={rows[0].r} /> {rows[0].r.text}{times(rows[0].n)}</span>
        {!card && time}
      </div>
    );
  }
  return (
    <div className="upd cmd-note cmd-group" data-id={item.id} data-k={n.kind}>
      {card && time}
      <button type="button" className="cmd-gh" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="upd-dot" aria-hidden="true"></span>
        <span className="upd-t">{new Set(rows.map((x) => x.r.sessionId)).size} {n.kind === 'done' && rows.some((x) => x.r.text !== 'finished') ? ENDED : GROUP[n.kind]}</span>
        <Chev />
      </button>
      {!card && time}
      {open && (
        <ul className="cmd-refs">
          {rows.map((x, i) => <li key={i}><SessionLink r={x.r} /> {x.r.text}{times(x.n)}</li>)}
        </ul>
      )}
    </div>
  );
}

const ACT_MIN_KEY = 'cmdr.activity.min';
const ActivityIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 7h2.6l1.7-4 2.4 8 1.7-4h2.6" /></svg>
);

const ActivityRow = memo(function ActivityRow({ id }: { id: string }) {
  const item = useStore((s) => s.items[id]);
  return item?.kind === 'cmdr' ? <CmdrNoteRow item={item} card /> : null;
});

// The Activity card: the notes about other sessions, newest first, in the Work card's shell on the left. From 1552px it
// docks beside the chat and its minimized state is saved; under that it is a pill that opens it as a sheet.
export function CommanderActivity() {
  const notes = useStore((s) => s.notes);
  const loading = useStore((s) => s.loading);
  const docked = useCmdrWide();
  const [saved, setSaved] = useState(() => pref.get<boolean>(ACT_MIN_KEY, false));
  const [sheet, setSheet] = useState(false);
  if (docked && sheet) setSheet(false);
  const min = docked ? saved : !sheet;
  const rows = useMemo(() => notes.toReversed(), [notes]);
  // The pill counts notes newer than the last one seen: the newest while the card was open, or when a backlog landed.
  const last = notes[notes.length - 1] ?? null;
  const [mark, setMark] = useState({ seen: last, loading });
  if (mark.loading !== loading || (!min && mark.seen !== last)) setMark({ seen: !min || mark.loading ? last : mark.seen, loading });
  const fresh = min && mark.seen !== last ? notes.length - 1 - (mark.seen ? notes.lastIndexOf(mark.seen) : -1) : 0;
  const cardRef = useRef<HTMLElement>(null);
  const miniRef = useRef<HTMLButtonElement>(null);
  const cardEl = useLayoutVars(cardRef);
  const put = (to: boolean) => {
    if (!docked) return setSheet(!to);
    pref.set(ACT_MIN_KEY, to);
    setSaved(to);
  };
  // Focus follows the control that replaced the one clicked.
  const close = () => {
    flushSync(() => put(true));
    miniRef.current?.focus({ preventScroll: true });
  };
  const open = () => {
    flushSync(() => put(false));
    cardRef.current?.querySelector<HTMLElement>('.sc-fold')?.focus({ preventScroll: true });
  };
  useEscape(!docked && sheet, close);
  return (
    <>
      <aside ref={cardEl} className={`acard${min ? ' tucked' : ''}`} aria-label="Activity in other sessions" inert={min}>
        <div className="sc-head ac-head">
          <b>Activity</b>
          <button className="min sc-fold" aria-label="Minimize the activity panel" title="Minimize" onClick={close}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          </button>
        </div>
        <div className="wk-body">
          <div className="wk-scroll wk-tasks ac-list">
            {rows.length ? rows.map((id) => <ActivityRow key={id} id={id} />) : <p className="wk-empty">Nothing has happened in other sessions yet.</p>}
          </div>
        </div>
      </aside>
      <div className={`scrim ac-scrim${!docked && sheet ? ' on' : ''}`} aria-hidden="true" onClick={close} />
      <button
        ref={miniRef} type="button" className={`ac-mini${min ? ' on' : ''}`} inert={!min}
        aria-label={fresh ? `Open the activity panel, ${fresh} new` : 'Open the activity panel'} title="Activity in other sessions" onClick={open}
      >
        <ActivityIcon />
        <b>Activity</b>
        {fresh > 0 && <em>{fresh} new</em>}
      </button>
    </>
  );
}
