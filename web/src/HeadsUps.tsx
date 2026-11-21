import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { create } from 'zustand';
import { CLAIMS_CHALLENGE, CLAIMS_MODEL, claimAgent, claimAgentLabel, isClaimCorrection, type ClaimAgent, type ClaimCheck, type ClaimClosing, type HeadsUp, type PeerAsk, type UiElement, type UiNode } from '../../server/protocol.ts';
import { dismissLocal, onCommander, pickAgent, sent, useStore } from './store.ts';
import { submit } from './outbox.ts';
import { ChunkGuard } from './Stale.tsx';
import { openSession, send } from './socket.ts';
import { openLog } from './Agents.tsx';
import { goTo } from './bits.tsx';
import { PluginBand, press } from './PluginBand.tsx';
import { setLayoutVar, useLayoutVars, useNoticeSlot } from './layoutVars.ts';
import { answerAsk, answerTerminal, useAnswering, useOnScreen } from './answering.ts';
import { terminalAsks, terminalName, useTerminal } from './terminal.ts';
import { DiffFrame } from './Tools.tsx';
import { pushEscape } from './escape.ts';
import { attachText } from './SendToChat.tsx';

const ACTION = { review: 'Review', log: 'Open log', switch: 'Switch', 'force-stop': 'Force stop', agent: 'Open agent', model: 'Change model', challenge: 'Are you sure about that?' } as const;
// Loads with the commander's tab, or in a main session while a sub-session's ask waits.
const CommanderPins = lazy(() => import('./Commander.tsx').then((m) => ({ default: m.CommanderPins })));
const GroupPins = lazy(() => import('./Commander.tsx').then((m) => ({ default: m.GroupPins })));
// How long a new heads-up takes the badge before the most urgent one comes back.
const FRESH_MS = 4000;
const PLUGIN = 'plugin';
// How long a new info notice shows alone; it drives the bar's CSS animation, so the bar is the timer.
const SOLO_MS = 10000;
// Notices that land this soon after opening a session come from its fresh snapshot, so they stack instead.
const SETTLE_MS = 1500;

type TermAsk = ReturnType<typeof terminalAsks>[number];
type Entry =
  | { key: string; need: true; kind: 'term'; x: TermAsk }
  | { key: string; need: boolean; kind: 'hu'; h: HeadsUp }
  | { key: string; need: false; kind: 'plugin'; tree: UiNode; text: string };

function act(sessionId: string, h: HeadsUp) {
  const a = h.action;
  if (!a) return;
  if (a.kind === 'review') goTo(a.target);
  else if (a.kind === 'log') openLog(sessionId, a.target);
  else if (a.kind === 'force-stop') {
    if (!send({ type: 'force-stop', sessionId })) useStore.setState({ notice: 'Not connected', noticeInfo: false });
  } else if (a.kind === 'agent') pickAgent(sessionId, a.target);
  // The composer's model menu; heads-ups show for the open tab only, so it is this session's.
  else if (a.kind === 'model') document.getElementById('modelPop')?.showPopover();
  // Claims run their checkers from the unfolded list (ClaimsBody), not from here.
  else if (a.kind === 'challenge') return;
  else openSession(a.target);
}

function plainText(n: UiNode): string {
  if (typeof n === 'string') return n === '✦' ? '' : n;
  if (n.type === 'Markdown' && typeof n.props?.text === 'string') return n.props.text;
  if (n.type === 'Button' || n.type === 'Code' || n.type === 'Svg') return '';
  return (n.children ?? []).map(plainText).join(' ');
}

// The whole notice for the chat, with any explanation it has unfolded; column boxes become paragraphs.
function fullText(n: UiNode): string {
  if (typeof n === 'string') return n === '✦' ? '' : n;
  const p = n.props ?? {};
  if (n.type === 'Markdown') return typeof p.text === 'string' ? p.text.trim() : '';
  if (n.type === 'Code') return typeof p.source === 'string' ? '```\n' + p.source + '\n```' : '';
  if (n.type === 'Button' || n.type === 'Svg') return '';
  const parts = (n.children ?? []).map(fullText);
  return p.flexDirection === 'column' ? parts.map((s) => s.trim()).filter(Boolean).join('\n\n') : parts.join('');
}

