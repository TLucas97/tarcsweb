import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { create } from 'zustand';
import { currentSummary, useStore } from './store.ts';
import { send } from './socket.ts';
import { closeFocus, openPanel, useFocus } from './Focus.tsx';
import { bindTree, useTree } from './tree.ts';
import { cached, highlight, langOf, type Token } from './highlight.ts';
import { baseName, CopyBtn, tilde } from './bits.tsx';
import { appendComposer } from './PluginBand.tsx';
import { TreeMenu, type MenuAt, type MenuItem } from './TreeMenu.tsx';
import { sign } from './LocalImage.tsx';
import { openImage } from './ImageViewer.tsx';
import { SendImageBtn } from './SendToChat.tsx';
import { isDark, onTheme } from './theme.ts';

const KEY = 'files';
// Shiki runs on the main thread, so bigger files stay plain.
const HL_MAX = 256 << 10;
const HL_LINES = 3000;

const noise = (name: string) => name.startsWith('.') || name === 'node_modules';
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentsOf = (rel: string) => rel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));
const isOpen = () => {
  const v = useFocus.getState().view;
  return v?.mode === 'panel' && v.key === KEY;
};
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

function list(path: string) {
  const { sessionId, dirs } = useTree.getState();
  if (!sessionId) return;
  // Re-listed on every expand so new files show up; the old entries stay until the answer lands.
  const d = dirs[path];
  if (!d || (d !== 'loading' && 'error' in d)) useTree.setState((s) => ({ dirs: { ...s.dirs, [path]: 'loading' } }));
  send({ type: 'tree-list', sessionId, path });
}

function toggle(path: string) {
  const open = { ...useTree.getState().open };
  if (open[path]) delete open[path];
  else {
    open[path] = true;
    list(path);
  }
  useTree.setState({ open });
}

function select(path: string, line: number | null = null) {
  const { sessionId } = useTree.getState();
  if (!sessionId) return;
  useTree.setState({ selected: path, line, file: 'loading' });
  send({ type: 'tree-read', sessionId, path });
}

