import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillUse } from './protocol.ts';
import { CACHE_DIR } from './config.ts';

// Skills the main agent loaded in live turns, for the library's Recent list. Kept by tarcsweb only.
const FILE = join(CACHE_DIR, 'skill-usage.json');
const MAX = 300;
const SEND = 20;
const SAVE_DELAY_MS = 2000;
const HALF_LIFE_MS = 3 * 86_400_000;

let store: Promise<Map<string, SkillUse>> | null = null;
let timer: NodeJS.Timeout | null = null;

function load() {
  store ??= readFile(FILE, 'utf8')
    .then((t) => {
      const m = new Map<string, SkillUse>();
      const raw: unknown = JSON.parse(t);
      for (const u of Array.isArray(raw) ? raw : []) {
        const e = u as Partial<SkillUse> | null;
        if (e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.count === 'number' && typeof e.last === 'number') {
          m.set(e.id, { id: e.id, name: e.name, count: e.count, last: e.last, ...(typeof e.path === 'string' ? { path: e.path } : {}) });
        }
      }
      return m;
    })
    .catch(() => new Map<string, SkillUse>());
  return store;
}

// Written after a short quiet spell, to a temp file first so a crash keeps the old one.
function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void load()
      .then(async (m) => {
        const keep = [...m.values()].sort((a, b) => b.last - a.last).slice(0, MAX);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(FILE + '.tmp', JSON.stringify(keep));
        await rename(FILE + '.tmp', FILE);
      })
      .catch((err) => console.error(`skills: saving usage failed: ${err instanceof Error ? err.message : String(err)}`));
  }, SAVE_DELAY_MS);
}

export function recordSkillUse(name: string, path?: string) {
  void load().then((m) => {
    const id = path ?? name;
    const old = m.get(id);
    m.set(id, { id, name, ...(path ? { path } : {}), count: (old?.count ?? 0) + 1, last: Date.now() });
    if (m.size > MAX) m.delete([...m.values()].reduce((a, b) => (a.last < b.last ? a : b)).id);
    save();
  });
}

export async function forgetSkillUse(id: string) {
  const m = await load();
  if (m.delete(id)) save();
}

// Frecency: more uses rank higher, and the weight halves every few days without one.
export async function skillUsage(): Promise<SkillUse[]> {
  const now = Date.now();
  const score = (u: SkillUse) => (1 + Math.log2(u.count)) * 0.5 ** ((now - u.last) / HALF_LIFE_MS);
  return [...(await load()).values()].sort((a, b) => score(b) - score(a)).slice(0, SEND);
}