const btnLabel = (n: UiElement): string => (n.children?.length ? n.children.map((c) => (typeof c === 'string' ? c : btnLabel(c))).join('') : String(n.props?.label ?? ''));

// The plugin's "Learn more" button and its path in the tree the plugin sent, so a press reaches the right node.
function learnMore(n: UiNode, path: number[] = []): { el: UiElement; path: number[] } | null {
  if (typeof n === 'string') return null;
  if (n.type === 'Button') return /learn more/i.test(btnLabel(n)) ? { el: n, path } : null;
  for (const [i, c] of (n.children ?? []).entries()) {
    const hit = learnMore(c, [...path, i]);
    if (hit) return hit;
  }
  return null;
}

const hasButton = (n: UiNode): boolean => typeof n !== 'string' && (n.type === 'Button' || !!n.children?.some(hasButton));
const EXPLAIN_MS = 60000;
const pluginText = (t: UiNode, tag: string | null) => fullText(tag ? dropTag(t, tag) : t).replace(/\n{3,}/g, '\n\n').trim();
const putText = (text: string) => attachText(text) || useStore.setState({ notice: 'No composer open', noticeInfo: true });

// One wait per session, outside the rows, so closing the heads-up panel does not drop it; each ends within EXPLAIN_MS.
const usePendingAttach = create<{ ids: Record<string, () => void> }>(() => ({ ids: {} }));

function attachWhenExplained(sid: string, first: UiNode, short: string, tag: string | null) {
  usePendingAttach.getState().ids[sid]?.();
  let over = false;
  // A switch to another session drops the text, so it never lands in that session's composer.
  const end = (text: string | null) => {
    if (over) return;
    over = true;
    stop();
    clearTimeout(timer);
    usePendingAttach.setState((s) => {
      const { [sid]: _done, ...ids } = s.ids;
      return { ids };
    });
    if (text && useStore.getState().current === sid) putText(text);
  };
  const stop = useStore.subscribe((s) => {
    if (s.current !== sid) return end(null);
    const next = s.maps[sid]?.above;
    // The notice closed before its explanation came: the short text still goes.
    if (!next) return end(short);
    if (next === first || !hasButton(next) || learnMore(next)) return;
    const long = pluginText(next, tag);
    end(long.includes(short.slice(0, 60)) ? long : `${short}\n\n${long}`);
  });
  const timer = setTimeout(() => end(short), EXPLAIN_MS);
  usePendingAttach.setState((s) => ({ ids: { ...s.ids, [sid]: () => end(null) } }));
}

// Plugins such as you-should-know open with their own "✦ Heads up ·"; the row shows that tag once, so the text and band drop it.
const TAG = /^\s*([^·]{1,24}?)\s*·\s*/;
function splitTag(text: string): [string | null, string] {
  const m = TAG.exec(text);
  return m ? [m[1], text.slice(m[0].length)] : [null, text];
}

function dropTag(tree: UiNode, tag: string): UiNode {
  let phase: 'tag' | 'dot' | 'done' = 'tag';
  const leaf = (s: string): string | null => {
    if (phase === 'tag') {
      if (s.trim() === '✦') return null;
      if (!s.trim()) return s;
      const t = s.trimStart();
      if (!t.startsWith(tag)) {
        phase = 'done';
        return s;
      }
      s = t.slice(tag.length);
      phase = 'dot';
    }
    if (phase === 'dot') {
      if (!s.trim()) return s;
      phase = 'done';
      return s.replace(/^\s*·\s*/, '');
    }
    return s;
  };
  const walk = (n: UiNode): UiNode | null => {
    if (phase === 'done') return n;
    if (typeof n === 'string') return leaf(n);
    if (!n.children) {
      phase = 'done';
      return n;
    }
    return { ...n, children: n.children.map(walk).filter((c): c is UiNode => c !== null) };
  };
  return walk(tree) ?? tree;
}

