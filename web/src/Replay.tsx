import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { openReplay, useStore } from './store.ts';
import { reduceMotion } from './bits.tsx';
import { appendComposer } from './PluginBand.tsx';
import { SendIcon, SendImageBtn } from './SendToChat.tsx';
import { isNarrow } from './narrow.ts';
import { ReplayListen } from './Voice.tsx';
import { pageDoc, pagePng, pageTabUrl, usePageDoc } from './replayDoc.ts';
import { pageTheme } from './frameDoc.ts';
import { sign } from './LocalImage.tsx';
import { ViewerChrome } from './Focus.tsx';
import { OpenTabBtn } from './OpenInBrowser.tsx';

// Past this many pages the segment bar gets too fine to click; the "3 / 9" count stays.
const SEG_MAX = 24;
const ADDED_MS = 1200;

// Tall enough for any real page; stops a page sized in vh from growing forever.
const MAX_H = 20000;
// Space between the page and a floating bar at either end of the scroll (the stage viewer's GAP).
const GAP = 12;

const ICON = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const REPLAY_ICON = <svg {...ICON}><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8" /><path d="M2.6 2.4v2.9h2.9" /></svg>;
const PREV_ICON = <svg {...ICON}><path d="M12.5 8h-9M7 4 3 8l4 4" /></svg>;
const NEXT_ICON = <svg {...ICON} width={15} height={15} strokeWidth={1.6}><path d="M3.5 8h9M9 4l4 4-4 4" /></svg>;

// A quiz page is agent-written HTML: ids, choices and sizes are checked, and only the user's own text is kept long.
const QUIZ_MAX = 12;
const QUIZ_OPEN_MAX = 4000;
const QUIZ_ID = /^[\w-]{1,32}$/;
const QUIZ_PICK = /^[a-h]?$/;
const QUIZ_FOCUS_MS = 1500;
type QuizAnswer = { id: string; open: boolean; answer: string; label: string };

function quizAnswers(raw: unknown): QuizAnswer[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : []).slice(0, QUIZ_MAX).flatMap((a: Record<string, unknown> | null) => {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !QUIZ_ID.test(a.id) || seen.has(a.id) || typeof a.answer !== 'string') return [];
    seen.add(a.id);
    const open = a.kind === 'open';
    if (!open && !QUIZ_PICK.test(a.answer)) return [];
    const label = typeof a.label === 'string' ? a.label.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return [{ id: a.id, open, answer: open ? a.answer.slice(0, QUIZ_OPEN_MAX).trim() : a.answer, label: open ? '' : label }];
  });
}

// Composer text in the shape the replay skill grades (assets/quiz.js copies the same); the key comes from the server, never the page.
function quizText(title: string, where: string, key: string | undefined, answers: QuizAnswer[]) {
  const lines = answers.map((a) => {
    if (a.open) return a.answer ? `- ${a.id} (open):\n${a.answer.split('\n').map((l) => `  > ${l}`).join('\n')}` : `- ${a.id} (open): no answer`;
    return a.answer ? `- ${a.id}: ${a.answer}${a.label ? ` · page text "${a.label.replace(/"/g, "'")}"` : ''}` : `- ${a.id}: no answer`;
  });
  const grade = key ? `Grade them with the key in ${key}` : 'There is no quiz.json beside this replay';
  return `Quiz answers from the replay "${title}" (${where}). ${grade}:\n${lines.join('\n')}\n\n`;
}

