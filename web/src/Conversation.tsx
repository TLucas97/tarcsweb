import { Activity, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentSummary, onSent, useStore, type Item, type Tldr } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { DiffFrame, ToolGroup } from './Tools.tsx';
import { Rich } from './Rich.tsx';
import { UserBody } from './Composer.tsx';
import { CopyBtn, reduceMotion } from './bits.tsx';
import { isLite } from './perf.ts';
import { ListenBtn } from './Voice.tsx';
import { PhoneIcon } from './Remote.tsx';
import { HeroRobot } from './robotHero.tsx';
import { Working } from './Working.tsx';
import { HandoffCard, NoteCard } from './HandoffCard.tsx';
import { handoffLive, parseAgentNote, parseNote } from './handoff.ts';
import { dropOutgoing, resent, useOutbox, type Outgoing } from './outbox.ts';
import { fillComposer } from './PluginBand.tsx';
import { PlanCard, QuestionCard } from './Ask.tsx';
import { unqueue } from './actions.ts';
import { FindBar } from './Find.tsx';
import { bindInlineRelease } from './InlineRead.tsx';
import { ChangeStrip } from './Changes.tsx';
import { useLayoutVars } from './layoutVars.ts';
import { Start } from './Start.tsx';
import { Flap } from './flap.tsx';
import { SwitchFx } from './switchFx.tsx';
import { isWatching, useWatching } from './watch/open.ts';
import { afterFrames, bindWindow, isLoadingOlder, loadOlder, showRow } from './convWindow.ts';
import type { Wake } from '../../server/protocol.ts';
import { shownReply } from './stretch/compose.ts';
import { openOf } from './stretch/store.ts';

function PermissionCard({ item }: { item: Extract<Item, { kind: 'permission' }> }) {
  if (item.questions) return <QuestionCard item={item} />;
  if (item.plan !== undefined) return <PlanCard item={item} />;
  return <AllowCard item={item} />;
}

// Cells per character, so a very long command flips only what the card can show.
const FLIP_MAX = 200;

// The command flips in once; it starts blank so the first render has something to flip from.
function FlipIn({ text }: { text: string }) {
  const [shown, setShown] = useState('');
  useEffect(() => setShown(text.slice(0, FLIP_MAX)), [text]);
  return <Flap text={shown} className="mono" />;
}

function AllowCard({ item }: { item: Extract<Item, { kind: 'permission' }> }) {
  const current = useStore((s) => s.current);
  const answer = (allow: boolean, always = false) =>
    current && send({ type: 'permission-answer', sessionId: current, id: item.id, allow, ...(always ? { reply: { always: true as const } } : {}) });
  const done = item.answer !== null;
  // Cards already answered when the row mounts (history) stay plain text.
  const [fresh] = useState(!done);
  const outcome = item.elsewhere ? 'Answered on your phone' : item.cancelled ? 'No longer needed' : item.answer ? (item.reply?.always ? 'Allowed for this agent' : 'Allowed') : 'Denied';
  const card = (
    <div className={`ask${done ? ' done' : ''}${item.answer === false && !item.elsewhere && !item.cancelled ? ' denied' : ''}`} data-id={item.detail ? undefined : item.id}>
      {!done && <span className="ask-rail" aria-hidden="true"><i></i><i></i><i></i><i></i></span>}
      <span className="cmd"><b>{item.tool}</b> {fresh ? <FlipIn text={item.summary} /> : <span className="mono">{item.summary}</span>}</span>
      {item.title && <span className="q">{item.title}</span>}
      <span className="sp"></span>
      <span className="opts">
        <button className="opt" onClick={() => answer(false)}><kbd>n</kbd>Deny</button>
        {item.always && <button className="opt" title="Allow this and similar requests for the rest of this agent's session" onClick={() => answer(true, true)}>Always</button>}
        <button className="opt go" onClick={() => answer(true)}>{!item.defaultToNo && <kbd>↵</kbd>}Allow</button>
      </span>
      <span className="ok">{outcome}</span>
    </div>
  );
  if (!item.detail) return card;
  return (
    <div className="askd" data-id={item.id}>
      {card}
      <DiffFrame d={item.detail} state={null} />
    </div>
  );
}

const SENDING_MS = 1000;
const STALLED_MS = 4000;

