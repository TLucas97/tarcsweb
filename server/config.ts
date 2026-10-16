import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EFFORTS, MODES, type Effort, type Mode, type Settings } from './protocol.ts';

export const LANGUAGES = ['en', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];

// Per-user settings; every key is optional and falls back to the clean defaults below.
export type Config = {
  defaults: Settings;
  // Language of generated text (summaries, recaps, explanations, notifications); the UI stays English.
  language: Language;
  voice: { name: string; speed: number };
  ntfy: { topic: string; server: string } | null;
  // Tokens at which a session hands off and compacts; false turns it off, null means the default.
  handoffAt: number | false | null;
  // Claude Code's built-in You should know mod: a side agent that adds heads-up notes. It uses the plan's limits.
  youShouldKnow: boolean;
};

// The Kokoro voice used when the config names none.
const VOICES: Record<Language, string> = { en: 'af_heart', 'pt-BR': 'pf_dora' };

const DEFAULTS: Omit<Config, 'voice'> & { voice: { speed: number } } = {
  defaults: { mode: 'default', model: 'claude-sonnet-5-5', effort: 'high' },
  language: 'en',
  voice: { speed: 1 },
  ntfy: null,
  handoffAt: null,
  youShouldKnow: true,
};

export const CONFIG_PATH = process.env.CW_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tarcsweb/config.json');

// Everything the server stores. An install from before the rename keeps its old dir, so saved image links still resolve.
export const CACHE_DIR = process.env.CW_CACHE || (() => {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tarcsweb');
  const legacy = join(homedir(), '.cache/claude-web');
  // The legacy dir wins even when the new one exists: install.sh creates it for the client build.
  return existsSync(legacy) ? legacy : dir;
})();

export type Raw = Record<string, unknown>;
export const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T) => (list.includes(v as T) ? (v as T) : fallback);

function readRaw(): Raw {
  try {
    return obj(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`config: ${CONFIG_PATH} is unreadable, using defaults (${(e as Error).message})`);
    return {};
  }
}

export function normalize(raw: Raw): Config {
  const d = obj(raw.defaults);
  const v = obj(raw.voice);
  const n = obj(raw.ntfy);
  const topic = str(n.topic, '');
  const language = oneOf<Language>(raw.language, LANGUAGES, DEFAULTS.language);
  return {
    defaults: {
      mode: oneOf<Mode>(d.mode, MODES, DEFAULTS.defaults.mode),
      model: str(d.model, DEFAULTS.defaults.model),
      effort: oneOf<Effort>(d.effort, EFFORTS, DEFAULTS.defaults.effort),
    },
    language,
    voice: { name: str(v.name, VOICES[language]), speed: num(v.speed, DEFAULTS.voice.speed) },
    ntfy: topic ? { topic, server: str(n.server, 'https://ntfy.sh').replace(/\/+$/, '') } : null,
    handoffAt: raw.handoffAt === false ? false : typeof raw.handoffAt === 'number' && raw.handoffAt > 0 ? raw.handoffAt : null,
    youShouldKnow: raw.youShouldKnow !== false,
  };
}

// The file as read, unknown keys included, so a settings write can merge into it.
export const rawConfig: { value: Raw } = { value: readRaw() };

// Read at boot; the settings screen updates it in place, but values copied at boot (voice) wait for a restart.
export const config = normalize(rawConfig.value);

// Picks the variant for the configured language.
export const t = <T>(by: Record<Language, T>): T => by[config.language];

// Options a Claude Code mod keeps under pluginConfigs in ~/.claude/settings.json.
export function modOptions(prefix: string): Raw {
  try {
    const s = obj(JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')));
    const entry = Object.entries(obj(s.pluginConfigs)).find(([k]) => k.startsWith(prefix));
    return obj(obj(entry?.[1]).options);
  } catch {
    return {};
  }
}

// The context-handoff mod's own threshold, used when the config sets none.
const MOD_HANDOFF_AT = Number(modOptions('context-handoff').threshold_tokens) || 0;
export const DEFAULT_HANDOFF_AT = 350_000;

// Read live, so a change in Settings applies at the next turn end; null means off.
export function handoffAt(): number | null {
  const env = Number(process.env.CW_HANDOFF_AT);
  if (env > 0) return env;
  if (config.handoffAt === false) return null;
  return config.handoffAt || MOD_HANDOFF_AT || DEFAULT_HANDOFF_AT;
}
