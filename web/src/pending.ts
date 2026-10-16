import type { Pending } from './attach.ts';

// Unsent composer attachments per session, kept across reloads; too big for localStorage, so IndexedDB.
export type Parked = { files: Pending[]; pastes: string[] };
type Row = Parked & { id: string; at: number };

const KEEP = 40;
let db: Promise<IDBDatabase> | null = null;

function open() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cw-pending', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' }).createIndex('at', 'at');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

export async function loadParked(id: string): Promise<Parked | null> {
  try {
    const store = (await open()).transaction('pending').objectStore('pending');
    const row = await new Promise<Row | undefined>((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result as Row | undefined);
      req.onerror = () => reject(req.error);
    });
    return row ? { files: row.files, pastes: row.pastes } : null;
  } catch {
    return null;
  }
}

// An empty set deletes the row; past KEEP sessions the oldest rows go.
export async function park(id: string, p: Parked) {
  try {
    const tx = (await open()).transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    if (!p.files.length && !p.pastes.length) store.delete(id);
    else {
      store.put({ id, at: Date.now(), ...p } satisfies Row);
      const count = store.count();
      count.onsuccess = () => {
        let extra = count.result - KEEP;
        if (extra <= 0) return;
        store.index('at').openKeyCursor().onsuccess = (e) => {
          const c = (e.target as IDBRequest<IDBCursor | null>).result;
          if (!c || extra-- <= 0) return;
          store.delete(c.primaryKey);
          c.continue();
        };
      };
    }
    await done(tx);
  } catch {
    // Private mode or a full disk: attachments still work, they just do not survive a reload.
  }
}
