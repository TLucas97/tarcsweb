import type { ClientMessage } from '../../server/protocol.ts';

type Msg = Extract<ClientMessage, { type: 'send' }> & { id: string };
// missing: names of files left out of the saved copy because they were too big. page: the page that saved it.
export type Saved = { id: string; at: number; server: string | null; msg: Msg; missing: string[]; page?: string };

// Tells this page's rows from another open tab's; the store is shared by every tab.
export const PAGE = crypto.randomUUID();

// The newest rows stay; past this the oldest go.
const CAP = 50;
// Files kept in one saved row; the rest must be re-added by hand.
const FILE_BUDGET = 5 * 1024 * 1024;
let db: Promise<IDBDatabase> | null = null;

function open() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cw-outbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('out', { keyPath: 'id' }).createIndex('at', 'at');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}
// Opened at load, so a send's write starts in the same task as the click.
void open().catch(() => {});

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

// Files go in while they fit the budget; their thumbs and links are dropped with them.
function slim(msg: Msg): { msg: Msg; missing: string[] } {
  if (!msg.files?.length) return { msg, missing: [] };
  let used = 0;
  const keep: number[] = [];
  const missing: string[] = [];
  msg.files.forEach((f, i) => {
    const bytes = f.data.length * 0.75;
    if (used + bytes <= FILE_BUDGET) {
      used += bytes;
      keep.push(i);
    } else missing.push(f.name);
  });
  if (!missing.length) return { msg, missing };
  const { links: _links, ...rest } = msg;
  return { msg: { ...rest, files: keep.map((i) => msg.files![i]), thumbs: keep.map((i) => msg.thumbs?.[i] ?? null) }, missing };
}

export async function save(msg: Msg, at: number, server: string | null) {
  try {
    const tx = (await open()).transaction('out', 'readwrite');
    const store = tx.objectStore('out');
    store.put({ id: msg.id, at, server, page: PAGE, ...slim(msg) } satisfies Saved);
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - CAP;
      if (extra <= 0) return;
      store.index('at').openKeyCursor().onsuccess = (e) => {
        const c = (e.target as IDBRequest<IDBCursor | null>).result;
        if (!c || extra-- <= 0) return;
        store.delete(c.primaryKey);
        c.continue();
      };
    };
    await done(tx);
  } catch {
    // Private mode or a full disk: sending still works, it just does not survive a reload.
  }
}

export async function forget(id: string) {
  try {
    const tx = (await open()).transaction('out', 'readwrite');
    tx.objectStore('out').delete(id);
    await done(tx);
  } catch {
    // Nothing to undo: the row comes back after a reload and can be discarded there.
  }
}

// Restored rows move to this page, so another tab loading now leaves them alone.
export async function claim(rows: Saved[]) {
  if (!rows.length) return;
  try {
    const tx = (await open()).transaction('out', 'readwrite');
    const store = tx.objectStore('out');
    for (const r of rows) store.put({ ...r, page: PAGE } satisfies Saved);
    await done(tx);
  } catch {
    // Another tab may restore the same row; Discard there still works.
  }
}

// Oldest first.
export async function loadSaved(): Promise<Saved[]> {
  try {
    const store = (await open()).transaction('out').objectStore('out');
    return await new Promise<Saved[]>((resolve, reject) => {
      const req = store.index('at').getAll();
      req.onsuccess = () => resolve(req.result as Saved[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
