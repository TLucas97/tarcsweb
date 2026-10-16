import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';

const FILE = join(CACHE_DIR, 'dismissed-headsups.json');
// Longer than the longest limit window, so a dismissal outlives its reset period.
const KEEP_MS = 8 * 24 * 3600_000;
const MAX = 200;

// Dismissed heads-ups that belong to the account, not to one session (usage limits).
// Ids carry the window's reset time and usage band, so a new period or a higher band shows again.
export class Dismissals {
  private seen = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();

  constructor() {
    try {
      const raw: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
      const now = Date.now();
      for (const [id, at] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (typeof at === 'number' && now - at < KEEP_MS) this.seen.set(id, at);
      }
    } catch {
      // Missing or unreadable file: start empty.
    }
  }

  has(id: string) {
    return this.seen.has(id);
  }

  add(id: string) {
    this.seen.delete(id);
    this.seen.set(id, Date.now());
    while (this.seen.size > MAX) this.seen.delete(this.seen.keys().next().value!);
    const text = JSON.stringify(Object.fromEntries(this.seen));
    this.writing = this.writing
      .then(() => mkdir(CACHE_DIR, { recursive: true }))
      .then(() => writeFile(FILE, text))
      .catch((err) => console.error('saving dismissed heads-ups failed', err));
  }
}
