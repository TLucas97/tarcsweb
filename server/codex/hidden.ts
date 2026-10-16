import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CACHE_DIR } from '../config.ts';

// Codex threads tarcsweb started as helpers (codex_agent runs, handoff forks). Codex does not keep threadSource,
// so this list is what keeps them out of the session list.
const FILE = join(CACHE_DIR, 'codex-hidden.json');
const MAX = 1000;
const SAVE_MS = 1000;
// A thread shows in listings only once Codex wrote its first turn, so a new id is never pruned this soon.
const FRESH_MS = 60 * 60_000;

// Ids added since this server started, with when.
const added = new Map<string, number>();
let ids: Set<string> | null = null;
let loading: Promise<Set<string>> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const parse = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch (e) {
    console.warn(`[codex] ${FILE} is unreadable, starting with no hidden threads: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

function load() {
  loading ??= readFile(FILE, 'utf8')
    .then(parse, () => [])
    .then((v) => (ids = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MAX) : [])));
  return loading;
}

let seq = 0;

function save() {
  timer ??= setTimeout(() => {
    timer = null;
    const list = [...(ids ?? [])];
    // Temp file plus rename, so a crash mid-write never leaves a half file.
    const tmp = `${FILE}.${process.pid}.${++seq}.tmp`;
    void mkdir(dirname(FILE), { recursive: true })
      .then(() => writeFile(tmp, JSON.stringify(list)))
      .then(() => rename(tmp, FILE))
      .catch((e: unknown) => {
        console.warn(`[codex] hidden threads not saved: ${e instanceof Error ? e.message : String(e)}`);
        void rm(tmp, { force: true }).catch(() => {});
      });
  }, SAVE_MS);
  timer.unref?.();
}

export const hiddenThreads = {
  async add(id: string) {
    added.set(id, Date.now());
    if (added.size > MAX) added.delete(added.keys().next().value!);
    const s = await load();
    s.delete(id);
    s.add(id);
    if (s.size > MAX) s.delete(s.values().next().value!);
    save();
  },
  // The current set, for filtering a listing.
  all: () => load(),
  // Drops ids a complete listing no longer has.
  async keepOnly(seen: Set<string>) {
    const s = await load();
    let changed = false;
    const now = Date.now();
    for (const id of s) if (!seen.has(id) && now - (added.get(id) ?? 0) > FRESH_MS) changed = s.delete(id) || changed;
    if (changed) save();
  },
};