// A plain permission can be answered from the notice, since its card may sit far up or outside the loaded history.
function Answer({ sessionId, h }: { sessionId: string; h: HeadsUp }) {
  const id = h.action?.kind === 'review' && h.id.startsWith('perm:') ? h.action.target : null;
  const simple = useStore((s) => {
    const it = id ? s.items[id] : undefined;
    if (!id) return false;
    if (it?.kind !== 'permission') return /^(A command|A file edit) /.test(h.text);
    return it.answer === null && !it.questions && it.plan === undefined;
  });
  const no = useStore((s) => {
    const it = id ? s.items[id] : undefined;
    return it?.kind === 'permission' && !!it.defaultToNo;
  });
  // One answer per ask, shared with the card and the keys; the notice goes away once the server resolves it.
  const sent = useAnswering((s) => !!(id && s.ids[id]));
  if (!id || !simple) return null;
  const answer = (allow: boolean) => void answerAsk(sessionId, id, allow);
  return (
    <>
      <button className={`hu-act${no ? ' allow' : ''}`} disabled={sent} data-robot-react="tense" onClick={() => answer(false)}>Deny</button>
      <button className={`hu-act${no ? '' : ' allow'}`} disabled={sent} data-robot-react="happy" onClick={() => answer(true)}>Allow</button>
    </>
  );
}

// Another session's plain permission, answered here without switching to it.
function PeerAnswer({ ask }: { ask: PeerAsk }) {
  const sent = useAnswering((s) => !!s.ids[ask.id]);
  return (
    <>
      <button className="hu-act" disabled={sent} data-robot-react="tense" onClick={() => answerAsk(ask.sessionId, ask.id, false)}>Deny</button>
      <button className="hu-act allow" disabled={sent} data-robot-react="happy" onClick={() => answerAsk(ask.sessionId, ask.id, true)}>Allow</button>
    </>
  );
}

function TermAnswer({ x }: { x: TermAsk }) {
  const ask = x.ask;
  const sent = useAnswering((s) => !!s.ids[ask.id]);
  return (
    <>
      <button className="hu-act" disabled={sent} data-robot-react="tense" onClick={() => answerTerminal(ask.id, false)}>Deny</button>
      {ask.always && (
        <button className="hu-act" disabled={sent} data-robot-react="happy" title="Allow, and don't ask again for similar requests, as the terminal offers" onClick={() => answerTerminal(ask.id, true, true)}>
          Always
        </button>
      )}
      <button className="hu-act allow" disabled={sent} data-robot-react="happy" onClick={() => answerTerminal(ask.id, true)}>Allow</button>
    </>
  );
}

function dismiss(sessionId: string, id: string) {
  if (send({ type: 'dismiss', sessionId, id })) dismissLocal(sessionId, id);
}

// What the user is approving: where it comes from, then the tool and its command or file.
function AskText({ from, tool, text }: { from: string; tool: string; text: string }) {
  return (
    <>
      <span className="tq-w">{from}</span>
      <b>{tool}</b> <span className="mono">{text}</span>
    </>
  );
}

function label(e: Entry, past: ReturnType<typeof useStore.getState>['past']) {
  if (e.kind === 'term') {
    const a = e.x.ask;
    return <AskText from={`Terminal · ${terminalName(e.x.session, past)}${a.title ? ` · ${a.title}` : ''}`} tool={a.tool} text={a.command ?? a.summary} />;
  }
  if (e.kind === 'plugin') {
    const [tag, rest] = splitTag(e.text);
    return <><span className="tq-w">{tag ?? 'Heads up'}</span>{rest}</>;
  }
  const { h } = e;
  if (h.ask) return <AskText from={`${h.text.replace(/ needs you$/, '')}${h.ask.title ? ` · ${h.ask.title}` : ''}`} tool={h.ask.tool} text={h.ask.command ?? h.ask.summary} />;
  return <>{h.text}{h.detail && <small>{h.detail}</small>}</>;
}

function hasDiff(e: Entry) {
  return e.kind === 'term' ? !!e.x.ask.detail : e.kind === 'hu' && !!e.h.ask?.detail;
}

function Actions({ sessionId, e, onOpen }: { sessionId: string | null; e: Entry; onOpen: () => void }) {
  if (e.kind === 'term') return <TermAnswer x={e.x} />;
  if (e.kind === 'plugin') return <button className="hu-act" onClick={onOpen}>Open</button>;
  if (!sessionId) return null;
  const { h } = e;
  if (h.ask) return <PeerAnswer ask={h.ask} />;
  return (
    <>
      {h.action && !h.claims && <button className="hu-act" onClick={() => act(sessionId, h)}>{ACTION[h.action.kind]}</button>}
      <Answer sessionId={sessionId} h={h} />
    </>
  );
}

