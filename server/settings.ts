import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH, LANGUAGES, config, handoffAt, normalize, obj, rawConfig, type Raw } from './config.ts';
import { EFFORTS, MODES, PERF_PROFILES, type SettingsPatch, type SettingsView } from './protocol.ts';
import { perfForced, perfProfile, perfSaved } from './profile.ts';

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

// Only what the dialog edits; voice and the ntfy server stay hand-edited in the file.
export function checkPatch(p: unknown): string | null {
  if (!isObj(p) || !Object.keys(p).every((k) => ['groupAutoCleanup', 'language', 'ntfy', 'handoffAt', 'youShouldKnow', 'perf', 'browserAgents', 'defaults'].includes(k))) return 'Unknown setting';
  if (p.groupAutoCleanup !== undefined && typeof p.groupAutoCleanup !== 'boolean') return 'Unknown group cleanup setting';
  if (p.defaults !== undefined) {
    const d = p.defaults;
    const ok = isObj(d) && MODES.includes(d.mode as never) && typeof d.model === 'string' && !!d.model && d.model.length <= 100
      && EFFORTS.includes(d.effort as never);
    if (!ok) return 'Unknown new session settings';
  }
  if (p.browserAgents !== undefined && typeof p.browserAgents !== 'boolean') return 'Unknown browser setting';
  if (p.language !== undefined && !LANGUAGES.includes(p.language as never)) return 'Unknown language';
  if (p.ntfy !== undefined && typeof p.ntfy !== 'boolean') return 'Unknown notification setting';
  if (p.youShouldKnow !== undefined && typeof p.youShouldKnow !== 'boolean') return 'Unknown side notes setting';
  if (p.perf !== undefined && !PERF_PROFILES.includes(p.perf as never)) return 'Unknown performance profile';
  const h = p.handoffAt;
  if (h !== undefined && h !== false && !(Number.isInteger(h) && (h as number) >= 50_000 && (h as number) <= 2_000_000)) return 'Unknown handoff size';
  return null;
}

export function settingsView(): SettingsView {
  return {
    groupAutoCleanup: config.groupAutoCleanup,
    language: config.language, ntfy: config.ntfy, handoffAt: handoffAt(), youShouldKnow: config.youShouldKnow,
    perf: config.perf ?? null, perfForced: perfForced(), path: CONFIG_PATH, defaults: config.defaults,
  };
}

type SavedPatch = SettingsPatch & { mcpDefaults?: NonNullable<typeof config.mcpDefaults> };
function merge(raw: Raw, p: SavedPatch): Raw {
  const next: Raw = { ...raw };
  if (p.mcpDefaults) next.mcpDefaults = p.mcpDefaults;
  if (p.language) next.language = p.language;
  if (p.perf) next.perf = p.perf;
  if (p.handoffAt !== undefined) next.handoffAt = p.handoffAt;
  if (p.youShouldKnow !== undefined) next.youShouldKnow = p.youShouldKnow;
  if (p.groupAutoCleanup !== undefined) next.groupAutoCleanup = p.groupAutoCleanup;
  if (p.defaults) {
    const { mode, model, effort } = p.defaults;
    // Bypass is never saved as a default: a pick made in Bypass keeps the saved mode.
    next.defaults = { ...obj(raw.defaults), ...(mode === 'bypassPermissions' ? {} : { mode }), model, effort };
  }
  // Next to the hand-edited browser keys (port, bin).
  if (p.browserAgents !== undefined) next.browser = { ...obj(raw.browser), agents: p.browserAgents };
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
export function saveSettings(p: SavedPatch): Promise<string | null> {
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
    const before = config.perf;
    const agents = config.browserAgents;
    const prev = perfProfile();
    Object.assign(config, normalize(next));
    if (config.perf !== before) perfSaved(prev);
    if (config.browserAgents !== agents) for (const fn of agentsListeners) fn(config.browserAgents);
    return null;
  });
  chain = job;
  return job;
}

const agentsListeners = new Set<(on: boolean) => void>();

// Fires after a save flipped the Browser panel's agents switch.
export function onAgentsChange(fn: (on: boolean) => void) {
  agentsListeners.add(fn);
  return () => void agentsListeners.delete(fn);
}
