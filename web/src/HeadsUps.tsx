import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { HeadsUp, PeerAsk, UiNode } from '../../server/protocol.ts';
import { dismissLocal, pickAgent, useStore } from './store.ts';
import { openSession, send } from './socket.ts';
import { openLog } from './Agents.tsx';
import { goTo } from './bits.tsx';
import { PluginBand } from './PluginBand.tsx';
import { setLayoutVar, useLayoutVars } from './layoutVars.ts';
import { answerAsk, answerTerminal, useAnswering, useOnScreen } from './answering.ts';
import { terminalAsks, terminalName, useTerminal } from './terminal.ts';
import { DiffFrame } from './Tools.tsx';
import { pushEscape } from './escape.ts';

const ACTION = { review: 'Review', log: 'Open log', switch: 'Switch', 'force-stop': 'Force stop', agent: 'Open agent' } as const;
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
  else openSession(a.target);
}

function plainText(n: UiNode): string {
  if (typeof n === 'string') return n === '✦' ? '' : n;
  if (n.type === 'Markdown' && typeof n.props?.text === 'string') return n.props.text;
  if (n.type === 'Button' || n.type === 'Code' || n.type === 'Svg') return '';
  return (n.children ?? []).map(plainText).join(' ');
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
      {h.action && <button className="hu-act" onClick={() => act(sessionId, h)}>{ACTION[h.action.kind]}</button>}
      <Answer sessionId={sessionId} h={h} />
    </>
  );
}

// One line in the open list; a diff or a plugin's full notice unfolds under it.
function Row({ sessionId, e, open, onToggle, ref }: { sessionId: string | null; e: Entry; open: boolean; onToggle: () => void; ref?: Ref<HTMLDivElement> }) {
  const past = useStore((s) => s.past);
  const detail = e.kind === 'term' ? e.x.ask.detail : e.kind === 'hu' ? e.h.ask?.detail : undefined;
  const plugin = e.kind === 'plugin';
  const tag = plugin ? splitTag(e.text)[0] : null;
  return (
    <div ref={ref} className={`hub${e.need ? ' need' : ''}${detail || plugin ? ' tq' : ''}`}>
      <i className="d"></i>
      {/* An open plugin notice shows its full text below, so the line keeps only its title. */}
      <span className="tx">{open && plugin ? <span className="tq-w">{tag ?? 'Heads up'}</span> : label(e, past)}</span>
      {detail && <button className="hu-act" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Diff'}</button>}
      {plugin ? <button className="hu-act" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Open'}</button> : <Actions sessionId={sessionId} e={e} onOpen={onToggle} />}
      {e.kind === 'hu' && e.h.ask && sessionId && <button className="hu-act" onClick={() => act(sessionId, e.h)}>Switch</button>}
      {e.kind === 'hu' && e.h.dismissable && sessionId && (
        <button className="hu-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(sessionId, e.h.id)}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8" /></svg>
        </button>
      )}
      {open && detail && <div className="tq-d"><DiffFrame d={detail} state={null} /></div>}
      {open && plugin && sessionId && <div className="tq-d"><PluginBand sessionId={sessionId} tree={tag ? dropTag(e.tree, tag) : e.tree} /></div>}
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

  // A permission whose card is in view already shows its buttons there.
  const hus = sessionId ? raw.filter((h) => !(h.action?.kind === 'review' && h.id.startsWith('perm:') && onScreen[h.action.target])) : [];
  const entries: Entry[] = [
    ...terminalAsks(terminal).map((x): Entry => ({ key: `term:${x.ask.id}`, need: true, kind: 'term', x })),
    ...hus.filter((h) => h.need).map((h): Entry => ({ key: h.id, need: true, kind: 'hu', h })),
    ...(sessionId && above !== null ? [{ key: PLUGIN, need: false, kind: 'plugin', tree: above, text: plainText(above).replace(/\s+/g, ' ').trim() } as const] : []),
  ];
  const keys = entries.map((e) => e.key).join('\n');
  const has = entries.length > 0;
  const many = entries.length > 1;

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
    const ro = new ResizeObserver(([e]) => setLayoutVar('--hh', Math.round(e.borderBoxSize[0].blockSize) + 8 + 'px'));
    ro.observe(el);
    return () => {
      ro.disconnect();
      setLayoutVar('--hh', null);
    };
  }, [has]);

  useEffect(() => setPanel(false), [sessionId, many]);
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

  if (!has) return null;
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
        <Row sessionId={sessionId} e={top} open={unfolded === top.key} onToggle={() => setUnfolded(unfolded === top.key ? null : top.key)} />
      </div>
    );
  }
  return (
    <div className="hus" ref={husEl} role="status" aria-label="Heads-up">
      <div className={`hu-badge${top.need ? ' need' : ''}${top.key === fresh ? ' fresh' : ''}`}>
        <button className="hu-open" aria-expanded={panel} aria-controls="hu-panel" title={panel ? 'Hide heads-ups' : 'Show all heads-ups'} onClick={() => setPanel(!panel)}>
          <i className="d"></i>
          <span key={top.key} className="tx">{label(top, past)}</span>
          {more > 0 && <span className="hu-n">+{more}</span>}
        </button>
        {hasDiff(top) && <button className="hu-act" onClick={() => unfold(top.key)}>Diff</button>}
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
  const info = sessionId && raw ? raw.filter((h) => !h.need) : [];
  const keys = info.map((h) => h.id).join('\n');
  // solo shows alone with its timer; leaving is the card playing its merge into the chip.
  const [stage, setStage] = useState<{ solo: string | null; leaving: string | null }>({ solo: null, leaving: null });
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
    if (!prev) {
      setOpen(false);
      return setStage((s) => (s.solo || s.leaving ? { solo: null, leaving: null } : s));
    }
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
  }, [sessionId, loaded, keys]);

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
  // A card that merges from under a visible chip starts lower and travels up into it.
  const below = n > 0;
  return (
    <div className="hin" role="status" aria-label="Notices" data-hidden={hidden || undefined}>
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
