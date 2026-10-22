import { ZOOM_MAX, ZOOM_MIN, type Camera } from './camera.ts';
import { restoreImage, sourceOf } from './images.ts';
import type { Scene } from './scene.ts';
import type { El, Kind } from './types.ts';

// The drawing and camera survive reloads in IndexedDB; undo history does not. Pictures sit in their own store,
// keyed by src, so a save writes only the ones that are new.

const DB = 'cw-board';
const DOCS = 'doc';
const IMAGES = 'images';
const KEY = 'current';
// Schema of the saved record; a record with another version is ignored.
const VERSION = 1;
const SAVE_DELAY_MS = 1000;
const IDLE_TIMEOUT_MS = 2000;
// Stored pictures beyond this are left out, largest first; their elements stay and draw as empty frames.
const IMAGE_BYTES_MAX = 64 << 20;
// Storage that does not answer by then is left alone for the page, so a saved drawing is never overwritten unseen.
const OPEN_TIMEOUT_MS = 3000;

const KINDS = new Set<Kind>(['stroke', 'rect', 'ellipse', 'line', 'arrow', 'poly', 'text', 'icon', 'image']);

type Doc = { scene: Scene; cam: Camera };
type Saved = { v: number; els: El[]; cam: { x: number; y: number; z: number } };

let doc: Doc | null = null;
let enabled = false;
let dirty = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let dbp: Promise<IDBDatabase> | null = null;
// A lifted lasso move or an open text edit holds elements outside the scene, so saves wait while it is true.
let busy: (() => boolean) | null = null;

export function saveGate(fn: (() => boolean) | null) {
  busy = fn;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((done, fail) => {
    r.onsuccess = () => done(r.result);
    r.onerror = () => fail(r.error);
  });

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise<IDBDatabase>((done, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(DOCS);
      r.result.createObjectStore(IMAGES);
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      done(r.result);
    };
    r.onerror = () => fail(r.error);
  });
  return dbp;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validEl(e: unknown): e is El {
  if (!e || typeof e !== 'object') return false;
  const o = e as Partial<El>, b = o.bbox;
  return typeof o.id === 'string' && finite(o.z) && KINDS.has(o.kind as Kind) && !!b && finite(b.x0) && finite(b.y0) && finite(b.x1) && finite(b.y1);
}

function parse(rec: unknown): Saved | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Partial<Saved>;
  if (r.v !== VERSION || !Array.isArray(r.els)) return null;
  return { v: VERSION, els: r.els.filter(validEl), cam: r.cam && finite(r.cam.x) && finite(r.cam.y) && finite(r.cam.z) ? r.cam : { x: 0, y: 0, z: 1 } };
}

async function load() {
  const db = await open();
  const tx = db.transaction([DOCS, IMAGES], 'readonly');
  const saved = parse(await req(tx.objectStore(DOCS).get(KEY)));
  if (!saved?.els.length) return null;
  const srcs = [...new Set(saved.els.flatMap((el) => (el.kind === 'image' ? [el.src] : [])))];
  const store = tx.objectStore(IMAGES);
  const blobs = await Promise.all(srcs.map((src) => req(store.get(src)).then((b) => [src, b] as const)));
  return { saved, blobs: blobs.filter((e): e is readonly [string, Blob] => e[1] instanceof Blob) };
}

function apply(d: Doc, saved: Saved) {
  // In paint order, so every insert lands at the end of the scene's list.
  d.scene.replace([], saved.els.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  d.cam.x = saved.cam.x;
  d.cam.y = saved.cam.y;
  d.cam.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, saved.cam.z));
}

async function decodeAll(blobs: readonly (readonly [string, Blob])[]) {
  for (const [src, blob] of blobs) await restoreImage(src, blob);
}

// Restores the saved drawing into `d`, then saves it after each change. Resolves once the board may show
// (also on failure or timeout); pictures decode afterwards and repaint as they land.
export function persist(d: Doc): Promise<void> {
  doc = d;
  let gaveUp = false;
  const restore = load().then(
    (got) => {
      if (gaveUp) return;
      if (got) apply(d, got.saved);
      enabled = true;
      d.scene.onChange = touch;
      addEventListener('pagehide', flushSave);
      if (got?.blobs.length) void decodeAll(got.blobs);
    },
    (e) => console.warn('board: could not restore the saved drawing', e),
  );
  const timeout = new Promise<void>((done) => setTimeout(() => {
    gaveUp = true;
    done();
  }, OPEN_TIMEOUT_MS));
  // Waits only for the elements, not for picture decodes.
  return Promise.race([restore.then(() => undefined), timeout]);
}

// Marks the drawing or camera changed; a save follows after SAVE_DELAY_MS, in an idle slot. Cheap enough to call per frame.
export function touch() {
  dirty = true;
  schedule();
}

function schedule() {
  if (!enabled || timer || running) return;
  timer = setTimeout(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void run(), { timeout: IDLE_TIMEOUT_MS });
    else void run();
  }, SAVE_DELAY_MS);
}

// Saves now when something is pending (the board closed, the page is going away).
export function flushSave() {
  if (!timer || running) return;
  clearTimeout(timer);
  void run();
}

async function run() {
  timer = null;
  if (!dirty || running || !doc) return;
  if (busy?.()) return schedule();
  dirty = false;
  running = true;
  try {
    await save(doc);
  } catch (e) {
    console.warn('board: could not save the drawing', e);
  } finally {
    running = false;
    if (dirty) schedule();
  }
}

async function save(d: Doc) {
  const els = d.scene.order.slice(), cam = { x: d.cam.x, y: d.cam.y, z: d.cam.z };
  const srcs = [...new Set(els.flatMap((el) => (el.kind === 'image' ? [el.src] : [])))];
  const found = await Promise.all(srcs.map((src) => sourceOf(src).then((b) => [src, b] as const)));
  const imgs = found.filter((e): e is readonly [string, Blob] => !!e[1]).sort((a, b) => a[1].size - b[1].size);
  let total = imgs.reduce((n, e) => n + e[1].size, 0);
  while (imgs.length && total > IMAGE_BYTES_MAX) total -= imgs.pop()![1].size;
  const keep = new Map(imgs);
  const db = await open();
  await new Promise<void>((done, fail) => {
    const tx = db.transaction([DOCS, IMAGES], 'readwrite');
    const store = tx.objectStore(IMAGES);
    const keys = store.getAllKeys();
    // Checked against what is stored, not what this page wrote, so another tab's save cannot leave holes.
    keys.onsuccess = () => {
      const have = new Set(keys.result as string[]);
      for (const k of have) if (!keep.has(k)) store.delete(k);
      for (const [k, b] of keep) if (!have.has(k)) store.put(b, k);
      if (els.length) tx.objectStore(DOCS).put({ v: VERSION, els, cam } satisfies Saved, KEY);
      else tx.objectStore(DOCS).delete(KEY);
    };
    tx.oncomplete = () => done();
    tx.onerror = tx.onabort = () => fail(tx.error);
  });
}
