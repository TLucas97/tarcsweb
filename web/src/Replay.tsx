import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { openReplay, useStore } from './store.ts';
import { reduceMotion } from './bits.tsx';
import { appendComposer } from './PluginBand.tsx';
import { SendIcon } from './SendToChat.tsx';
import { isNarrow } from './narrow.ts';
import { ReplayListen } from './Voice.tsx';
import { pageDoc, usePageDoc } from './replayDoc.ts';

// Past this many pages the segment bar gets too fine to click; the "3 / 9" count stays.
const SEG_MAX = 24;
const ADDED_MS = 1200;

// Tall enough for any real page; stops a page sized in vh from growing forever.
const MAX_H = 20000;
const PAD = 0;

// The replay viewer: one live page at a time at its own width (reflowed when the stage is narrower), scrolling in the stage.
export function ReplayViewer() {
  const view = useStore((s) => s.replayView);
  const info = useStore((s) => (s.replayView ? s.replays[s.replayView.key] : undefined));
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
  const pages = info?.pages ?? [];
  const n = pages.length;
  const page = pages[Math.min(i, n - 1)];
  const doc = usePageDoc(view ? page?.url : undefined);

  useEffect(() => {
    const d = ref.current!;
    if (view && !d.open) {
      setI(view.page);
      setHeight(0);
      d.showModal();
    } else if (!view && d.open) d.close();
  }, [view]);

  // Warm the next page only, so paging forward never waits and a long replay is not held whole in memory.
  useEffect(() => {
    const next = view ? pages[i + 1] : undefined;
    if (next) void pageDoc(next.url).catch(() => {});
  }, [view, pages, i]);

  useLayoutEffect(() => {
    const el = stage.current!;
    const fit = () => {
      setRoom(el.clientWidth - PAD * 2);
      setRoomH(el.clientHeight);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A fresh page starts at the top, with focus back on the stage so the keys keep working.
  const reset = () => {
    setShown(false);
    setHeight(0);
    picked.current = null;
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
    }
  });
  useEffect(() => {
    const on = (e: MessageEvent) => onMessage(e);
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);

  // Every page takes the stage width up to 1200px; the stylesheet reflows the old 880px canvas.
  const width = page ? Math.max(320, Math.min(1200, room)) : 0;
  // Narrow windows keep the page's own canvas and scale it to fit the stage, instead of reflowing it to a sliver.
  const k = page && isNarrow() && room > 0 && roomH > 0 ? Math.min(1, room / page.width, roomH / page.height) : 1;
  useEffect(() => {
    scale.current = k;
  }, [k]);
  const frameH = height || page?.height || 0;
  return (
    <dialog
      className="rp" ref={ref} aria-label="Replay"
      // closedby is not in React's types yet; Esc and backdrop clicks close it.
      {...{ closedby: 'any' }}
      onClose={() => openReplay(null)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' && onKey(e.key)) e.preventDefault();
      }}
    >
      <div className="rph">
        <span className="tool mono">replay</span>
        <b>{info?.title ?? 'Replay'}</b>
        {page && <span className="pt">{page.id} · {page.title}</span>}
        <span className="sp"></span>
        <button className="sh-x" aria-label="Close" onClick={() => openReplay(null)}><kbd>esc</kbd></button>
      </div>
      <div className="rpstage" ref={stage} tabIndex={-1} onScroll={() => picked.current && place()}>
        {page && view && doc?.error && <div className="vmsg bad">{doc.error}</div>}
        {page && view && doc?.html && (k < 1 ? (
          <div className="rp-fit" style={{ width: page.width * k, height: frameH * k }}>
            <iframe
              key={`${view.key}:${i}:${run}`} ref={frame} sandbox="allow-scripts" title="Replay page" srcDoc={doc.html} onLoad={() => setShown(true)}
              style={{ width: page.width, height: frameH, transform: `scale(${k})`, opacity: shown || reduceMotion() ? 1 : 0 }}
            />
          </div>
        ) : (
          <iframe
            key={`${view.key}:${i}:${run}`} ref={frame} sandbox="allow-scripts" title="Replay page" srcDoc={doc.html} onLoad={() => setShown(true)}
            style={{ width, height: height || page.height, opacity: shown || reduceMotion() ? 1 : 0 }}
          />
        ))}
      </div>
      {pill && (
        <button type="button" className="xbtn rp-send" style={{ left: pill.left, top: pill.top }} onClick={toChat} title="Quote it in your message">
          <SendIcon />
          <span aria-live="polite">{added ? 'Added' : 'Send to chat'}</span>
        </button>
      )}
      <div className="rpf">
        <span className="rp-pos"><b>{n ? i + 1 : 0}</b> / {n}</span>
        {n > 1 && n <= SEG_MAX && (
          <span className="rp-seg" role="group" aria-label="Pages">
            {pages.map((p, k2) => (
              <button key={k2} className={k2 < i ? 'past' : undefined} aria-current={k2 === i ? 'page' : undefined} aria-label={`${p.id} · ${p.title}`} title={`${p.id} · ${p.title}`} onClick={() => go(k2)}><i /></button>
            ))}
          </span>
        )}
        <span className="sp"></span>
        {view && <ReplayListen key={view.key} replayKey={view.key} />}
        <button className="rp-ic" onClick={replay} aria-label="Replay the page animation" title="Replay the page animation (r)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8" /><path d="M2.6 2.4v2.9h2.9" /></svg>
        </button>
        <button className="rp-ic" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous page" title="Previous page (p)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 8h-9M7 4 3 8l4 4" /></svg>
        </button>
        {i < n - 1 ? (
          <button className="rp-next" onClick={() => go(i + 1)} title="Next page (n)">
            Next
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8h9M9 4l4 4-4 4" /></svg>
          </button>
        ) : (
          <button className="rp-next" onClick={() => openReplay(null)} title="Close (esc)">Done</button>
        )}
      </div>
    </dialog>
  );
}
