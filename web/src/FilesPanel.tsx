import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { create } from 'zustand';
import { currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { useFocus, closeFocus } from './Focus.tsx';
import { useTree } from './tree.ts';
import { FileIcon, filesOpen, listDir, revealFile, selectFile } from './FileTree.tsx';
import { cached, highlight, langOf, type Token } from './highlight.ts';
import { baseName, CopyBtn, useEscape } from './bits.tsx';
import { appendComposer } from './PluginBand.tsx';
import { TreeMenu, type MenuAt, type MenuItem } from './TreeMenu.tsx';
import { sign } from './LocalImage.tsx';
import { openImage } from './openImage.ts';
import { SendImageBtn } from './SendToChat.tsx';
import type { TreeEntry } from '../../server/protocol.ts';

// Shiki runs on the main thread, so bigger files stay plain.
const HL_MAX = 256 << 10;
const HL_LINES = 3000;
// The viewer renders lines in blocks the browser can skip while they are off screen.
const BLOCK = 200;
const FIND_DEBOUNCE_MS = 120;

const noise = (name: string) => name.startsWith('.') || name === 'node_modules';
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
// Counts lines only up to the cap, so a huge file is not split twice.
const colorable = (text: string) => {
  if (text.length > HL_MAX) return false;
  for (let i = 0, n = 0; (i = text.indexOf('\n', i) + 1) > 0; ) if (++n >= HL_LINES) return false;
  return true;
};

function langFor(path: string) {
  const b = (path.split('/').pop() ?? '').toLowerCase();
  if (b === 'dockerfile' || b.startsWith('dockerfile.')) return 'docker';
  return b.includes('.') ? langOf(b.slice(b.lastIndexOf('.') + 1)) : null;
}

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

function toggle(path: string) {
  const open = { ...useTree.getState().open };
  if (open[path]) delete open[path];
  else {
    open[path] = true;
    listDir(path);
  }
  useTree.setState({ open });
}

// The right-click menu and the short "Copied" tag on a row.
type Menu = { at: MenuAt; caption: string; items: MenuItem[]; target?: string };
const useUi = create<{ menu: Menu | null; copied: string | null }>(() => ({ menu: null, copied: null }));
let copiedTimer = 0;

// Claude Code's file mention; quoted when the path has spaces, folders end in a slash.
const mention = (rel: string, dir: boolean) => {
  const p = dir ? `${rel}/` : rel;
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
};

// Closes the panel, then appends to the composer once the focus view has handed focus back.
function sendToChat(text: string) {
  getSelection()?.removeAllRanges();
  if (!filesOpen()) return void appendComposer(text);
  const off = useFocus.subscribe((s) => {
    if (s.view) return;
    off();
    requestAnimationFrame(() => appendComposer(text));
  });
  closeFocus();
}

function copyPath(rel: string) {
  void navigator.clipboard?.writeText(rel).then(() => {
    useUi.setState({ copied: rel });
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => useUi.setState({ copied: null }), 1400);
  });
}

// Keyboard menus (Shift+F10, the menu key) open under the element instead of at the pointer.
function menuAt(e: MouseEvent<HTMLElement>): MenuAt {
  if (e.button === 2) return { x: e.clientX, y: e.clientY, kbd: false };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + 24, y: r.bottom, kbd: true };
}

function rowMenu(e: MouseEvent<HTMLElement>, rel: string, dir: boolean) {
  e.preventDefault();
  const ref = mention(rel, dir);
  useUi.setState({
    menu: {
      at: menuAt(e), caption: ref, target: rel,
      items: [{ label: 'Send to chat', run: () => sendToChat(`${ref} `) }, { label: 'Copy path', run: () => copyPath(rel) }],
    },
  });
}

function MenuHost() {
  const menu = useUi((s) => s.menu);
  if (!menu) return null;
  return <TreeMenu key={`${menu.at.x},${menu.at.y},${menu.caption}`} at={menu.at} caption={menu.caption} items={menu.items} onClose={() => useUi.setState({ menu: null })} />;
}

