import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';

const file = join(CACHE_DIR, 'opencode-hidden.json');
let ids: Promise<Set<string>> | null = null;
let saving = Promise.resolve();

function load() {
  return ids ??= readFile(file, 'utf8').then(text => {
    const value: unknown = JSON.parse(text);
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  }, () => new Set<string>());
}

export const hiddenThreads = {
  all: load,
  async add(id: string) {
    const set = await load();
    set.add(id);
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(CACHE_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...set]));
      await rename(tmp, file);
    });
    await saving;
  },
};
