import { Activity, memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { currentSummary, lastRow, onSent, sent, useStore, type Item, type Tldr } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { UiReport } from './UiBlock.tsx';
import { DiffFrame, ToolGroup } from './Tools.tsx';
import { Rich } from './Rich.tsx';
import { UserBody } from './Composer.tsx';
import { BranchIcon, CopyBtn, reduceMotion } from './bits.tsx';
import { isLite, pauseOffscreen } from './perf.ts';
import { ListenBtn } from './Voice.tsx';
import { PhoneIcon } from './Remote.tsx';
import { HeroRobot } from './robotHero.tsx';
import { Working } from './Working.tsx';
import { HandoffCard, NoteCard } from './HandoffCard.tsx';
import { handoffLive, parseAgentNote, parseNote } from './handoff.ts';
import { discard, outgoingNote, resend, submit, useOutbox, type Outgoing, type SendMsg } from './outbox.ts';
import { restoreDraft, SendTextBtn, type Draft } from './SendToChat.tsx';
import { readFiles, type Pending } from './attach.ts';
import { PlanCard, QuestionCard } from './Ask.tsx';
import { resumeSession, unqueue } from './actions.ts';
import { FindBar } from './Find.tsx';
import { bindInlineMenu, bindInlineRelease } from './InlineRead.tsx';
import { useLens } from './lens.ts';
import { ChangeStrip } from './Changes.tsx';
import { useLayoutVars } from './layoutVars.ts';
import { Start } from './Start.tsx';
import { Flap } from './flap.tsx';
import { SwitchFx } from './switchFx.tsx';
import { isWatching, useWatching } from './watch/open.ts';
import { afterFrames, bindWindow, isLoadingOlder, loadOlder, reach, rowOf, showRow, useOlderLoad } from './convWindow.ts';
import type { AskReply, Attachment, Wake } from '../../server/protocol.ts';
import { shownReply } from './stretch/compose.ts';
import { openOf } from './stretch/store.ts';
import { BranchBtn, BranchMenu } from './BranchMenu.tsx';
import { answerAsk, useAnswering } from './answering.ts';

// User rows from the transcript or the composer carry their prompt uuid; others (notes, wakes) cannot be branched from.
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PermissionCard({ item }: { item: Extract<Item, { kind: 'permission' }> }) {
  if (item.questions) return <QuestionCard item={item} />;
  if (item.plan !== undefined) return <PlanCard item={item} />;
  return <AllowCard item={item} />;
}

// Cells per character, so only a command that fits the card's three lines flips; longer ones show as plain text.
const FLIP_MAX = 200;

// The command flips in once; it starts blank so the first render has something to flip from.
function FlipIn({ text }: { text: string }) {
  const [shown, setShown] = useState('');
  useEffect(() => setShown(text), [text]);
  return <Flap text={shown} className="mono" />;
}

// The whole command, clamped to three lines with a toggle when it runs longer, so a destructive tail stays reachable.
function AskCommand({ tool, text, fresh, done }: { tool: string; text: string; fresh: boolean; done: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  // Paths and other asks stay on one line.
  const one = done || tool !== 'Bash';
  useEffect(() => {
    if (all || one) return;
    const ro = new ResizeObserver(([e]) => {
      const el = e.target as HTMLElement;
      setLong(el.scrollHeight > el.clientHeight + 1);
    });
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, [all, one]);
  const flips = fresh && text.length <= FLIP_MAX && !text.includes('\n');
  return (
    <span className="cmd">
      <span ref={ref} className={`cmd-t${one ? ' one' : all ? ' all' : ''}`}>
        <b>{tool}</b> {flips ? <FlipIn text={text} /> : <span className="mono">{text}</span>}
      </span>
      {!one && (long || all) && (
        <button type="button" className="cmd-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</button>
      )}
    </span>
  );
}

const REASON_MAX = 2000;

function AllowCard({ item }: { item: Extract<Item, { kind: 'permission' }> }) {
  const current = useStore((s) => s.current);
  // One answer per ask, shared with the heads-up and the keys: the buttons stay off until it resolves.
  const sending = useAnswering((s) => !!s.ids[item.id]);
  // The deny reason being typed; null while the box is closed.
  const [why, setWhy] = useState<string | null>(null);
  const answer = (allow: boolean, reply?: AskReply) => {
    if (current) answerAsk(current, item.id, allow, reply);
  };
  const deny = () => {
    const t = why?.trim();
    answer(false, t ? { feedback: t } : undefined);
  };
  // Codex approvals carry only accept or decline, so a reason would be lost.
  const explains = !item.id.startsWith('codex:');
  const no = !!item.defaultToNo;
  const done = item.answer !== null;
  // Cards already answered when the row mounts (history) stay plain text.
  const [fresh] = useState(!done);
  const outcome = item.elsewhere ? 'Answered on your phone' : item.cancelled ? 'No longer needed' : item.answer ? (item.reply?.always ? 'Allowed for this agent' : 'Allowed') : 'Denied';
  const card = (
    <div className={`ask${done ? ' done' : ''}${item.answer === false && !item.elsewhere && !item.cancelled ? ' denied' : ''}`} data-id={item.detail ? undefined : item.id}>
      {!done && <span className="ask-rail" aria-hidden="true"><i></i><i></i><i></i><i></i></span>}
      <AskCommand tool={item.tool} text={item.command ?? item.summary} fresh={fresh} done={done} />
      {item.title && <span className="q">{item.title}</span>}
      <span className="sp"></span>
      {why === null ? (
        <span className="opts">
          <button className={`opt${no ? ' go' : ''}`} disabled={sending} data-robot-react="tense" onClick={() => answer(false)}><kbd aria-hidden="true">n</kbd>Deny</button>
          {explains && <button className="opt" disabled={sending} data-robot-react="tense" title="Deny and tell Claude what to do instead" onClick={() => setWhy('')}>Deny…</button>}
          {item.always && <button className="opt" disabled={sending} data-robot-react="happy" title="Allow this and similar requests for the rest of this agent's session" onClick={() => answer(true, { always: true })}>Always</button>}
          <button className={`opt${no ? '' : ' go'}`} disabled={sending} data-robot-react="happy" onClick={() => answer(true)}>{!no && <kbd aria-hidden="true">↵</kbd>}Allow</button>
        </span>
      ) : (
        <form className="opts ask-why" onSubmit={(e) => (e.preventDefault(), deny())}>
          <input
            autoFocus value={why} maxLength={REASON_MAX} disabled={sending} placeholder="Tell Claude what to do instead" aria-label="Reason for denying"
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              // Keeps Enter, n and Esc from reaching the global permission and stop keys.
              e.stopPropagation();
              if (e.key === 'Escape') setWhy(null);
            }}
          />
          <button type="submit" className="opt go" disabled={sending} data-robot-react="tense">Deny</button>
          <button type="button" className="opt" disabled={sending} onClick={() => setWhy(null)}>Cancel</button>
        </form>
      )}
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
  const { msg, state } = o;
  const failed = state === 'failed';
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (state !== 'sent') return;
    const since = Date.now() - o.at;
    const timers = [SENDING_MS, STALLED_MS].map((ms, i) => setTimeout(() => setStage(i + 1), Math.max(0, ms - since)));
    return () => timers.forEach(clearTimeout);
  }, [o.at, state]);
  const label = state !== 'sent' ? outgoingNote(o) : stage === 2 ? 'Still waiting for the server…' : stage === 1 ? 'Sending…' : null;
  // A row saved without its big files would go out incomplete; Edit lets the user add them back.
  const partial = !!o.missing?.length;
  // The message goes back into the composer whole; the row goes only once that worked.
  const edit = () => {
    const files = (msg.files ?? []).map((upload, i) => ({ key: crypto.randomUUID(), upload, thumb: msg.thumbs?.[i] ?? null }));
    if (restoreDraft({ text: msg.text, files, pastes: msg.pastes ?? [], links: msg.links ?? [] })) discard(msg.id);
    else useStore.setState({ notice: 'No room in the message box for these files', noticeInfo: false });
  };
  return (
    <div className={`mewrap outgoing${label ? ' labeled' : ''}${failed ? ' failed' : ''}`} aria-busy={state === 'sent'}>
      {label && (
        <span className="qtag" role="status">
          {label}
          {/* A stalled row may have been dropped by the server, so it can be discarded too. */}
          {(state !== 'sent' || stage === 2) && (
            <span className="qacts">
              {/* A closed session would refuse it again; Edit moves the text to an open one. */}
              {failed && !partial && o.why !== 'closed' && <button onClick={() => resend(msg.id)}>Send again</button>}
              {failed && <button onClick={edit}>Edit</button>}
              <button onClick={() => discard(msg.id)}>Discard</button>
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

// Only the reply the running turn is writing can still grow.
function AgentReply({ id, text, tldr }: { id: string; text: string; tldr?: Tldr }) {
  const live = useStore((s) => s.status === 'working' && s.streaming === id);
  const current = useStore((s) => s.current);
  const report = useMemo(() => (current ? { sessionId: current, itemId: id } : null), [current, id]);
  // A summary already there when the row mounted shows without the fade.
  const [hadTldr] = useState(!!tldr);
  return (
    <div className="reply" data-id={id}>
      {tldr && <TldrNote t={tldr} late={!hadTldr} />}
      <UiReport.Provider value={report}>
        <Markdown text={text} live={live} id={id} msg={id} />
      </UiReport.Provider>
      {!live && (
        <div className="macts">
          <CopyBtn text={() => shownReply(text, openOf(id))} />
          <SendTextBtn text={() => `Your earlier reply:\n\n${shownReply(text, openOf(id))}`} what="this reply" className="cpb" />
          <ListenBtn id={id} text={text} /><BranchBtn id={id} />
        </div>
      )}
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

const ASK_RESULT = 'The background agents have reported. Please give me the result.';

// An agent's report woke Main and its turn ended without a reply, so nothing on screen says the work is back.
function QuietRow({ item }: { item: Extract<Item, { kind: 'quiet' }> }) {
  const current = useStore((s) => s.current);
  const [asked, setAsked] = useState(false);
  const ask = () => {
    if (!current) return;
    const msg: SendMsg = { type: 'send', id: crypto.randomUUID(), sessionId: current, text: ASK_RESULT };
    void submit(msg);
    sent();
    setAsked(true);
  };
  const open = !item.done && !asked;
  return (
    <div className={`upd quiet${open ? '' : ' done'}`} data-id={item.id}>
      <span className="upd-dot" aria-hidden="true"></span>
      <span className="upd-t">Agent reports arrived, but Main did not reply</span>
      {open && <span className="qacts"><button onClick={ask} title={ASK_RESULT}>Ask for the result</button></span>}
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

// A branch names the conversation it was made from; a click opens that one.
function BranchedFrom() {
  const parent = useStore((s) => currentSummary(s)?.parent);
  if (!parent) return null;
  return (
    <div className="lineage" role="note">
      <BranchIcon />
      <span>Branched from</span>
      <button type="button" title="Open the conversation this one was branched from" onClick={() => resumeSession(parent.id)}>{parent.name}</button>
    </div>
  );
}

// Above the oldest loaded row: an older page loading, a failed one to retry, or the start. One height in every
// state, so a change never shifts the rows below it.
function HistoryTop() {
  const current = useStore((s) => s.current);
  const start = useStore((s) => s.older === null && !s.loading);
  const load = useOlderLoad((s) => (current ? s[current] : undefined));
  return (
    <div className={`htop${start ? ' start' : ''}`} role={start ? 'separator' : 'status'}>
      {start ? <span>Start of conversation</span>
        : load === 'loading' ? <span>Loading earlier messages…</span>
        : load === 'failed' ? <span>Couldn't load earlier messages<button type="button" onClick={() => void loadOlder(undefined, true)}>Retry</button></span>
        : null}
    </div>
  );
}

type UserItem = Extract<Item, { kind: 'user' }>;
const notify = (notice: string) => useStore.setState({ notice, noticeInfo: false });

// A sent picture read back from its signed copy as a composer file; null when there is none to read.
async function refetch(f: Attachment): Promise<Pending | null> {
  if (!f.src) return null;
  try {
    const r = await fetch(f.src);
    if (!r.ok) return null;
    const blob = await r.blob();
    return (await readFiles([new File([blob], f.name, { type: blob.type })])).ok[0] ?? null;
  } catch {
    return null;
  }
}

// A sent message rebuilt for the composer; lost counts the files that could not be read back.
async function draftOf(item: UserItem) {
  const files: Pending[] = [];
  let lost = 0;
  for (const f of item.files ?? []) {
    const p = await refetch(f);
    if (p) files.push(p);
    else lost++;
  }
  // Links point at files by position, so a lost file would shift them onto the wrong one.
  const draft: Draft = { text: item.text, files, pastes: item.pastes ?? [], links: lost ? [] : item.links ?? [] };
  return { draft, lost };
}

async function editAgain(_sessionId: string, item: UserItem) {
  const { draft, lost } = await draftOf(item);
  if (!restoreDraft(draft)) notify('No room in the message box for these files');
  else if (lost) notify(lost > 1 ? `${lost} files could not be added back` : 'A file could not be added back');
}

// Through the outbox like the composer; a message missing a file goes to the composer instead.
async function sendAgain(sessionId: string, item: UserItem) {
  const { draft, lost } = await draftOf(item);
  if (lost) return editAgain(sessionId, item);
  const { text, files, pastes, links } = draft;
  const msg: SendMsg = {
    type: 'send', id: crypto.randomUUID(), sessionId, text, ...(pastes.length ? { pastes } : {}), ...(links.length ? { links } : {}),
    ...(files.length ? { files: files.map((f) => f.upload), thumbs: files.map((f) => f.thumb) } : {}),
  };
  void submit(msg);
  sent();
}

function StoppedTag({ id }: { id: string }) {
  const current = useStore((s) => s.current);
  const [busy, setBusy] = useState(false);
  const run = (fn: (sessionId: string, item: UserItem) => Promise<void>) => async () => {
    const item = useStore.getState().items[id];
    if (busy || !current || item?.kind !== 'user') return;
    setBusy(true);
    await fn(current, item);
    setBusy(false);
  };
  return (
    <span className="qtag stopd">
      Stopped before a reply
      <span className="qacts">
        <button disabled={busy} onClick={run(sendAgain)} title="Send this message again">Send again</button>
        <button disabled={busy} onClick={run(editAgain)} title="Take it back into the message box">Edit</button>
      </span>
    </span>
  );
}

// Turn failures the next message can pick up from; mode, model or rename errors are not.
// Codex version warnings and usage limits are left out: Continue cannot help there.
const TURN_ERR = /^(?:Assistant error:|Codex:|Codex reported|Claude Code (?:exited|was force-stopped))/;
const CONTINUE = 'Continue';
const ERR_SCAN = 200;

// The last error offers Continue for a failed turn, or Retry when its prompt got no reply at all.
function nextStep(id: string, message: string): { retry: string } | 'continue' | null {
  if (TURN_ERR.test(message)) return 'continue';
  const { order, items } = useStore.getState();
  for (let i = order.lastIndexOf(id) - 1, n = 0; i >= 0 && n < ERR_SCAN; i--, n++) {
    const it = items[order[i]];
    if (it?.kind === 'user') return it.queued || parseAgentNote(it.text) || parseNote(it.text) ? null : { retry: it.id };
    if (it?.kind === 'agent' || it?.kind === 'group' || it?.kind === 'tool' || it?.kind === 'rich') return null;
  }
  return null;
}

function ErrorRow({ id, message }: { id: string; message: string }) {
  const last = useStore((s) => s.status === 'idle' && lastRow(s)?.id === id);
  const current = useStore((s) => s.current);
  // Hidden once used, so a slow echo cannot send it twice.
  const [used, setUsed] = useState(false);
  const step = last ? nextStep(id, message) : null;
  const go = () => {
    if (!current || !step) return;
    setUsed(true);
    if (step !== 'continue') {
      const item = useStore.getState().items[step.retry];
      if (item?.kind === 'user') void sendAgain(current, item);
      return;
    }
    void submit({ type: 'send', id: crypto.randomUUID(), sessionId: current, text: CONTINUE });
    sent();
  };
  return (
    <div className="err" data-id={id}>
      {message}
      {last && !used && (
        <span className="qacts">
          {step && <button onClick={go} title={step === 'continue' ? 'Ask Claude to pick up where it stopped' : 'Send the last message again'}>{step === 'continue' ? 'Continue' : 'Retry'}</button>}
          <CopyBtn text={message} what="error" label={false} />
        </span>
      )}
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
          {item.stopped && <StoppedTag id={id} />}
          {item.phone && <span className="rc-from"><PhoneIcon size={11} />From your phone</span>}
          {item.queued && <QueuedTag id={id} text={item.text} files={!!item.files?.length} />}
          <div className="me" data-id={id}>
            <UserBody text={item.text} files={item.files} pastes={item.pastes} links={item.links} />
          </div>
          {item.text.trim() && <CopyBtn text={item.text} label={false} />}
          {!item.queued && PROMPT_ID.test(id) && <BranchBtn id={id} user />}
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
      return <ErrorRow id={id} message={item.message} />;
    case 'changes':
      return <ChangeStrip id={id} cards={item.cards} />;
    case 'update':
      return <UpdateRow item={item} />;
    case 'quiet':
      return <QuietRow item={item} />;
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

// The row each session was read at when the reader left it scrolled up, offered again on return.
const readAt = new Map<string, string>();
const READ_AT_MAX = 30;
const READ_MS = 150;
// A session taken off the dock takes its spot with it.
useStore.subscribe((s, prev) => {
  if (s.dockOrder === prev.dockOrder) return;
  for (const sid of readAt.keys()) if (!s.dockOrder.includes(sid)) readAt.delete(sid);
});

export function Conversation() {
  const order = useStore((s) => s.order);
  const current = useStore((s) => s.current);
  const older = useStore((s) => s.older);
  const [win, setWin] = useState<Win>(FOLLOW);
  // The committed window, for convWindow's trim, which runs outside render.
  const winRef = useRef(win);
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
  const canBranch = useStore((s) => currentSummary(s)?.caps?.branch === true);
  const watching = useWatching();
  const convEl = useLayoutVars(convRef);
  const latestEl = useLayoutVars();
  const backEl = useLayoutVars();
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
  // The row being read while scrolled up, and the one offered back after a session switch.
  const readRow = useRef<string | null>(null);
  const readTimer = useRef(0);
  const readFrame = useRef(0);
  const [back, setBack] = useState<string | null>(null);
  const backRef = useRef<string | null>(null);
  const putBack = (id: string | null) => {
    backRef.current = id;
    setBack(id);
  };
  const dropBack = () => {
    if (!backRef.current) return;
    putBack(null);
    const sid = useStore.getState().current;
    if (sid) readAt.delete(sid);
  };
  useEffect(() => {
    const onVisible = () => !document.hidden && stick.current && caughtUp();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(fadeTimer.current);
      clearTimeout(readTimer.current);
      cancelAnimationFrame(readFrame.current);
    };
  }, []);

  // Follow new content only while the reader is at the bottom; jumps are instant.
  useLayoutEffect(() => {
    // Looked up on each call, so the observer never holds the element it watches.
    const toEnd = () => {
      const conv = convRef.current;
      if (conv && stick.current) conv.scrollTop = conv.scrollHeight;
    };
    toEnd();
    const ro = new ResizeObserver(toEnd);
    ro.observe(colRef.current!);
    ro.observe(convRef.current!);
    return () => ro.disconnect();
  }, []);

  // Switching sessions lands on the latest message with no scroll animation; the start page reads from the top.
  // Scrolled in rAF, still before paint, so the new rows get one layout with everything else the switch changed.
  const shownSid = useRef<string | null>(null);
  useLayoutEffect(() => {
    // The session left behind keeps the row it was read at, if the reader had scrolled up.
    const left = shownSid.current;
    shownSid.current = current;
    clearTimeout(readTimer.current);
    readTimer.current = 0;
    cancelAnimationFrame(readFrame.current);
    if (left && left !== current) {
      // An offer not taken yet outlives a visit spent at the bottom.
      const spot = !stick.current && readRow.current ? readRow.current : backRef.current;
      readAt.delete(left);
      if (spot) readAt.set(left, spot);
      if (readAt.size > READ_AT_MAX) readAt.delete(readAt.keys().next().value!);
    }
    readRow.current = null;
    putBack(current ? readAt.get(current) ?? null : null);
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
    dropBack();
    const el = convRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }), []);
  // A turn starting in the session on screen makes the old reading spot moot; a backlog landing busy is not a new turn.
  const loading = useStore((s) => s.loading);
  const turnSeen = useRef({ sid: current, working, loading });
  useEffect(() => {
    const was = turnSeen.current;
    turnSeen.current = { sid: current, working, loading };
    if (was.sid === current && !was.loading && working && !was.working) dropBack();
  }, [current, working, loading]);

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
  // Drag-selecting text is reading too: the follow lets go so the selection does not slide away under the pointer.
  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.buttons & 1)) return;
    byReader();
    if (stick.current && getSelection()?.isCollapsed === false) stick.current = false;
  };
  useEffect(() => bindInlineRelease(() => { byReader(); stick.current = false; }), []);
  useEffect(() => bindInlineMenu(convRef.current!), []);
  const lens = useLens(convRef);
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
    mountedFrom: () => {
      const s = useStore.getState();
      return rangeOf(winRef.current, s.order, s.current).from;
    },
  }), []);
  useEffect(() => {
    winRef.current = win;
  }, [win]);
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
    // A window shift waiting to commit holds the row under the view as it is now, not where it was when asked.
    if (anchor.current) holdView();
    trackRead();
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
  // Mounting a batch is the heavy part of a scroll, so it renders without blocking the next scroll frame.
  const shift = (f: number, t: number) => {
    holdView();
    startTransition(() => setRange(f, t));
  };
  // Shortly after scrolling settles: the row being read (while scrolled up), and whether the offered spot is in view.
  // Debounced, so a long scroll reads layout once at the end, inside a frame.
  const trackRead = () => {
    clearTimeout(readTimer.current);
    cancelAnimationFrame(readFrame.current);
    readTimer.current = window.setTimeout(() => (readFrame.current = requestAnimationFrame(() => {
      readTimer.current = 0;
      const conv = convRef.current;
      const col = colRef.current;
      if (!conv || !col || isWatching()) return;
      const box = conv.getBoundingClientRect();
      const b = backRef.current;
      const at = b ? col.querySelector(`[data-id="${CSS.escape(b)}"]`)?.getBoundingClientRect() : null;
      if (at && at.bottom > box.top && at.top < box.bottom) dropBack();
      readRow.current = null;
      if (stick.current) return;
      const mid = box.top + conv.clientHeight / 2;
      for (const el of col.children) {
        if (el.getBoundingClientRect().bottom < mid) continue;
        const id = el.getAttribute('data-id') ?? el.querySelector('[data-id]')?.getAttribute('data-id');
        if (id) return void (readRow.current = rowOf(id));
      }
    })), READ_MS);
  };
  // Back to the offered row: loaded and mounted through the window first, like Find's jumps.
  const goBack = async () => {
    const id = backRef.current;
    dropBack();
    if (!id || !(await reach(id)) || !showRow(id)) return;
    afterFrames(() => colRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }));
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
  // A wheel up at the very top fires no scroll event, so it looks at the edges itself.
  const onWheel = (e: React.WheelEvent) => {
    byReader();
    if (e.deltaY < 0 && convRef.current!.scrollTop <= 0) edges();
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
      <main className="conv" ref={convEl} onScroll={onScroll} onWheel={onWheel} onTouchMove={byReader} onPointerMove={onPointerMove} onKeyDown={onKey}>
        <div className="col" ref={colRef} data-nobranch={canBranch ? undefined : ''}>
          <Activity mode={watching ? 'hidden' : 'visible'}>
            {order.length === 0 && <Hello />}
            {order.length > 0 && from === 0 && <BranchedFrom key=":lineage" />}
            {order.length > 0 && from === 0 && <HistoryTop key=":top" />}
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
      <BranchMenu />
      <FindBar convRef={convRef} release={() => { byReader(); stick.current = false; }} />
      {lens.on && (
        <div className="lens-chip" role="status">
          <span className="lens-dot" aria-hidden="true"></span>
          Reading lens
          <button type="button" onClick={lens.off} aria-label="Turn off reading lens" title="Turn off (Esc or middle-click)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
          </button>
        </div>
      )}
      {/* Outside the scroller, whose fade mask would clip it. */}
      {(away || held) && current && (
        <button className="tolatest" ref={latestEl} onClick={firstUpdate ? () => toUpdate(firstUpdate) : toLatest}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" /></svg>
          {fresh ? `${fresh} new update${fresh > 1 ? 's' : ''}` : working ? 'Jump to live' : 'Jump to latest'}
        </button>
      )}
      {back && !away && !held && current && (
        <button className="tolatest backto" ref={backEl} onClick={() => void goBack()}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" /></svg>
          Back to where you were
        </button>
      )}
    </>
  );
}