const VERDICT_LABEL = { confirmed: 'Confirmed', partial: 'Partly right', wrong: 'Wrong', external: "Can't check here", unclear: 'Unclear' } as const;
const AGENTS_KEY = 'cw-claim-agents';

function disabledAgents(offered: ClaimAgent[]): ClaimAgent[] {
  try {
    const v = JSON.parse(localStorage.getItem(AGENTS_KEY) ?? 'null');
    if (Array.isArray(v)) return offered.filter((a) => {
      if (a === 'haiku' || a === `claude:${CLAIMS_MODEL}`) return !v.includes('haiku');
      if (a === 'codex' || a.startsWith('codex:')) return !v.includes('codex');
      return false;
    });
    if (Array.isArray(v?.off)) return v.off.filter((a: unknown) => typeof a === 'string').slice(-32);
  } catch {}
  return [];
}

function ClaimsBody({ sessionId, h }: { sessionId: string; h: HeadsUp }) {
  const offered = h.claimCheckers?.map(claimAgent) ?? (h.codexReady ? ['haiku', 'codex'] : ['haiku']);
  const [off, setOff] = useState(() => disabledAgents(offered));
  const checks = h.checks ?? [];
  const claims = (h.claims ?? []).map((text, i) => ({
    text,
    why: h.claimWhy?.[i],
    verdicts: checks.flatMap(({ agent, verdicts }) => verdicts.flatMap((v) => v.claim === i + 1 ? [{ ...v, agent }] : [])),
  }));
  const picked = offered.filter((a) => !off.includes(a));
  const running = checks.some((k) => k.status === 'running');
  const corrections = claims.filter(({ verdicts }) => isClaimCorrection(verdicts));
  const flip = (a: ClaimAgent) => {
    const next = off.includes(a) ? off.filter((x) => x !== a) : [...off, a].slice(-32);
    setOff(next);
    localStorage.setItem(AGENTS_KEY, JSON.stringify({ off: next }));
  };
  const verify = () => {
    if (!send({ type: 'claims-verify', sessionId, agents: picked, claimId: h.id })) useStore.setState({ notice: 'Not connected', noticeInfo: false });
  };
  const correct = () => {
    const items = corrections.map(({ text, verdicts }) => [
      `- ${text}`,
      ...verdicts.map((v) => `  ${claimAgentLabel(v.agent)}: ${VERDICT_LABEL[v.verdict]}. ${v.note}`),
    ].join('\n'));
    void submit({ type: 'send', id: crypto.randomUUID(), sessionId, text: `${CLAIMS_CHALLENGE}\n${items.join('\n')}` });
    sent();
    dismiss(sessionId, h.id);
  };
  return (
    <div className="tq-d">
      <ol className="hu-claims">
        {claims.map(({ text, why, verdicts }, i) => {
          const disagree = new Set(verdicts.map((v) => v.agent)).size > 1 && new Set(verdicts.map((v) => v.verdict)).size > 1;
          return (
            <li key={i}>
              {text}
              {why && <div className="hu-claim-note">{why}</div>}
              {disagree && <div className="hu-claim-note">Checkers disagree</div>}
              {verdicts.map((v, j) => <div key={`${v.agent}:${j}`} className={`hu-v ${v.verdict}`}><b>{claimAgentLabel(v.agent)}: {VERDICT_LABEL[v.verdict]}.</b> {v.note}</div>)}
            </li>
          );
        })}
      </ol>
      <ClaimErrors checks={checks} />
      <div className="hu-claims-bar">
        {offered.map((a) => <button key={a} type="button" className="hu-act" aria-pressed={!off.includes(a)} disabled={running} onClick={() => flip(a)}>{claimAgentLabel(a)}</button>)}
        <span className="gap" />
        <button type="button" className="hu-act" disabled={running || !picked.length} aria-busy={running || undefined} onClick={verify}>
          {running ? 'Checking…' : checks.length ? 'Check again' : 'Confirm'}
        </button>
        {!h.final && !running && corrections.length > 0 && <button type="button" className="hu-act allow" onClick={correct}>Send to Claude</button>}
      </div>
    </div>
  );
}

