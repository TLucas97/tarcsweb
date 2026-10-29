import { useEffect, useRef, useState, type RefObject } from 'react';
import { CodeFrame, CopyBtn } from './Code.tsx';
import { FxBtn } from './Focus.tsx';
import { hash, idle } from './highlight.ts';
import { watchNear } from './near.ts';
import { fenced, SendTextBtn } from './SendToChat.tsx';

// A drawn figure's markup, or why it could not be drawn.
type Out = { html: string } | { error: string };
type Cache = ReturnType<typeof lru>;

// Markup by source, bounded by entries and total length: conversation rows remount as the window shifts.
function lru(max: number, chars: number) {
  const map = new Map<string, Out>();
  let size = 0;
  const len = (o: Out) => ('html' in o ? o.html : o.error).length;
  return {
    get(key: string) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set(key: string, out: Out) {
      // One entry over a quarter of the budget would evict everything else.
      if (map.has(key) || len(out) > chars / 4) return;
      map.set(key, out);
      size += len(out);
      for (const [k, v] of map) {
        if (map.size <= max && size <= chars) break;
        map.delete(k);
        size -= len(v);
      }
    },
  };
}

// A finished block's figure: cached markup on the first frame of a remount, else drawn once the block nears the viewport.
// A renderer that failed to load is not cached, so the next mount tries again.
function useFigure(box: RefObject<HTMLDivElement | null>, cache: Cache, src: string, done: boolean, draw: (src: string) => Promise<Out>) {
  const key = done ? `${src.length}:${hash(src)}` : null;
  const [got, setGot] = useState<{ key: string; out: Out } | null>(null);
  const out = key === null ? null : got?.key === key ? got.out : cache.get(key);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (key === null || out || near) return;
    return watchNear(box.current!, () => setNear(true));
  }, [box, key, out, near]);

  useEffect(() => {
    if (key === null || out || !near) return;
    let stop = false;
    draw(src)
      .then((o) => (cache.set(key, o), o), (): Out => ({ error: 'the renderer did not load' }))
      .then((o) => !stop && setGot({ key, out: o }));
    return () => {
      stop = true;
    };
  }, [cache, draw, src, key, out, near]);
  return out;
}

// Lexend is the UI font; pele measures labels on a canvas, so it must be loaded before the first diagram.
const FONT = '"Lexend","Atkinson Hyperlegible",system-ui,sans-serif';
let pele: Promise<[typeof import('pele/lazy'), typeof import('dompurify').default]> | null = null;
const diagrams = lru(80, 3_000_000);

async function drawDiagram(src: string): Promise<Out> {
  pele ??= Promise.all([import('pele/lazy'), import('dompurify'), document.fonts.load('16px Lexend')]).then(([m, p]) => [m, p.default] as const, (e: unknown) => {
    pele = null;
    throw e;
  });
  const [{ renderAsync, PeleError }, purify] = await pele;
  await idle();
  try {
    // pele escapes labels and drops links and images; DOMPurify is the second line in case it ever misses one.
    const { svg } = await renderAsync(src, { fontFamily: FONT, links: false, images: false });
    return { html: purify.sanitize(svg, { USE_PROFILES: { svg: true } }) };
  } catch (e) {
    if (!(e instanceof PeleError)) throw e;
    return { error: e.message.split('\n')[0].replace(/:$/, '') };
  }
}

// A ```mermaid fence: its source in a code frame while it streams or loads, then the diagram. Colors are CSS variables
// (styles.css), so the cached markup serves both themes.
export function MermaidFrame({ code, done }: { code: string; done: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const out = useFigure(box, diagrams, code, done, drawDiagram);
  return (
    <div className="mdf" ref={box}>
      {out && 'html' in out ? (
        <div className="frame mdf-dia">
          <div className="fh">
            <span className="n mono">mermaid</span>
            <SendTextBtn text={() => fenced(code, 'mermaid')} what="the diagram" />
            <CopyBtn code={code} />
            <FxBtn label="Diagram" />
          </div>
          <div className="mdf-svg" dangerouslySetInnerHTML={{ __html: out.html }} />
        </div>
      ) : (
        <>
          <CodeFrame code={code} lang="mermaid" done={done} />
          {out && <p className="mdf-err">Could not draw the diagram: {out.error}</p>}
        </>
      )}
    </div>
  );
}

let katex: Promise<typeof import('./tex.ts')> | null = null;
const formulas = lru(400, 2_000_000);

async function drawMath(src: string): Promise<Out> {
  katex ??= import('./tex.ts').catch((e: unknown) => {
    katex = null;
    throw e;
  });
  return { html: (await katex).typeset(src) };
}

// Display math from a ```math fence or a $$ block: the TeX in a code frame while it streams or loads, then the formula.
export function MathFrame({ tex, done }: { tex: string; done: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const out = useFigure(box, formulas, tex, done, drawMath);
  return (
    <div className="mdf" ref={box}>
      {out && 'html' in out ? (
        <div className="mdf-math" dangerouslySetInnerHTML={{ __html: out.html }} />
      ) : (
        <>
          <CodeFrame code={tex} lang="math" done={done} />
          {out && <p className="mdf-err">Could not draw the formula: {out.error}</p>}
        </>
      )}
    </div>
  );
}