// Messages on their way to the server. Hidden during a handoff, whose card lists the held ones.
function Outbox() {
  const current = useStore((s) => s.current);
  const handoff = useStore((s) => !!(s.current && handoffLive(s.maps[s.current]?.handoff)));
  const list = useOutbox((s) => s.list);
  if (!current || handoff) return null;
  return list.filter((o) => o.msg.sessionId === current).map((o) => <OutgoingRow key={`${o.msg.id}:${o.at}`} o={o} />);
}

// Shown as sent right away; a label appears only when the wait is long enough to notice.
function OutgoingRow({ o }: { o: Outgoing }) {
  const { msg, failed } = o;
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (failed) return;
    const since = Date.now() - o.at;
    const timers = [SENDING_MS, STALLED_MS].map((ms, i) => setTimeout(() => setStage(i + 1), Math.max(0, ms - since)));
    return () => timers.forEach(clearTimeout);
  }, [o.at, failed]);
  const label = failed ? 'Not sent · the connection dropped' : stage === 2 ? 'Still waiting for the server…' : stage === 1 ? 'Sending…' : null;
  const retry = () => send(msg) && resent(msg.id);
  const edit = () => {
    dropOutgoing(msg.id);
    fillComposer(msg.text);
  };
  return (
    <div className={`mewrap outgoing${label ? ' labeled' : ''}${failed ? ' failed' : ''}`} aria-busy={!failed}>
      {label && (
        <span className="qtag" role="status">
          {label}
          {failed && (
            <span className="qacts">
              <button onClick={retry}>Retry</button>
              {!msg.files?.length && <button onClick={edit}>Edit</button>}
              <button onClick={() => dropOutgoing(msg.id)}>Remove</button>
            </span>
          )}
        </span>
      )}
      <div className="me">
        <UserBody
          text={msg.text} pastes={msg.pastes} links={msg.links}
          files={msg.files?.map((f, i) => ({ name: f.name, kind: f.kind, ...(msg.thumbs?.[i] ? { thumb: msg.thumbs[i]! } : {}) }))}
        />
      </div>
    </div>
  );
}

// A queued message can still be sent now (interrupting the turn), edited or dropped until it is read.
function QueuedTag({ id, text, files }: { id: string; text: string; files: boolean }) {
  const current = useStore((s) => s.current);
  if (!current) return null;
  return (
    <span className="qtag">
      Queued · read at the next step
      <span className="qacts">
        <button onClick={() => unqueue(current, id, 'now')} title="Stop the current step and send this now">Send now</button>
        {!files && <button onClick={() => unqueue(current, id, 'edit', text)} title="Take it back into the message box">Edit</button>}
        <button onClick={() => unqueue(current, id, 'remove')}>Remove</button>
      </span>
    </span>
  );
}

function TldrNote({ t, late }: { t: Tldr; late: boolean }) {
  return (
    <aside className={`tldr${late ? ' in' : ''}`} aria-label="Summary">
      <span className="tl-h"><b>TL;DR</b> · {t.words} words</span>
      <p>{t.text}</p>
    </aside>
  );
}

