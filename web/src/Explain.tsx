import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useStore, type ExplainView } from './store.ts';
import { send } from './socket.ts';
import { Markdown } from './Markdown.tsx';
import { openImage } from './ImageViewer.tsx';
import { SendIcon, attachText } from './SendToChat.tsx';
import { Check, CopyIcon } from './bits.tsx';
import { useLayoutVars } from './layoutVars.ts';
import { Led } from './led.tsx';
import { useClaudeReady } from './setup.ts';

const MAX_EXCERPT = 4000;
const MAX_QUOTE = 240;
const BTN_W = 460;
const ADDED_MS = 900;

function ask(x: ExplainView, question: string) {
  const turns = x.turns.map((t) => ({ question: t.question, text: t.text }));
  const sent = send({ type: 'explain', sessionId: x.sessionId, thread: x.thread, excerpt: x.excerpt, turns, question, deep: x.deep });
  useStore.setState({ explain: { ...x, status: sent ? 'loading' : 'error', pending: sent ? question : '', error: sent ? '' : 'Not connected' } });
}

// A new excerpt starts a new thread; answers still on their way for the old one are dropped.
function start(sessionId: string, excerpt: string) {
  ask({ sessionId, thread: crypto.randomUUID(), excerpt, turns: [], status: 'loading', pending: '', error: '', deep: false }, '');
}

const close = () => useStore.setState({ explain: null });

// Asks the last question again from the whole conversation; a new thread drops late events from the cheap answer.
function deeper(x: ExplainView) {
  const last = x.turns.at(-1);
  ask({ ...x, thread: crypto.randomUUID(), deep: true, turns: x.turns.slice(0, -1) }, last?.question ?? '');
}
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

type Spot = { left: number; top: number; text: string; quote: string };

// Selected code stays a fenced block; anything else becomes a Markdown quote.
function quoteOf(range: Range, raw: string) {
  const block = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('.code, pre');
  const code = block(range.startContainer);
  if (code && code === block(range.endContainer)) {
    const lang = code.closest('.cframe')?.querySelector('.fh .n')?.textContent?.trim();
    const fence = raw.includes('```') ? '~~~' : '```';
    return `${fence}${lang && lang !== 'text' ? lang : ''}\n${raw.replace(/^\n+|\s+$/g, '')}\n${fence}\n\n`;
  }
  const lines = raw.trim().replace(/\n{3,}/g, '\n\n').split('\n');
  return `${lines.map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>')).join('\n')}\n\n`;
}

// Where the button goes: under the end of the selection, or above its start when the composer is in the way.
function spotOf(sel: Selection | null): Spot | null {
  const text = sel?.toString().trim() ?? '';
  if (!sel || sel.isCollapsed || !text || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const conv = document.querySelector('.conv');
  if (!conv?.contains(range.commonAncestorContainer)) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  const box = conv.getBoundingClientRect();
  if (last.bottom < box.top || first.top > box.bottom) return null;
  const below = last.bottom + 8;
  const top = below + 32 < box.bottom ? below : Math.max(box.top, first.top - 40);
  return { left: Math.max(8, Math.min(last.right - BTN_W / 2, innerWidth - BTN_W - 8)), top, text, quote: quoteOf(range, sel.toString()) };
}

// The floating Explain / Attach to chat bar next to text selected in the conversation.
export function ExplainButton() {
  const current = useStore((s) => s.current);
  const claudeOk = useClaudeReady();
  const [spot, setSpot] = useState<Spot | null>(null);
  const [note, setNote] = useState<'' | 'added' | 'copied'>('');
  // Timer while "Added" or "Copied" shows; the bar stays even though the selection moved to the composer.
  const hold = useRef(0);
  // "Attach with text" swaps the buttons for a field; focusing it drops the selection, so the bar stops following it.
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const withText = (on: boolean) => {
    askingRef.current = on;
    setAsking(on);
    setDraft('');
  };

  useEffect(() => {
    let down = false;
    let timer = 0;
    let frame = 0;
    const check = () => {
      if (!hold.current && !askingRef.current) setSpot(spotOf(getSelection()));
    };
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(check, ms);
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('.xbtn')) return;
      clearTimeout(hold.current);
      hold.current = 0;
      setNote('');
      askingRef.current = false;
      setAsking(false);
      down = true;
      setSpot(null);
    };
    const onUp = () => {
      down = false;
      later(0);
    };
    // Keyboard selections count too; a drag in progress waits for the release.
    const onSelect = () => {
      if (!down) later(150);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', onSelect);
    document.addEventListener('scroll', onScroll, true);
    addEventListener('resize', onScroll);
    return () => {
      clearTimeout(timer);
      clearTimeout(hold.current);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('selectionchange', onSelect);
      document.removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onScroll);
    };
  }, []);

  if (!spot || !current) return null;
  const go = () => {
    start(current, spot.text.slice(0, MAX_EXCERPT));
    getSelection()?.removeAllRanges();
    setSpot(null);
  };
  // Keeps the bar up for a moment so the new label can be read, then closes it.
  const flash = (n: '' | 'added' | 'copied') => {
    clearTimeout(hold.current);
    hold.current = window.setTimeout(() => {
      hold.current = 0;
      setNote('');
      setSpot(null);
    }, ADDED_MS);
    getSelection()?.removeAllRanges();
    withText(false);
    setNote(n);
  };
  // The quote goes to the tray as a text attachment, so it stays out of the way of what is being typed.
  const toChat = (text?: string) => flash(attachText(spot.quote.replace(/\s+$/, ''), text) ? 'added' : '');
  const copy = () => {
    void navigator.clipboard?.writeText(spot.text).then(() => flash('copied'));
  };
  if (asking) {
    const submit = (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (draft.trim()) toChat(draft);
    };
    // Esc closes the field and must not reach the global handler, which would stop the turn.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      withText(false);
      setSpot(null);
    };
    return (
      <form className="xbtn stc-pair stc-ask" style={{ left: spot.left, top: spot.top }} onSubmit={submit} onKeyDown={onKey}>
        <textarea
          autoFocus rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What do you want to ask about it?"
          aria-label="Text to send with the attachment"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
        />
        <button type="submit" className="stc-act" disabled={!draft.trim()}>
          <SendIcon />
          Attach
        </button>
      </form>
    );
  }
  return (
    <div
      className="xbtn stc-pair" role="toolbar" aria-label="Selected text"
      style={{ left: spot.left, top: spot.top }}
      // Keeps the selection while the click lands.
      onPointerDown={(e) => e.preventDefault()}
    >
      {claudeOk && (
        <>
          <button type="button" className="stc-act" onClick={go}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3M8 11.6v.1" />
            </svg>
            Explain
          </button>
          <i className="stc-sep" aria-hidden="true" />
        </>
      )}
      <button type="button" className="stc-act" onClick={copy} title="Copy the selected text">
        {note === 'copied' ? <Check /> : <CopyIcon />}
        <span aria-live="polite">{note === 'copied' ? 'Copied' : 'Copy'}</span>
      </button>
      <i className="stc-sep" aria-hidden="true" />
      <button type="button" className="stc-act" onClick={() => toChat()} title="Attach it to your message as a quote">
        <SendIcon />
        <span aria-live="polite">{note === 'added' ? 'Attached' : 'Attach to chat'}</span>
      </button>
      <i className="stc-sep" aria-hidden="true" />
      <button type="button" className="stc-act" onClick={() => withText(true)} title="Attach it and type what you want to say about it">
        Attach with text
      </button>
    </div>
  );
}