function Folder({ path, depth }: { path: string; depth: number }) {
  const dir = useTree((s) => s.dirs[path]);
  const hidden = useTree((s) => s.hidden);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (!dir || dir === 'loading') return <div className="ft-note" style={pad}>Loading…</div>;
  if ('error' in dir) return <div className="ft-note bad" style={pad}>{dir.error}</div>;
  const shown = hidden ? dir.entries : dir.entries.filter((e) => !noise(e.name));
  if (!shown.length) return <div className="ft-note" style={pad}>{dir.entries.length ? 'Only hidden files' : 'Empty folder'}</div>;
  return (
    <>
      {shown.map((e) => <Row key={e.name} path={join(path, e.name)} e={e} depth={depth} />)}
      {dir.more > 0 && <div className="ft-note" style={pad}>{dir.more} more not shown</div>}
    </>
  );
}

// Each row subscribes to its own path, so opening a folder or moving the selection re-renders only the rows it touches.
const Row = memo(function Row({ path: p, e, depth }: { path: string; e: TreeEntry; depth: number }) {
  const on = useTree((s) => !!s.open[p]);
  const sel = useTree((s) => s.selected === p);
  const ctx = useUi((s) => s.menu?.target === p);
  const copied = useUi((s) => s.copied === p);
  return (
    <div role="none">
      <button
        className={`ft-row${e.dir ? ' dir' : ''}${sel ? ' sel' : ''}${noise(e.name) || e.ignored ? ' dim' : ''}${ctx ? ' ctx' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }} title={`${p}${e.link ? ' (link)' : ''}${e.ignored ? ' · ignored by git' : ''}`} role="treeitem"
        aria-expanded={e.dir ? on : undefined} aria-selected={sel}
        onClick={() => (e.dir ? toggle(p) : selectFile(p))}
        onContextMenu={(ev) => rowMenu(ev, p, e.dir)}
      >
        <FileIcon name={e.name} dir={e.dir} open={on} />
        <span className="ft-name">{e.name}</span>
        {e.link && <span className="ft-link">↗</span>}
        {copied && <span className="ft-tag" role="status">Copied</span>}
      </button>
      {e.dir && on && <div role="group"><Folder path={p} depth={depth + 1} /></div>}
    </div>
  );
});

// Go to file: matching paths from the server's cached file list (git's own when the folder is a repo).
function FindBox() {
  const [q, setQ] = useState('');
  useEscape(!!q, () => setQ(''));
  useEffect(() => {
    const t = q.trim();
    if (!t) {
      if (useTree.getState().find) useTree.setState({ find: null });
      return;
    }
    const id = setTimeout(() => {
      const { sessionId, find } = useTree.getState();
      if (!sessionId) return;
      // The last answer stays up until the new one lands.
      useTree.setState({ find: { query: t, found: find?.found ?? null, ...(find?.found ? { stale: true as const } : {}) } });
      send({ type: 'tree-find', sessionId, query: t });
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => () => useTree.setState({ find: null }), []);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const find = useTree.getState().find;
    // Only an answer to what is typed now; Enter mid-debounce or mid-request does nothing.
    const f = find && !find.stale && find.query === q.trim() ? find.found : null;
    const first = f && 'paths' in f ? f.paths[0] : null;
    if (first) revealFile(first);
  };
  return (
    <input
      className="ft-find" type="search" placeholder="Go to file" aria-label="Go to file" spellCheck={false} autoComplete="off"
      value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
    />
  );
}

function Found() {
  const find = useTree((s) => s.find);
  const selected = useTree((s) => s.selected);
  if (!find) return null;
  const f = find.found;
  if (!f) return <div className="ft-note" style={{ paddingLeft: 8 }}>Searching…</div>;
  if ('error' in f) return <div className="ft-note bad" style={{ paddingLeft: 8 }}>{f.error}</div>;
  if (!f.paths.length) return <div className="ft-note" style={{ paddingLeft: 8 }}>No matching files</div>;
  return (
    <>
      {f.paths.map((p) => {
        const cut = p.lastIndexOf('/');
        const name = p.slice(cut + 1);
        return (
          <button
            key={p} className={`ft-row${p === selected ? ' sel' : ''}`} style={{ paddingLeft: 8 }} title={p} role="treeitem" aria-selected={p === selected}
            onClick={() => revealFile(p)} onContextMenu={(ev) => rowMenu(ev, p, false)}
          >
            <FileIcon name={name} dir={false} open={false} />
            <span className="ft-name">{name}</span>
            {cut > 0 && <span className="ft-dir">{p.slice(0, cut)}</span>}
          </button>
        );
      })}
      {f.more && <div className="ft-note" style={{ paddingLeft: 8 }}>Type more to narrow it down</div>}
    </>
  );
}

// Lines are plain divs in blocks of BLOCK; content-visibility skips off-screen blocks. Numbers come from data-n.
const Lines = memo(function Lines({ lines, hit }: { lines: Token[][]; hit: number | null }) {
  const blocks = [];
  for (let from = 0; from < lines.length; from += BLOCK) {
    const mine = hit !== null && hit > from && hit <= from + BLOCK ? hit : null;
    blocks.push(<Block key={from} lines={lines} from={from} hit={mine} />);
  }
  return <>{blocks}</>;
});

const Block = memo(function Block({ lines, from, hit }: { lines: Token[][]; from: number; hit: number | null }) {
  const rows = lines.slice(from, from + BLOCK);
  return (
    <div className="ft-blk" style={{ '--n': rows.length } as CSSProperties}>
      {rows.map((ln, k) => {
        const n = from + k + 1;
        return (
          <div key={k} data-n={n} className={n === hit ? 'ft-hit' : undefined}>
            {ln.length && ln.some((t) => t.content) ? ln.map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : ' '}
          </div>
        );
      })}
    </div>
  );
});

function Code({ path, text, line }: { path: string; text: string; line: number | null }) {
  // Selection changes re-render this, so whole-file work runs once per file; one key string keeps the hl check a pointer compare.
  const plain = useMemo(() => text.split('\n'), [text]);
  const { lang, key, warm } = useMemo(() => {
    const lang = colorable(text) ? langFor(path) : null;
    return { lang, key: lang ? `${lang}\u0000${text}` : '', warm: lang ? cached(text, lang) : null };
  }, [text, path]);
  const [hl, setHl] = useState<{ key: string; lines: Token[][] } | null>(null);
  const ready = lang ? (hl?.key === key ? hl.lines : warm) : null;
  const plainLines = useMemo(() => plain.map((content) => [{ content }]), [plain]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lang || ready) return;
    let on = true;
    highlight(text, lang).then((lines) => on && lines && setHl({ key, lines }), () => {});
    return () => {
      on = false;
    };
  }, [key, lang, text, ready]);

  // A link's line goes to the middle of the view; a plain pick starts at the top. Skipped blocks above it have only an
  // estimated height, so the next frame corrects the spot once they rendered.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const center = () => {
      const hit = line ? el.querySelector<HTMLElement>('.ft-hit') : null;
      el.scrollTop = hit ? hit.offsetTop - el.clientHeight / 2 : 0;
    };
    center();
    el.scrollLeft = 0;
    if (!line) return;
    const f = requestAnimationFrame(center);
    return () => cancelAnimationFrame(f);
  }, [path, text, line]);

  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const menuUp = useUi((s) => !!s.menu);
  const src = useRef({ plain, path });
  useLayoutEffect(() => {
    src.current = { plain, path };
  });

  // The Send button follows a selection made inside the code, like Explain does in the chat.
  useEffect(() => {
    const el = box.current!;
    let down = false;
    let timer = 0;
    let frame = 0;
    const check = () => setSpot(selectionSpot(el));
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(check, ms);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element | null)?.closest?.('.ft-send')) return;
      down = true;
      setSpot(null);
    };
    const onUp = () => {
      down = false;
      later(0);
    };
    const onSelect = () => !down && later(150);
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', onSelect);
    el.addEventListener('scroll', onScroll);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('selectionchange', onSelect);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  const quote = () => {
    const q = quoteOf(box.current!, src.current.plain);
    return q && { ...q, ref: `${src.current.path}:L${q.from}${q.to > q.from ? `-${q.to}` : ''}` };
  };
  const sendQuote = () => {
    const q = quote();
    if (q) sendToChat(fenced(q.ref, q.text, langFor(src.current.path) ?? ''));
  };
  const onMenu = (e: MouseEvent<HTMLDivElement>) => {
    const q = quote();
    // Without a selection the browser's own menu stays.
    if (!q) return;
    e.preventDefault();
    setSpot(null);
    useUi.setState({
      menu: {
        at: menuAt(e), caption: q.ref,
        items: [{ label: 'Send to chat', run: sendQuote }, { label: 'Copy', run: () => void navigator.clipboard?.writeText(q.text) }],
      },
    });
  };

  return (
    <>
      <div className="ft-code code mono" ref={box} style={{ '--dg': String(plain.length).length } as CSSProperties} onContextMenu={onMenu}>
        <Lines lines={ready ?? plainLines} hit={line} />
      </div>
      {spot && !menuUp && (
        <button className="xbtn ft-send" style={spot} onPointerDown={(e) => e.preventDefault()} onClick={sendQuote}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          Send to chat
        </button>
      )}
    </>
  );
}

const SEND_W = 124;

// Under the selection's end, or above its start when that would leave the code box.
function selectionSpot(box: HTMLElement) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  if (!box.contains(range.startContainer) || !box.contains(range.endContainer)) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  const b = box.getBoundingClientRect();
  if (last.bottom < b.top || first.top > b.bottom) return null;
  const below = last.bottom + 8;
  const top = below + 32 < b.bottom ? below : Math.max(b.top + 4, first.top - 40);
  return { left: Math.max(b.left + 4, Math.min(last.right - SEND_W / 2, b.right - SEND_W - 4)), top };
}

const indexIn = (parent: Node, child: Node) => Array.prototype.indexOf.call(parent.childNodes, child) as number;

// Line and column of a selection edge, counted on the file text (line numbers are CSS, not text). The box holds
// blocks of BLOCK line divs; an edge on the box or a block counts in whole lines.
function edgeOf(box: HTMLElement, node: Node, offset: number, end: boolean): [number, number] | null {
  const lineAt = (n: number): [number, number] => (end ? [Math.max(0, n - 1), Infinity] : [n, 0]);
  if (node === box) return lineAt(offset * BLOCK);
  if (node.parentNode === box) return lineAt(indexIn(box, node) * BLOCK + offset);
  let el: Node | null = node;
  while (el && el.parentNode?.parentNode !== box) el = el.parentNode;
  if (!el?.parentNode) return null;
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return [indexIn(box, el.parentNode) * BLOCK + indexIn(el.parentNode, el), r.toString().length];
}

function quoteOf(box: HTMLElement, plain: string[]) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return null;
  const a = edgeOf(box, r.startContainer, r.startOffset, false);
  const b = edgeOf(box, r.endContainer, r.endOffset, true);
  if (!a || !b) return null;
  let [s, so] = a;
  let [e, eo] = b;
  // A triple click ends at the start of the next line; that line is not part of it.
  if (e > s && eo === 0) [e, eo] = [e - 1, Infinity];
  if (s >= plain.length) return null;
  e = Math.min(e, plain.length - 1);
  so = Math.min(so, plain[s].length);
  const text = s === e ? plain[s].slice(so, eo) : [plain[s].slice(so), ...plain.slice(s + 1, e), plain[e].slice(0, eo)].join('\n');
  return text.trim() ? { from: s + 1, to: e + 1, text: text.replace(/\r$/gm, '') } : null;
}

// The fence grows past any backtick run inside the text, so the quote never closes early.
function fenced(ref: string, text: string, lang: string) {
  const run = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, run + 1));
  return `${ref}\n${fence}${lang}\n${text}\n${fence}\n`;
}

const RASTER = /\.(png|jpe?g|gif|webp)$/i;

// Raster images are binary to the tree, so they show through the server's signed image URL instead.
function TreeImage({ path }: { path: string }) {
  const cwd = useStore((s) => currentSummary(s)?.cwd ?? '');
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    void sign(`${cwd.replace(/\/$/, '')}/${path}`).then((u) => live && setSrc(u));
    return () => { live = false; };
  }, [cwd, path]);
  if (src === undefined) return <div className="ft-empty"><span className="spin"></span></div>;
  if (src === null) return <div className="ft-empty">This image could not be opened.</div>;
  const name = path.split('/').pop() || 'Image';
  return (
    <div className="ft-img">
      <span className="stc-host">
        <img src={src} alt={name} onClick={(e) => openImage(e)} />
        <SendImageBtn src={src} name={name} className="stc-float" />
      </span>
    </div>
  );
}

function Viewer() {
  const path = useTree((s) => s.selected);
  const line = useTree((s) => s.line);
  const file = useTree((s) => s.file);
  if (!path) return <div className="ft-empty">Pick a file to read it here</div>;
  const body =
    !file || file === 'loading' ? <div className="ft-empty"><span className="spin"></span></div>
    : file.error ? <div className="ft-empty">{file.error}</div>
    : file.binary && RASTER.test(path) ? <TreeImage path={path} />
    : file.binary ? <div className="ft-empty">Binary file, {size(file.size)}. Not shown.</div>
    : file.tooLarge ? <div className="ft-empty">Too large to show ({size(file.size)}). Files up to 1 MB open here.</div>
    : <Code path={path} text={file.text ?? ''} line={line} />;
  const text = file && file !== 'loading' && file.text !== null ? file.text : null;
  return (
    <>
      <div className="ft-head fh">
        <span className="ft-path mono" title={path}>{path}</span>
        {file && file !== 'loading' && !file.error && <span className="ft-size">{size(file.size)}{text !== null && langFor(path) && !colorable(text) ? ' · too big to color' : ''}</span>}
        <span className="sp"></span>
        <button className="btnx" title="Read the file again" onClick={() => selectFile(path, line)}>Reload</button>
        {text !== null && <CopyBtn text={text} what="file" />}
      </div>
      {body}
    </>
  );
}

export default function FilesPanel() {
  const hidden = useTree((s) => s.hidden);
  const finding = useTree((s) => !!s.find);
  const folder = useStore((s) => baseName(currentSummary(s)?.cwd ?? ''));
  useEffect(() => () => useUi.setState({ menu: null }), []);
  return (
    <div className="ft">
      <nav className="ft-side" aria-label="Files">
        <div className="ft-bar">
          <span className="ft-root" title={folder}>{folder}</span>
          <button className="ft-tog" aria-pressed={hidden} title="Show dotfiles, .git and node_modules" onClick={() => useTree.setState({ hidden: !hidden })}>
            Hidden
          </button>
          <button className="ft-tog" title="Collapse all folders" onClick={() => useTree.setState({ open: {} })}>Collapse</button>
        </div>
        <div className="ft-findbar"><FindBox /></div>
        <div className="ft-list" role="tree" aria-label={folder}>{finding ? <Found /> : <Folder path="" depth={0} />}</div>
      </nav>
      <section className="ft-view" aria-label="File">
        <Viewer />
      </section>
      <MenuHost />
    </div>
  );
}