// Path relative to the session folder; null when it points elsewhere.
function relOf(cwd: string, path: string) {
  let p = path.trim().replace(/^file:\/\//, '');
  if (p.startsWith('/')) {
    if (p === cwd) return '';
    if (!p.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return null;
    p = p.slice(cwd.length);
  }
  const parts = p.split('/').filter((s) => s && s !== '.');
  return parts.includes('..') ? null : parts.join('/');
}

function show(from: Element) {
  const s = useStore.getState();
  const summary = currentSummary(s);
  if (!summary) return;
  openPanel({ key: KEY, label: tilde(summary.cwd, s.home), body: <FilesPanel />, foot: 'read only' }, from);
}

// Opens the tree on a file of the current session, unfolding its folders; meant for file:line links later.
export function openFile(path: string, line?: number, from?: Element) {
  const s = useStore.getState();
  const summary = currentSummary(s);
  if (!s.current || !summary) return false;
  const rel = relOf(summary.cwd, path);
  if (rel === null || !rel) return false;
  bindTree(s.current);
  prefetchIcons();
  const open = { ...useTree.getState().open };
  for (const dir of parentsOf(rel)) {
    if (!open[dir]) list(dir);
    open[dir] = true;
  }
  useTree.setState({ open });
  if (!useTree.getState().dirs['']) list('');
  select(rel, line && line > 0 ? Math.floor(line) : null);
  if (!isOpen()) {
    closeFocus(true);
    show(from ?? document.querySelector('.ft-open') ?? document.body);
  }
  return true;
}

// Icons come from a lazy chunk (the icon theme's lookup tables); each SVG loads the first time a row shows it.
type IconMod = typeof import('./fileIcons.ts');
const useIcons = create<{ mod: IconMod | null; urls: Record<string, string>; dark: boolean }>(() => ({ mod: null, urls: {}, dark: isDark() }));
onTheme(() => useIcons.setState({ dark: isDark() }));
let iconMod: Promise<unknown> | null = null;
const asked = new Set<string>();
const prefetchIcons = () => {
  iconMod ??= import('./fileIcons.ts').then((mod) => useIcons.setState({ mod }), () => {});
};

export function FileIcon({ name, dir, open }: { name: string; dir: boolean; open: boolean }) {
  const mod = useIcons((s) => s.mod);
  const dark = useIcons((s) => s.dark);
  const icon = mod ? mod.iconName(name, dir, open, dark) : null;
  const url = useIcons((s) => (icon ? s.urls[icon] : undefined));
  useEffect(() => {
    if (!mod) return prefetchIcons();
    if (!icon || asked.has(icon)) return;
    asked.add(icon);
    mod.iconUrl(icon).then((u) => u && useIcons.setState((s) => ({ urls: { ...s.urls, [icon]: u } })), () => {});
  }, [mod, icon]);
  return url ? <img className="ft-ic" src={url} alt="" draggable={false} /> : <span className="ft-ic" />;
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
  if (!isOpen()) return void appendComposer(text);
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

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 3.2h3.6l1.3 1.4h5.5v6.6H1.8z" /></svg>
);

// The trigger beside the session title.
export function FilesTrigger() {
  return (
    <button
      className="fnd-open ft-open" title="Browse files" aria-label="Browse the session's files"
      onPointerEnter={prefetchIcons}
      onClick={(e) => {
        const id = useStore.getState().current;
        if (!id) return;
        bindTree(id);
        list('');
        show(e.currentTarget);
      }}
    >
      <FolderIcon />
    </button>
  );
}

function Folder({ path, depth }: { path: string; depth: number }) {
  const dir = useTree((s) => s.dirs[path]);
  const open = useTree((s) => s.open);
  const selected = useTree((s) => s.selected);
  const hidden = useTree((s) => s.hidden);
  const ctx = useUi((s) => s.menu?.target);
  const copied = useUi((s) => s.copied);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (!dir || dir === 'loading') return <div className="ft-note" style={pad}>Loading…</div>;
  if ('error' in dir) return <div className="ft-note bad" style={pad}>{dir.error}</div>;
  const shown = hidden ? dir.entries : dir.entries.filter((e) => !noise(e.name));
  if (!shown.length) return <div className="ft-note" style={pad}>{dir.entries.length ? 'Only hidden files' : 'Empty folder'}</div>;
  return (
    <>
      {shown.map((e) => {
        const p = join(path, e.name);
        const on = !!open[p];
        return (
          <div key={e.name} role="none">
            <button
              className={`ft-row${e.dir ? ' dir' : ''}${p === selected ? ' sel' : ''}${noise(e.name) ? ' dim' : ''}${p === ctx ? ' ctx' : ''}`}
              style={pad} title={e.link ? `${p} (link)` : p} role="treeitem" aria-expanded={e.dir ? on : undefined} aria-selected={p === selected}
              onClick={() => (e.dir ? toggle(p) : select(p))}
              onContextMenu={(ev) => rowMenu(ev, p, e.dir)}
            >
              <FileIcon name={e.name} dir={e.dir} open={on} />
              <span className="ft-name">{e.name}</span>
              {e.link && <span className="ft-link">↗</span>}
              {copied === p && <span className="ft-tag" role="status">Copied</span>}
            </button>
            {e.dir && on && <div role="group"><Folder path={p} depth={depth + 1} /></div>}
          </div>
        );
      })}
      {dir.more > 0 && <div className="ft-note" style={pad}>{dir.more} more not shown</div>}
    </>
  );
}

const Lines = memo(function Lines({ lines, hit }: { lines: Token[][]; hit: number | null }) {
  return (
    <>
      {lines.map((ln, i) => (
        <div key={i} className={i + 1 === hit ? 'ft-hit' : undefined}>
          {ln.length && ln.some((t) => t.content) ? ln.map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : ' '}
        </div>
      ))}
    </>
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

  // A link's line goes to the middle of the view; a plain pick starts at the top.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const hit = line ? el.querySelector<HTMLElement>('.ft-hit') : null;
    el.scrollTop = hit ? hit.offsetTop - el.clientHeight / 2 : 0;
    el.scrollLeft = 0;
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

// Line and column of a selection edge, counted on the file text (line numbers are CSS, not text).
function edgeOf(box: HTMLElement, node: Node, offset: number, end: boolean): [number, number] | null {
  if (node === box) return end ? [Math.max(0, offset - 1), Infinity] : [offset, 0];
  let el: Node | null = node;
  while (el && el.parentNode !== box) el = el.parentNode;
  if (!el) return null;
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return [Array.prototype.indexOf.call(box.children, el), r.toString().length];
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
        <button className="btnx" title="Read the file again" onClick={() => select(path, line)}>Reload</button>
        {text !== null && <CopyBtn text={text} what="file" />}
      </div>
      {body}
    </>
  );
}

function FilesPanel() {
  const hidden = useTree((s) => s.hidden);
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
        <div className="ft-list" role="tree" aria-label={folder}><Folder path="" depth={0} /></div>
      </nav>
      <section className="ft-view" aria-label="File">
        <Viewer />
      </section>
      <MenuHost />
    </div>
  );
}
