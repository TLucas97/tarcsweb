import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH, LANGUAGES, config, handoffAt, normalize, obj, rawConfig, type Raw } from './config.ts';
import type { SettingsPatch, SettingsView } from './protocol.ts';

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

// Only what the dialog edits; defaults, voice and the ntfy server stay hand-edited in the file.
export function checkPatch(p: unknown): string | null {
  if (!isObj(p) || !Object.keys(p).every((k) => k === 'language' || k === 'ntfy' || k === 'handoffAt' || k === 'youShouldKnow')) return 'Unknown setting';
  if (p.language !== undefined && !LANGUAGES.includes(p.language as never)) return 'Unknown language';
  if (p.ntfy !== undefined && typeof p.ntfy !== 'boolean') return 'Unknown notification setting';
  if (p.youShouldKnow !== undefined && typeof p.youShouldKnow !== 'boolean') return 'Unknown side notes setting';
  const h = p.handoffAt;
  if (h !== undefined && h !== false && !(Number.isInteger(h) && (h as number) >= 50_000 && (h as number) <= 2_000_000)) return 'Unknown handoff size';
  return null;
}

export function settingsView(): SettingsView {
  return { language: config.language, ntfy: config.ntfy, handoffAt: handoffAt(), youShouldKnow: config.youShouldKnow, path: CONFIG_PATH };
}

function merge(raw: Raw, p: SettingsPatch): Raw {
  const next: Raw = { ...raw };
  if (p.language) next.language = p.language;
  if (p.handoffAt !== undefined) next.handoffAt = p.handoffAt;
  if (p.youShouldKnow !== undefined) next.youShouldKnow = p.youShouldKnow;
  if (p.ntfy !== undefined) {
    const n: Raw = { ...obj(raw.ntfy) };
    // 12 random bytes: 16 url-safe characters, which ntfy accepts as a topic name.
    if (p.ntfy && !(typeof n.topic === 'string' && n.topic.trim())) n.topic = `tarcsweb-${randomBytes(12).toString('base64url')}`;
    if (!p.ntfy) delete n.topic;
    next.ntfy = n;
  }
  return next;
}

let chain: Promise<unknown> = Promise.resolve();

// Re-reads the file so edits made by hand meanwhile survive; unknown keys stay. Writes are serialized.
export function saveSettings(p: SettingsPatch): Promise<string | null> {
  const job = chain.then(async () => {
    let raw: Raw = {};
    try {
      raw = obj(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `Could not read ${CONFIG_PATH}: ${(e as Error).message}`;
    }
    const next = merge(raw, p);
    try {
      await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
      const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, CONFIG_PATH);
    } catch (e) {
      return `Could not save: ${(e as Error).message}`;
    }
    rawConfig.value = next;
    Object.assign(config, normalize(next));
    return null;
  });
  chain = job;
  return job;
}