// The side conversation about one excerpt: the explanation, its drawing and follow-ups.
export function ExplainPanel() {
  const panelEl = useLayoutVars();
  const x = useStore((s) => s.explain);
  const current = useStore((s) => s.current);
  // A Codex tab has no Claude transcript to fork, so answers read the recent messages only.
  const deepOk = useStore((s) => s.roster.find((r) => r.id === s.current)?.caps?.deepExplain !== false);
  const [draft, setDraft] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const status = x?.status;

  // Keeps the newest answer and the input in view, like a chat.
  const toEnd = () => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toEnd, [x]);

  useEffect(() => {
    if (status === 'ready') input.current?.focus({ preventScroll: true });
  }, [status]);

  if (!x || x.sessionId !== current) return null;
  const loading = x.status === 'loading';
  const quote = x.excerpt.length > MAX_QUOTE ? `${x.excerpt.slice(0, MAX_QUOTE)}…` : x.excerpt;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q || loading) return;
    setDraft('');
    ask(x, q);
  };
  // Esc closes the panel and must not reach the global handler, which would stop the turn.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };

  return (
    <section className="xp" ref={panelEl} aria-label="Explain" onKeyDown={onKey}>
      <header className="xp-top">
        <b>Explain</b>
        {deepOk && (
          <button
            className="xp-deep" aria-pressed={x.deep} disabled={loading}
            title={x.deep ? 'Answers read the whole conversation with the session model' : 'Answers read only the recent messages, with Sonnet'}
            onClick={() => useStore.setState({ explain: { ...x, deep: !x.deep } })}
          >
            Whole conversation
          </button>
        )}
        <button className="xp-x" aria-label="Close" title="Close" onClick={close}>
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
        </button>
      </header>
      <div className="xp-body" ref={body}>
        {quote && <blockquote className="xp-quote">{quote}</blockquote>}
        {x.turns.map((t, i) => (
          <div className="xp-turn" key={i}>
            {t.question && <p className="xp-me">{t.question}</p>}
            <Markdown text={t.text.slice(0, 10000)} />
            {t.svg && <img className="xp-draw" src={svgUrl(t.svg)} alt="Drawing for this explanation" onLoad={toEnd} onClick={(e) => openImage(e)} />}
          </div>
        ))}
        {loading && (
          <div className="xp-turn">
            {x.pending && <p className="xp-me">{x.pending}</p>}
            <p className="xp-wait"><Led pattern="think" size="sm" />Thinking…<small>{x.deep ? 'whole conversation' : 'recent messages'}</small></p>
          </div>
        )}
        {deepOk && x.status !== 'loading' && !x.deep && (x.turns.length > 0 || x.status === 'error') && (
          <button className="xp-more" onClick={() => deeper(x)}>Not quite? Ask with the whole conversation</button>
        )}
        {x.status === 'error' && <p className="xp-err">No answer: {x.error}</p>}
      </div>
      <form className="xp-ask" onSubmit={submit}>
        <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Still unsure? Ask here" disabled={loading} aria-label="Follow-up question" />
        <button type="submit" disabled={loading || !draft.trim()}>Send</button>
      </form>
    </section>
  );
}