function ClaimErrors({ checks }: { checks: Pick<ClaimCheck, 'agent' | 'status' | 'error'>[] }) {
  return checks.filter((k) => k.status === 'failed').map((k) => <p key={k.agent} className="hu-v-err">{claimAgentLabel(k.agent)} could not check: {k.error}</p>);
}

function ClaimClosingBody({ closing }: { closing: ClaimClosing }) {
  return (
    <div className="tq-d">
      <ol className="hu-claims">
        {closing.items.map((text, i) => (
          <li key={i}>
            {text}
            {closing.checks.map(({ agent, verdicts }) => {
              const v = verdicts.find((v) => v.claim === i + 1);
              return v && <div key={agent} className={`hu-v ${v.verdict}`}><b>{claimAgentLabel(agent)}: {v.verdict === 'resolved' ? 'Resolved' : 'Still open'}.</b> {v.note}</div>;
            })}
          </li>
        ))}
      </ol>
      <ClaimErrors checks={closing.checks} />
    </div>
  );
}

// One line in the open list; a diff or a plugin's full notice unfolds under it.
function Row({ sessionId, e, open, onToggle, ref }: { sessionId: string | null; e: Entry; open: boolean; onToggle: () => void; ref?: Ref<HTMLDivElement> }) {
  const past = useStore((s) => s.past);
  const detail = e.kind === 'term' ? e.x.ask.detail : e.kind === 'hu' ? e.h.ask?.detail : undefined;
  const plugin = e.kind === 'plugin';
  const claims = e.kind === 'hu' ? e.h.claims : undefined;
  const closing = e.kind === 'hu' ? e.h.closing : undefined;
  const tag = plugin ? splitTag(e.text)[0] : null;
  const tree = plugin ? (tag ? dropTag(e.tree, tag) : e.tree) : null;
  // The explanation being waited for; the wait ends with this row or when its session is no longer on screen.
  const asking = usePendingAttach((s) => !!sessionId && !!s.ids[sessionId]);
  // Before "Learn more" the notice is one line, so the button asks the plugin for the explanation and attaches both.
  const attach = () => {
    if (e.kind !== 'plugin' || !sessionId) return;
    const first = e.tree;
    const short = pluginText(first, tag);
    const more = learnMore(first);
    if (!more) return putText(short);
    attachWhenExplained(sessionId, first, short, tag);
    press(sessionId, more.el, more.path);
  };
  return (
    <div ref={ref} className={`hub${e.need ? ' need' : ''}${detail || plugin || claims || closing ? ' tq' : ''}`}>
      <i className="d"></i>
      {/* An open plugin notice shows its full text below, so the line keeps only its title. */}
      <span className="tx">{open && plugin ? <span className="tq-w">{tag ?? 'Heads up'}</span> : label(e, past)}</span>
      {detail && <button className="hu-act" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Diff'}</button>}
      {(claims?.length || closing) ? <button className="hu-act" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Show'}</button> : null}
      {plugin ? <button className="hu-act" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Open'}</button> : <Actions sessionId={sessionId} e={e} onOpen={onToggle} />}
      {e.kind === 'hu' && e.h.ask && sessionId && <button className="hu-act" onClick={() => act(sessionId, e.h)}>Switch</button>}
      {e.kind === 'hu' && e.h.dismissable && sessionId && (
        <button className="hu-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(sessionId, e.h.id)}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8" /></svg>
        </button>
      )}
      {open && detail && <div className="tq-d"><DiffFrame d={detail} state={null} /></div>}
      {open && claims && e.kind === 'hu' && !e.h.claimExtracting && sessionId && <ClaimsBody key={e.h.id} sessionId={sessionId} h={e.h} />}
      {open && closing && <ClaimClosingBody closing={closing} />}
      {open && tree && sessionId && (
        <div className="tq-d">
          <PluginBand sessionId={sessionId} tree={tree} actions={<button type="button" className="plb-btn" disabled={asking} aria-busy={asking || undefined} onClick={attach}>{asking ? 'Attaching…' : 'Attach to chat'}</button>} />
        </div>
      )}
    </div>
  );
}

// Notices that need the user sit above the composer; information-only ones stack under the title.
export function HeadsUps() {
  return (
    <>
      <ActionHeadsUps />
      <InfoHeadsUps />
    </>
  );
}

// Heads-ups that need an answer, behind one badge: it shows the most urgent one (or a new one, briefly) and opens into the full list.
// In a session it sits at the left of the robot strip, which starts after it; --hh lifts the conversation when there is no strip.
function ActionHeadsUps() {
  const sessionId = useStore((s) => s.current);
  const raw = useStore((s) => (s.current ? s.maps[s.current]?.headsUps : undefined)) ?? [];
  const onScreen = useOnScreen((s) => s.ids);
  const above = useStore((s) => (s.current ? s.maps[s.current]?.above : null)) ?? null;
  const terminal = useTerminal((s) => s.sessions);
  const past = useStore((s) => s.past);
  const [panel, setPanel] = useState(false);
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const husEl = useLayoutVars(ref);

  // A main session's sub-sessions' plain permissions, pinned in this column; such an ask is not also a peer heads-up.
  const group = useStore((s) => (s.current ? s.maps[s.current]?.groupAsks : undefined));
  const pinned = (a: PeerAsk) => !!group?.some((p) => p.ask.sessionId === a.sessionId && p.ask.id === a.id);
  // A permission whose card is in view already shows its buttons there.
  const hus = sessionId ? raw.filter((h) => !(h.action?.kind === 'review' && h.id.startsWith('perm:') && onScreen[h.action.target]) && !(h.ask && pinned(h.ask))) : [];
  const entries: Entry[] = [
    ...terminalAsks(terminal).map((x): Entry => ({ key: `term:${x.ask.id}`, need: true, kind: 'term', x })),
    ...hus.filter((h) => h.need || h.claims || h.closing).map((h): Entry => ({ key: h.id, need: h.need, kind: 'hu', h })),
    ...(sessionId && above !== null ? [{ key: PLUGIN, need: false, kind: 'plugin', tree: above, text: plainText(above).replace(/\s+/g, ' ').trim() } as const] : []),
  ];
  const keys = entries.map((e) => e.key).join('\n');
  const has = entries.length > 0;
  const many = entries.length > 1;
  const replyCheck = hus.find((h) => h.claimReplyId && !h.claimExtracting)?.id;
  // The commander pins other sessions' asks in the same column, above its own heads-ups; a main session its sub-sessions'.
  const commander = useStore(onCommander);
  const grouped = !!group?.length;
  const shown = has || commander || grouped;
  const pins = (commander || grouped) && <ChunkGuard><Suspense fallback={null}>{commander ? <CommanderPins /> : <GroupPins />}</Suspense></ChunkGuard>;

  // A key not seen before in this session takes the badge for FRESH_MS; switching sessions marks everything seen.
  const seen = useRef<{ sid: string | null; keys: Set<string> } | null>(null);
  const freshT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const now = keys ? keys.split('\n') : [];
    const prev = seen.current;
    seen.current = { sid: sessionId, keys: new Set(now) };
    if (!prev || prev.sid !== sessionId) {
      clearTimeout(freshT.current);
      return setFresh(null);
    }
    const added = now.filter((k) => !prev.keys.has(k));
    if (!added.length) return;
    setFresh(added[0]);
    clearTimeout(freshT.current);
    freshT.current = setTimeout(() => setFresh(null), FRESH_MS);
  }, [keys, sessionId]);
  useEffect(() => () => clearTimeout(freshT.current), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return setLayoutVar('--hh', null);
    // The commander's column stays mounted with no pins, and then lifts nothing.
    const ro = new ResizeObserver(([e]) => {
      const h = Math.round(e.borderBoxSize[0].blockSize);
      setLayoutVar('--hh', h ? h + 8 + 'px' : null);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setLayoutVar('--hh', null);
    };
  }, [shown]);

  useEffect(() => setPanel(false), [sessionId, many]);
  useEffect(() => {
    if (!replyCheck) return;
    setUnfolded(replyCheck);
    if (many) setPanel(true);
  }, [replyCheck, sessionId, many]);
  useEffect(() => {
    if (!panel) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setPanel(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setPanel(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [panel]);

  if (!has) return pins ? <div className="hus" ref={husEl}>{pins}</div> : null;
  const top = entries.find((e) => e.key === fresh) ?? entries[0];
  const more = entries.length - 1;
  const unfold = (key: string) => {
    setUnfolded(unfolded === key ? null : key);
    setPanel(true);
  };
  // A lone heads-up is shown as itself; the badge and its list only group two or more.
  if (!many) {
    return (
      <div className="hus" ref={husEl} role="status" aria-label="Heads-up">
        {pins}
        <Row sessionId={sessionId} e={top} open={unfolded === top.key} onToggle={() => setUnfolded(unfolded === top.key ? null : top.key)} />
      </div>
    );
  }
  return (
    <div className="hus" ref={husEl} role="status" aria-label="Heads-up">
      {pins}
      <div className={`hu-badge${top.need ? ' need' : ''}${top.key === fresh ? ' fresh' : ''}`}>
        <button className="hu-open" aria-expanded={panel} aria-controls="hu-panel" title={panel ? 'Hide heads-ups' : 'Show all heads-ups'} onClick={() => setPanel(!panel)}>
          <i className="d"></i>
          <span key={top.key} className="tx">{label(top, past)}</span>
          {more > 0 && <span className="hu-n">+{more}</span>}
        </button>
        {hasDiff(top) && <button className="hu-act" onClick={() => unfold(top.key)}>Diff</button>}
        {top.kind === 'hu' && (top.h.claims?.length || top.h.closing) ? <button className="hu-act" onClick={() => unfold(top.key)}>Show</button> : null}
        <Actions sessionId={sessionId} e={top} onOpen={() => unfold(top.key)} />
      </div>
      {panel && (
        <div className="hu-panel" id="hu-panel">
          {entries.map((e) => <Row key={e.key} sessionId={sessionId} e={e} open={unfolded === e.key} onToggle={() => setUnfolded(unfolded === e.key ? null : e.key)} />)}
        </div>
      )}
    </div>
  );
}

const noop = () => {};
const infoEntry = (h: HeadsUp): Entry => ({ key: h.id, need: false, kind: 'hu', h });
const noticeText = (n: number) => `${n} notice${n === 1 ? '' : 's'}`;

// The stack's chip; a new count crossfades in over the old one.
function Chip({ n, wait, open, onClick }: { n: number; wait: boolean; open: boolean; onClick: () => void }) {
  const [num, setNum] = useState<{ now: number; was: number | null }>({ now: n, was: null });
  if (num.now !== n) setNum({ now: n, was: num.now });
  return (
    <button className={`hin-chip${wait ? ' wait' : ''}`} aria-expanded={open} aria-controls="hin-panel" title={open ? 'Hide notices' : 'Show notices'} onClick={onClick}>
      <i className="d"></i>
      <span className="hin-ct">
        {num.was !== null && (
          <span key={`was${num.was}`} className="out" aria-hidden="true" onAnimationEnd={() => setNum((x) => ({ ...x, was: null }))}>{noticeText(num.was)}</span>
        )}
        <span key={num.now} className={num.was !== null ? 'in' : undefined}>{noticeText(num.now)}</span>
      </span>
    </button>
  );
}

// Information-only heads-ups under the title: a new one shows alone for SOLO_MS, then merges into a numbered chip that opens the list.
function InfoHeadsUps() {
  const sessionId = useStore((s) => s.current);
  const loaded = useStore((s) => !!(s.current && s.maps[s.current]));
  const raw = useStore((s) => (s.current ? s.maps[s.current]?.headsUps : undefined));
  const info = sessionId && raw ? raw.filter((h) => !h.need && !h.claims && !h.closing) : [];
  const keys = info.map((h) => h.id).join('\n');
  // solo shows alone with its timer; leaving is the card playing its merge into the chip.
  const [stage, setStage] = useState<{ solo: string | null; leaving: string | null }>({ solo: null, leaving: null });
  // The commander's header bar holds the notices in its slot; with no room for a card there, each goes straight to the chip.
  const slot = useNoticeSlot();
  const tight = !!slot?.tight;
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The list centres under the chip; it shifts only by what would leave the window.
  useLayoutEffect(() => {
    const p = panelRef.current;
    const s = stackRef.current;
    if (!open || !p || !s) return;
    const r = s.getBoundingClientRect();
    const x = Math.max(12, Math.min(r.left + (r.width - p.offsetWidth) / 2, innerWidth - 12 - p.offsetWidth));
    p.style.left = Math.round(x - r.left) + 'px';
  }, [open]);
  // Ids already seen in the session on screen; opening or switching to a session counts everything present as seen.
  const seen = useRef<{ sid: string; ids: Set<string>; until: number } | null>(null);

  useEffect(() => {
    if (!sessionId || !loaded) {
      seen.current = null;
      return;
    }
    const ids = keys ? keys.split('\n') : [];
    const now = Date.now();
    const prev = seen.current?.sid === sessionId ? seen.current : null;
    seen.current = { sid: sessionId, ids: new Set(ids), until: prev?.until ?? now + SETTLE_MS };
    if (!prev) setOpen(false);
    if (!prev || tight) return setStage((s) => (s.solo || s.leaving ? { solo: null, leaving: null } : s));
    const added = now >= prev.until ? ids.filter((id) => !prev.ids.has(id)) : [];
    const live = (id: string | null) => (id && ids.includes(id) ? id : null);
    setStage((s) => {
      const next = added.at(-1);
      // The newest takes the solo spot and the current card merges at once; the rest of a burst stacks.
      if (next) return { solo: next, leaving: live(s.solo) ?? live(s.leaving) };
      const solo = live(s.solo);
      const leaving = live(s.leaving);
      return solo === s.solo && leaving === s.leaving ? s : { solo, leaving };
    });
  }, [sessionId, loaded, keys, tight]);

  // The bar's animation pauses while the tab is hidden, so a notice is never timed out unseen.
  const showing = !!stage.solo;
  useEffect(() => {
    if (!showing) return;
    const on = () => setHidden(document.hidden);
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [showing]);

  const n = info.filter((h) => h.id !== stage.solo && h.id !== stage.leaving).length;
  const chip = n > 0 || !!stage.leaving;
  useEffect(() => {
    if (!chip) setOpen(false);
  }, [chip]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !stackRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    const off = pushEscape(() => setOpen(false));
    return () => {
      document.removeEventListener('pointerdown', down);
      off();
    };
  }, [open]);

  const cards = [stage.leaving, stage.solo].flatMap((id) => info.filter((h) => h.id === id));
  if (!sessionId || (!chip && !cards.length)) return null;
  const merge = () => setStage((s) => (s.solo ? { solo: null, leaving: s.solo } : s));
  const merged = (id: string) => setStage((s) => (s.leaving === id ? { ...s, leaving: null } : s));
  // A card that merges from under a visible chip starts lower and travels up into it; in the bar it merges in place.
  const below = n > 0 && !slot;
  return (
    <div className="hin" role="status" aria-label="Notices" data-hidden={hidden || undefined} data-bar={slot ? '' : undefined} style={slot ? { left: slot.left, right: slot.right, top: slot.top } : undefined}>
      {chip && (
        <div className="hin-stack" ref={stackRef}>
          {/* Until the first card lands, the chip holds its spot unseen so the next card does not jump. */}
          <Chip key={sessionId} n={Math.max(n, 1)} wait={n === 0} open={open} onClick={() => { if (!open) merge(); setOpen(!open); }} />
          {open && (
            <div className="hu-panel hin-panel" id="hin-panel" ref={panelRef}>
              {info.map((h) => <Row key={h.id} sessionId={sessionId} e={infoEntry(h)} open={false} onToggle={noop} />)}
            </div>
          )}
        </div>
      )}
      {cards.map((h) => {
        const leaving = h.id === stage.leaving;
        return (
          <div key={h.id} className={`hin-card${leaving ? ` merge${below ? ' below' : ''}` : ''}`} onAnimationEnd={(e) => leaving && e.target === e.currentTarget && merged(h.id)}>
            <Row sessionId={sessionId} e={infoEntry(h)} open={false} onToggle={noop} />
            <i className="hin-bar" style={{ animationDuration: `${SOLO_MS}ms` }} onAnimationEnd={(e) => !leaving && e.target === e.currentTarget && merge()} />
          </div>
        );
      })}
    </div>
  );
}