// The replay viewer: the stage viewer's window and floating chrome around one live page at the full stage width.
export function ReplayViewer() {
  const view = useStore((s) => s.replayView);
  const info = useStore((s) => (s.replayView ? s.replays[s.replayView.key] : undefined));
  // The key is "session:item"; the tool result of that item holds the page pictures.
  const pngs = useStore((s) => {
    const it = s.replayView ? s.items[s.replayView.key.slice(s.replayView.key.indexOf(':') + 1)] : undefined;
    return it?.kind === 'rich' ? it.result?.pagePngs : undefined;
  });
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [i, setI] = useState(0);
  const [run, setRun] = useState(0);
  const [shown, setShown] = useState(false);
  const [height, setHeight] = useState(0);
  const [room, setRoom] = useState(0);
  const [roomH, setRoomH] = useState(0);
  // Scale of the page on narrow windows (1 elsewhere); the "Send to chat" pill maps frame coordinates through it.
  const scale = useRef(1);
  // Selected text in the page (frame coordinates) and where its "Send to chat" button sits in the dialog.
  const picked = useRef<{ text: string; x: number; y: number } | null>(null);
  const [pill, setPill] = useState<{ left: number; top: number } | null>(null);
  const [added, setAdded] = useState(false);
  // What had focus when the viewer opened; it gets it back on close.
  const back = useRef<Element | null>(null);
  // Quiz drafts by "replay:page", so paging away or replaying a page keeps the answers; cleared on close.
  const drafts = useRef(new Map<string, Record<string, string>>());
  // The last quiz text sent from a page, so a second click does not paste it twice.
  const lastQuiz = useRef('');
  // When the page frame last lost focus: a Send clicked just before focus moved to the toolbar still counts.
  const frameLeft = useRef(0);
  const pages = info?.pages ?? [];
  const n = pages.length;
  const page = pages[Math.min(i, n - 1)];
  const themed = info?.theme === 'auto';
  const doc = usePageDoc(view ? page?.url : undefined, themed);
  const png = page ? pagePng(pngs, page.id) : undefined;
  const title = info?.title || 'Replay';

  useEffect(() => {
    const d = ref.current!;
    if (view && !d.open) {
      back.current = document.activeElement;
      setI(view.page);
      setHeight(0);
      d.showModal();
      // The stage, not the first bar button, so the arrow keys scroll the page and Space never fires an action.
      stage.current!.focus({ preventScroll: true });
    } else if (!view) {
      drafts.current.clear();
      lastQuiz.current = '';
      if (d.open) d.close();
    }
  }, [view]);

  // Warm the next page only, so paging forward never waits and a long replay is not held whole in memory.
  useEffect(() => {
    const next = view ? pages[i + 1] : undefined;
    if (next) void pageDoc(next.url, themed ? pageTheme() : null).catch(() => {});
  }, [view, pages, i, themed]);

  // The stage pads its ends by the floating bars, so they cover the page only mid-scroll, never at its top or bottom.
  useLayoutEffect(() => {
    const fit = () => {
      const d = ref.current;
      const el = stage.current;
      const top = d?.querySelector<HTMLElement>('.fv-top');
      const foot = d?.querySelector<HTMLElement>('.fv-foot');
      if (!d || !el || !top || !foot) return;
      const t = top.offsetTop + top.offsetHeight + GAP;
      const b = d.clientHeight - foot.offsetTop + GAP;
      el.style.setProperty('--rp-top', `${t}px`);
      el.style.setProperty('--rp-bot', `${b}px`);
      setRoom(el.clientWidth);
      setRoomH(Math.max(0, el.clientHeight - t - b));
    };
    const ro = new ResizeObserver(fit);
    const d = ref.current!;
    for (const o of [stage.current, d.querySelector('.fv-top'), d.querySelector('.fv-foot')]) if (o) ro.observe(o);
    return () => ro.disconnect();
  }, []);

  // A fresh page starts at the top, with focus back on the stage so the keys keep working.
  const reset = () => {
    setShown(false);
    setHeight(0);
    picked.current = null;
    frameLeft.current = 0;
    setPill(null);
    stage.current?.scrollTo(0, 0);
    stage.current?.focus({ preventScroll: true });
  };
  // Paging stops at the ends; wrapping from the last page back to P1 reads as a glitch.
  const go = (k: number) => {
    if (!n || k < 0 || k >= n || k === i) return;
    reset();
    setI(k);
  };
  const place = () => {
    const p = picked.current;
    const f = frame.current?.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    if (!p || !f || !box) return setPill(null);
    const k = scale.current;
    setPill({ left: Math.max(12, Math.min(f.left - box.left + p.x * k - 60, box.width - 150)), top: Math.min(f.top - box.top + p.y * k + 8, box.height - 100) });
  };
  const toChat = () => {
    const p = picked.current;
    if (!p || !page) return;
    const quote = p.text.replace(/\n{3,}/g, '\n\n').split('\n').map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>')).join('\n');
    if (!appendComposer(`From the replay "${info?.title ?? 'Replay'}", ${page.id} · ${page.title}:\n${quote}\n\n`)) return;
    frame.current?.contentWindow?.postMessage({ replayClear: 1 }, '*');
    setAdded(true);
  };

  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => {
      setAdded(false);
      picked.current = null;
      setPill(null);
    }, ADDED_MS);
    return () => clearTimeout(t);
  }, [added]);
  const replay = () => {
    reset();
    setRun(run + 1);
  };
  const onKey = (key: string) => {
    if (key === 'n' || key === 'ArrowRight') go(i + 1);
    else if (key === 'p' || key === 'ArrowLeft') go(i - 1);
    else if (key === 'r') replay();
    else if (key === 'Escape') openReplay(null);
    else return false;
    return true;
  };

  const onMessage = useEffectEvent((e: MessageEvent) => {
    if (!frame.current || e.source !== frame.current.contentWindow || e.data?.replay !== 1) return;
    if (typeof e.data.h === 'number' && e.data.h > 0) setHeight(Math.min(MAX_H, Math.ceil(e.data.h)));
    else if (typeof e.data.key === 'string') onKey(e.data.key);
    else if (typeof e.data.sel === 'string' && !added) {
      picked.current = e.data.sel ? { text: e.data.sel, x: Number(e.data.x) || 0, y: Number(e.data.y) || 0 } : null;
      place();
    } else if (e.data.quizDraft && typeof e.data.quizDraft === 'object' && page && view) {
      const d = Object.entries(e.data.quizDraft as Record<string, unknown>).slice(0, QUIZ_MAX)
        .filter((kv): kv is [string, string] => QUIZ_ID.test(kv[0]) && typeof kv[1] === 'string');
      drafts.current.set(`${view.key}:${page.id}`, Object.fromEntries(d.map(([id, v]) => [id, v.slice(0, QUIZ_OPEN_MAX)])));
    } else if (e.data.quiz && typeof e.data.quiz === 'object' && page && view) {
      // Only after the user worked in the page (it has or just had focus), so a page cannot fill the composer on its own.
      const touched = document.activeElement === frame.current || performance.now() - frameLeft.current < QUIZ_FOCUS_MS;
      const answers = quizAnswers(e.data.quiz.answers);
      const text = quizText(title, `${page.id} · ${page.title}`, info?.quiz, answers);
      const sent = touched && answers.length > 0 && (`${view.key}:${page.id}\n${text}` === lastQuiz.current || appendComposer(text));
      if (sent) lastQuiz.current = `${view.key}:${page.id}\n${text}`;
      // The page shows the outcome itself, next to the button that sent it; a refusal is said too, never silent.
      frame.current.contentWindow?.postMessage({ replayQuiz: sent ? 'sent' : touched && answers.length ? 'failed' : 'refused' }, '*');
    }
  });
  const left = () => {
    frameLeft.current = performance.now();
  };
  // A remounted page (paging back, r) gets its quiz draft back.
  const loaded = () => {
    setShown(true);
    const d = view && page ? drafts.current.get(`${view.key}:${page.id}`) : undefined;
    if (d) frame.current?.contentWindow?.postMessage({ replayQuizDraft: d }, '*');
  };
  useEffect(() => {
    const on = (e: MessageEvent) => onMessage(e);
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);

  // Every page takes the whole stage width; its own CSS decides how to use it.
  const width = page ? Math.max(320, room) : 0;
  // Narrow windows keep the page's own canvas and scale it to fit the stage, instead of reflowing it to a sliver.
  const k = page && isNarrow() && room > 0 && roomH > 0 ? Math.min(1, room / page.width, roomH / page.height) : 1;
  useEffect(() => {
    scale.current = k;
  }, [k]);
  const frameH = height || page?.height || 0;
  return (
    <dialog
      className="rp" ref={ref} aria-label={info?.title ? `Replay: ${info.title}` : 'Replay'}
      // closedby is not in React's types yet; Esc and backdrop clicks close it.
      {...{ closedby: 'any' }}
      onClose={() => {
        openReplay(null);
        const b = back.current;
        back.current = null;
        if (b instanceof HTMLElement && b.isConnected) b.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' && onKey(e.key)) e.preventDefault();
      }}
    >
      <ViewerChrome
        kind="replay" label={title} onClose={() => openReplay(null)}
        extra={page && <span className="rp-pt" title={`${page.id} · ${page.title}`}>{page.id} · {page.title}</span>}
        tools={view && <ReplayListen key={view.key} replayKey={view.key} />}
        acts={
          <>
            <button type="button" className="fv-ic" onClick={replay} aria-label="Replay the page animation" title="Replay the page animation (r)">{REPLAY_ICON}</button>
            {png && <SendImageBtn icon key={png} className="fv-ic" src={() => sign(png)} name={`${title} ${page!.id}`} />}
            {/* The page's own URL serves it with its file:// links rewritten, so the tab needs no copy. */}
            {page && <OpenTabBtn className="fv-ic" page={() => ({ url: pageTabUrl(page.url, themed) })} />}
          </>
        }
        foot={
          <>
            <span className="rp-pos"><b>{n ? i + 1 : 0}</b> / {n}</span>
            {n > 1 && n <= SEG_MAX && (
              <span className="rp-seg" role="group" aria-label="Pages">
                {pages.map((p, k2) => (
                  <button key={k2} type="button" className={k2 < i ? 'past' : undefined} aria-current={k2 === i ? 'page' : undefined} aria-label={`${p.id} · ${p.title}`} title={`${p.id} · ${p.title}`} onClick={() => go(k2)}><i /></button>
                ))}
              </span>
            )}
            <button type="button" className="fv-ic rp-prev" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous page" title="Previous page (p)">{PREV_ICON}</button>
            {i < n - 1 ? (
              <button type="button" className="rp-next" onClick={() => go(i + 1)} title="Next page (n)">Next{NEXT_ICON}</button>
            ) : (
              <button type="button" className="rp-next" onClick={() => openReplay(null)} title="Close (Esc)">Done</button>
            )}
          </>
        }
      >
        <div className="rpstage" ref={stage} tabIndex={-1} onScroll={() => picked.current && place()}>
          {page && view && doc?.error && <div className="vmsg bad">{doc.error}</div>}
          {page && view && doc?.html && (k < 1 ? (
            <div className="rp-fit" style={{ width: page.width * k, height: frameH * k }}>
              <iframe
                key={`${view.key}:${i}:${run}`} ref={frame} sandbox="allow-scripts" title="Replay page" srcDoc={doc.html} onLoad={loaded} onBlur={left}
                data-themed={themed ? '' : undefined} style={{ width: page.width, height: frameH, transform: `scale(${k})`, opacity: shown || reduceMotion() ? 1 : 0 }}
              />
            </div>
          ) : (
            <iframe
              key={`${view.key}:${i}:${run}`} ref={frame} sandbox="allow-scripts" title="Replay page" srcDoc={doc.html} onLoad={loaded} onBlur={left}
              data-themed={themed ? '' : undefined} style={{ width, height: height || page.height, opacity: shown || reduceMotion() ? 1 : 0 }}
            />
          ))}
        </div>
        {pill && (
          <button type="button" className="xbtn rp-send" style={{ left: pill.left, top: pill.top }} onClick={toChat} title="Quote it in your message">
            <SendIcon />
            <span aria-live="polite">{added ? 'Added' : 'Send to chat'}</span>
          </button>
        )}
      </ViewerChrome>
    </dialog>
  );
}