// Only the newest message of a running turn can still grow.
function AgentReply({ id, text, tldr }: { id: string; text: string; tldr?: Tldr }) {
  const live = useStore((s) => s.status === 'working' && s.order[s.order.length - 1] === id);
  // A summary already there when the row mounted shows without the fade.
  const [hadTldr] = useState(!!tldr);
  return (
    <div className="reply" data-id={id}>
      {tldr && <TldrNote t={tldr} late={!hadTldr} />}
      <Markdown text={text} live={live} id={id} msg={id} />
      {!live && <div className="macts"><CopyBtn text={() => shownReply(text, openOf(id))} /><ListenBtn id={id} text={text} /></div>}
    </div>
  );
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function wokeBy(w: Wake) {
  switch (w.via) {
    case 'agent': return <>report from <b>{w.name}</b></>;
    case 'command': return <>background command <b>{w.name}</b> finished</>;
    case 'monitor': return <>monitor event <b>{w.name}</b></>;
    default: return <b>{w.name}</b>;
  }
}

// The start of a turn the agent opened on its own, so it never reads as part of the reply above.
function UpdateRow({ item }: { item: Extract<Item, { kind: 'update' }> }) {
  const [first, ...rest] = item.from;
  return (
    <div className="upd" data-id={item.id}>
      <span className="upd-dot" aria-hidden="true"></span>
      <span className="upd-t">
        Update · {first ? wokeBy(first) : 'continued on its own'}
        {rest.length > 0 && <span className="upd-more"> +{rest.length} more</span>}
      </span>
      {item.at && <time className="mono" dateTime={new Date(item.at).toISOString()}>{clock(item.at)}</time>}
    </div>
  );
}

// Where the rows that arrived while the reader was elsewhere begin; the time is the first new row's.
function NewMark({ id, leaving }: { id: string; leaving: boolean }) {
  const at = useStore((s) => {
    const it = s.items[id];
    return it && 'at' in it ? it.at : undefined;
  });
  return (
    <div className={`newmark${leaving ? ' out' : ''}`} role="separator">
      <span>New{at ? ` · ${clock(at)}` : ''}</span>
    </div>
  );
}

// Rows re-render only when their own item changes, so finished messages never re-parse markdown.
const Row = memo(function Row({ id }: { id: string }) {
  const item = useStore((s) => s.items[id]);
  if (!item) return null;
  switch (item.kind) {
    case 'user': {
      const relay = parseAgentNote(item.text);
      if (relay) return <div className="anote" data-id={id}><span>To agent <b>{relay.name}</b></span><p>{relay.text}</p></div>;
      const note = parseNote(item.text);
      if (note) return <NoteCard id={id} note={note} />;
      return (
        <div className={`mewrap${item.queued ? ' queued' : ''}${item.stopped ? ' stopped' : ''}${item.phone ? ' rc-me' : ''}`}>
          {item.stopped && <span className="qtag stopd">Stopped before a reply</span>}
          {item.phone && <span className="rc-from"><PhoneIcon size={11} />From your phone</span>}
          {item.queued && <QueuedTag id={id} text={item.text} files={!!item.files?.length} />}
          <div className="me" data-id={id}>
            <UserBody text={item.text} files={item.files} pastes={item.pastes} links={item.links} />
          </div>
          {item.text.trim() && <CopyBtn text={item.text} label={false} />}
        </div>
      );
    }
    case 'agent':
      return <AgentReply id={id} text={item.text} tldr={item.tldr} />;
    case 'group':
      return <ToolGroup id={id} />;
    case 'rich':
      return <Rich item={item} />;
    case 'tool':
      return (
        <div className="tl" data-id={id}><span className="tool mono">{item.verb}</span><span className="s mono">{item.summary}</span></div>
      );
    case 'permission':
      return <PermissionCard item={item} />;
    case 'error':
      return <div className="err" data-id={id}>{item.message}</div>;
    case 'changes':
      return <ChangeStrip id={id} cards={item.cards} />;
    case 'update':
      return <UpdateRow item={item} />;
  }
});

function Hello() {
  const summary = useStore(currentSummary);
  const current = useStore((s) => s.current);
  const loading = useStore((s) => s.loading);
  if (!current) return <Start />;
  // Until the backlog arrives an existing session would read as empty; this fades in only if the wait is noticeable.
  if (loading) {
    return (
      <div className="hello loading" role="status">
        {summary && <b>{summary.name} · </b>}Loading the conversation…
        <i></i><i></i><i></i>
      </div>
    );
  }
  if (!summary) return null;
  return (
    <div className="hello">
      <HeroRobot />
      <p>
        <b>New session</b> in <span className="mono">{summary.cwd}</span>
        {summary.branch && <> on <span className="mono">{summary.branch}</span></>}. Ask anything to start.
      </p>
    </div>
  );
}

// Rows mounted when a conversation opens; more mount a batch at a time as the reader nears either edge, and past
// MOUNTED rows the far edge unmounts, so the DOM and the media in it stay bounded both ways.
// Lite mounts fewer rows; read at use time, so a profile change applies on the next shift.
const WINDOW = () => (isLite() ? 30 : 50);
const BATCH = () => (isLite() ? 25 : 40);
const MOUNTED = () => (isLite() ? 60 : 120);
const JUMP_MS = 700;
// Reader input this recent means they are reading, so an update turn does not pull the view down.
const READING_MS = 5000;
// Back at the end, the "New" divider stays this long, then fades out over FADE_MS.
const MARK_HOLD_MS = 4000;
const MARK_FADE_MS = 300;

// The frozen watermark: the newest row the reader had seen when rows started arriving unseen.
type Mark = { id: string; leaving: boolean };

// The mounted range of a session by row id. first null: the newest WINDOW rows; last null: through the newest row.
type Win = { key: string | null; first: string | null; last: string | null };
const FOLLOW: Win = { key: null, first: null, last: null };
function rangeOf(w: Win, order: string[], current: string | null) {
  const mine = w.key === current;
  const lastAt = mine && w.last ? order.indexOf(w.last) : -1;
  const firstAt = mine && w.first ? order.indexOf(w.first) : -1;
  const to = lastAt >= 0 ? lastAt + 1 : order.length;
  const auto = Math.max(0, to - WINDOW());
  return { from: firstAt >= 0 && firstAt < to ? Math.min(firstAt, auto) : auto, to };
}

export function Conversation() {
  const order = useStore((s) => s.order);
  const current = useStore((s) => s.current);
  const older = useStore((s) => s.older);
  const [win, setWin] = useState<Win>(FOLLOW);
  const { from, to } = rangeOf(win, order, current);
  const atEnd = to === order.length;
  const pinned = win.key === current && (win.first !== null || win.last !== null);
  const setRange = (f: number, t: number) => {
    const first = order[f] ?? null;
    const last = t >= order.length ? null : order[t - 1];
    if (win.key === current && first === win.first && last === win.last) return;
    setWin({ key: current, first, last });
  };
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const jumping = useRef(0);
  const lastIsUser = useStore((s) => s.order.length > 0 && s.items[s.order[s.order.length - 1]]?.kind === 'user');
  const convRef = useRef<HTMLElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The reader scrolled up far enough that a way back to the latest message helps.
  const [away, setAway] = useState(false);
  const working = useStore((s) => s.status === 'working');
  const watching = useWatching();
  const convEl = useLayoutVars(convRef);
  const latestEl = useLayoutVars();
  // The newest row the reader has seen; it follows the end while they are there with the tab visible.
  const seen = useRef<string | null>(null);
  const [mark, setMark] = useState<Mark | null>(null);
  const markRef = useRef<Mark | null>(null);
  const putMark = (m: Mark | null) => {
    markRef.current = m;
    setMark(m);
  };
  const fadeTimer = useRef(0);
  // An update turn the view declined to follow; the jump button stays until the reader is back at the end.
  const [held, setHeld] = useState(false);
  // The update the button last jumped to; only updates after it still count as new.
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);
  // Back at the end: everything there is seen, and the divider goes after a short hold.
  const caughtUp = () => {
    const s = useStore.getState();
    seen.current = s.order[s.order.length - 1] ?? null;
    setHeld(false);
    setJumpedTo(null);
    if (!markRef.current || fadeTimer.current) return;
    fadeTimer.current = window.setTimeout(() => {
      const m = markRef.current;
      if (!m) return void (fadeTimer.current = 0);
      putMark({ ...m, leaving: true });
      fadeTimer.current = window.setTimeout(() => {
        fadeTimer.current = 0;
        putMark(null);
      }, MARK_FADE_MS);
    }, MARK_HOLD_MS);
  };
  // Leaving the end before the hold is over keeps the divider.
  const keepMark = () => {
    const m = markRef.current;
    if (!fadeTimer.current || m?.leaving) return;
    clearTimeout(fadeTimer.current);
    fadeTimer.current = 0;
  };
  useEffect(() => {
    const onVisible = () => !document.hidden && stick.current && caughtUp();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(fadeTimer.current);
    };
  }, []);

  // Follow new content only while the reader is at the bottom; jumps are instant.
  useLayoutEffect(() => {
    const conv = convRef.current!;
    const toEnd = () => {
      if (stick.current) conv.scrollTop = conv.scrollHeight;
    };
    toEnd();
    const ro = new ResizeObserver(toEnd);
    ro.observe(colRef.current!);
    ro.observe(conv);
    return () => ro.disconnect();
  }, []);

  // Switching sessions lands on the latest message with no scroll animation; the start page reads from the top.
  // Scrolled in rAF, still before paint, so the new rows get one layout with everything else the switch changed.
  useLayoutEffect(() => {
    stick.current = !!current;
    setAway(false);
    // A window kept from an earlier visit to this session would reopen it mid-history.
    setWin(FOLLOW);
    // The watermark is per session: a switch starts from the newest row, with no divider.
    seen.current = null;
    clearTimeout(fadeTimer.current);
    fadeTimer.current = 0;
    putMark(null);
    setHeld(false);
    setJumpedTo(null);
    const conv = convRef.current!;
    const frame = requestAnimationFrame(() => (conv.scrollTop = current ? conv.scrollHeight : 0));
    return () => cancelAnimationFrame(frame);
  }, [current]);

  // Sending a message brings the view back to the bottom, with the newest rows mounted again. Keyed by the last row,
  // so an older page arriving above does not count.
  const lastId = order[order.length - 1];
  useLayoutEffect(() => {
    if (!lastIsUser) return;
    stick.current = true;
    setAway(false);
    setWin(FOLLOW);
    caughtUp();
  }, [lastIsUser, lastId]);
  useEffect(() => onSent(() => {
    stick.current = true;
    setAway(false);
    setWin(FOLLOW);
    caughtUp();
    const el = convRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }), []);

  // Only a scroll the reader started lets go of the bottom; layout shifts and content changes never do.
  const intent = useRef(0);
  const gliding = useRef(false);
  const byReader = () => (intent.current = Date.now());

  // A new last row: an update turn may stop the follow, and a row the reader cannot see freezes the watermark.
  // Runs before the ResizeObserver scrolls, so a declined follow never moves the view.
  const prevLast = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prev = prevLast.current;
    prevLast.current = lastId ?? null;
    if (!lastId || !current) return;
    // Only the rows added since the last look, and never a whole backlog, can open an update turn.
    const { order: list, items } = useStore.getState();
    const since = prev ? list.lastIndexOf(prev) + 1 : list.length;
    let woke = false;
    for (let i = since; since > 0 && i < list.length && list.length - since <= 8; i++) woke ||= items[list[i]]?.kind === 'update';
    if (woke && (!stick.current || Date.now() - intent.current < READING_MS)) {
      stick.current = false;
      setHeld(true);
    }
    if (seen.current === null || (stick.current && !document.hidden)) {
      seen.current = lastId;
      return;
    }
    if (markRef.current && !markRef.current.leaving) return keepMark();
    clearTimeout(fadeTimer.current);
    fadeTimer.current = 0;
    putMark({ id: seen.current, leaving: false });
  }, [lastId]);
  // The empty gutter beside the conversation (the folded Agents panel's column) scrolls it too.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element;
      const el = convRef.current;
      if (e.ctrlKey || !el || !(t === document.body || t === document.documentElement || t.id === 'root')) return;
      el.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY });
      byReader();
    };
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  const onKey = (e: React.KeyboardEvent) => ['ArrowUp', 'PageUp', 'Home', ' '].includes(e.key) && byReader();
  useEffect(() => bindInlineRelease(() => { byReader(); stick.current = false; }), []);
  // Find and jumps mount the window around their row; a row already mounted leaves it as it is.
  useEffect(() => bindWindow({
    mountAt: (i) => setWin((w) => {
      // The jump scrolls a few frames later; until then the edges must not move the window (or the view) off its row.
      jumping.current = Date.now() + JUMP_MS;
      const s = useStore.getState();
      const n = s.order.length;
      const r = rangeOf(w, s.order, s.current);
      if (!s.order[i] || (i >= r.from && i < r.to)) return w;
      const m = MOUNTED();
      const f = Math.max(0, Math.min(i - (m >> 1), n - m));
      const t = Math.min(n, f + m);
      return { key: s.current, first: s.order[f], last: t >= n ? null : s.order[t - 1] };
    }),
    release: () => { byReader(); stick.current = false; },
    send,
  }), []);
  // Rows mounted or unmounted around the view: keep it where it was, unless the browser's scroll anchoring already did.
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a?.el.isConnected) return;
    const dy = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(dy) >= 1) convRef.current!.scrollTop += dy;
  }, [from, to]);
  // The hidden column collapses and clamps the scroll; ignore that and put the reader back on close.
  const savedTop = useRef(0);
  const hid = useRef(false);
  useLayoutEffect(() => {
    if (watching) return void (hid.current = true);
    if (!hid.current) return;
    hid.current = false;
    convRef.current!.scrollTop = stick.current ? convRef.current!.scrollHeight : savedTop.current;
  }, [watching]);
  const onScroll = () => {
    if (isWatching()) return;
    const el = convRef.current!;
    savedTop.current = el.scrollTop;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const reader = Date.now() - intent.current < 400;
    const was = stick.current;
    if (gap <= 24 || reader) {
      stick.current = gap <= 24 && atEnd;
      gliding.current = false;
    } else if (stick.current && !gliding.current) el.scrollTop = el.scrollHeight;
    if (stick.current && !was) caughtUp();
    else if (!stick.current && was) keepMark();
    const far = gap > el.clientHeight * 0.6 || !atEnd;
    if (far !== away) setAway(far);
    edges();
  };

  // The row across the middle of the view, held still while rows mount or unmount around it.
  const holdView = () => {
    const mid = convRef.current!.getBoundingClientRect().top + convRef.current!.clientHeight / 2;
    for (const el of colRef.current!.children) {
      const top = el.getBoundingClientRect().top;
      if (el.getBoundingClientRect().bottom >= mid) return void (anchor.current = { el, top });
    }
  };
  const shift = (f: number, t: number) => {
    holdView();
    setRange(f, t);
  };
  // Near an edge of the mounted rows, the next batch mounts there (and the far edge unmounts past MOUNTED); at the
  // oldest loaded row the server sends an older page. Following the bottom, the top counts as near only on a short conversation.
  const edges = () => {
    if (Date.now() < jumping.current) return;
    const el = convRef.current!;
    const n = order.length;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    const above = stick.current ? el.scrollHeight - el.clientHeight : el.scrollTop;
    const reach = el.clientHeight * 1.5;
    const B = BATCH(), M = MOUNTED();
    if (above < reach && from > 0) return shift(Math.max(0, from - B), Math.min(to, Math.max(0, from - B) + M));
    if (above < reach && older !== null) return void (isLoadingOlder() || loadOlder());
    if (below < reach && !atEnd) return shift(Math.max(from, Math.min(n, to + B) - M), Math.min(n, to + B));
    if (to - from > M + B) return above > el.clientHeight * 3 ? shift(to - M, to) : shift(from, from + M);
    // Back at the bottom, only the newest rows stay; off it, the window stops following new rows so nothing above the reader moves.
    if (stick.current && atEnd && pinned) {
      holdView();
      return setWin(FOLLOW);
    }
    if (!stick.current && !pinned) setWin({ key: current, first: order[from] ?? null, last: null });
  };
  // New rows or an older page can leave the window past its size or the reader at an edge; looked at after layout.
  useEffect(() => {
    if (!current || watching) return;
    const frame = requestAnimationFrame(() => convRef.current && edges());
    return () => cancelAnimationFrame(frame);
  }, [order.length, older, current, watching]);

  const toLatest = () => {
    const el = convRef.current!;
    stick.current = true;
    gliding.current = true;
    setAway(false);
    caughtUp();
    // Rows far from the newest are not mounted, so there is nothing to glide over: jump.
    if (!atEnd || from < order.length - MOUNTED()) {
      gliding.current = false;
      setWin(FOLLOW);
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  // Rows after the watermark: the divider goes before the first, and their update headers feed the jump button.
  const markAt = mark ? order.lastIndexOf(mark.id) : -1;
  const newAt = markAt >= 0 && markAt < order.length - 1 ? markAt + 1 : -1;
  let fresh = 0;
  let firstUpdate: string | null = null;
  if (newAt >= 0) {
    const items = useStore.getState().items;
    const past = jumpedTo ? order.lastIndexOf(jumpedTo) + 1 : 0;
    for (let i = Math.max(newAt, past); i < order.length; i++) {
      if (items[order[i]]?.kind !== 'update') continue;
      fresh++;
      firstUpdate ??= order[i];
    }
  }
  const toUpdate = (id: string) => {
    setJumpedTo(id);
    showRow(id);
    afterFrames(() => colRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }));
  };
  const shown = from || !atEnd ? order.slice(from, to) : order;
  const rows: React.ReactNode[] = [];
  // One flat keyed list, so the divider coming and going never remounts a row.
  shown.forEach((id, i) => {
    if (from + i === newAt) rows.push(<NewMark key=":new" id={id} leaving={mark!.leaving} />);
    rows.push(<Row key={id} id={id} />);
  });

  return (
    <>
      <main className="conv" ref={convEl} onScroll={onScroll} onWheel={byReader} onTouchMove={byReader} onKeyDown={onKey}>
        <div className="col" ref={colRef}>
          <Activity mode={watching ? 'hidden' : 'visible'}>
            {order.length === 0 && <Hello />}
            {rows}
            {/* Live state belongs under the newest row; hidden while the window sits higher up. */}
            {atEnd && (
              <>
                <Outbox />
                <Working />
                <HandoffCard />
              </>
            )}
          </Activity>
        </div>
      </main>
      <SwitchFx convRef={convRef} />
      <FindBar convRef={convRef} release={() => { byReader(); stick.current = false; }} />
      {/* Outside the scroller, whose fade mask would clip it. */}
      {(away || held) && current && (
        <button className="tolatest" ref={latestEl} onClick={firstUpdate ? () => toUpdate(firstUpdate) : toLatest}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" /></svg>
          {fresh ? `${fresh} new update${fresh > 1 ? 's' : ''}` : working ? 'Jump to live' : 'Jump to latest'}
        </button>
      )}
    </>
  );
}
