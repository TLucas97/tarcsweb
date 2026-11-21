import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH, LANGUAGES, VOICE_NAME, config, handoffAt, normalize, obj, rawConfig, validClaimCheckers, type Raw } from './config.ts';
import { configuredClaimCheckers } from './claimVerify.ts';
import { BROWSER_DEFAULTS, MODES, OPEN_MODES, PERF_PROFILES, PROVIDERS, PROVIDER_EFFORTS, VISUAL_BUILDS, providerOf, type Provider, type SettingsPatch, type SettingsView } from './protocol.ts';
import { perfForced, perfProfile, perfSaved } from './profile.ts';
import { IN_TAURI, shellInfo } from './shell.ts';

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

// Only what the dialog edits; voice and the ntfy server stay hand-edited in the file.
export function checkPatch(p: unknown): string | null {
  if (IN_TAURI && isObj(p) && 'openMode' in p) {
    if (p.openMode !== undefined && !OPEN_MODES.includes(p.openMode as never)) return 'Unknown open mode';
    const { openMode, ...rest } = p;
    p = rest;
  }
  if (!isObj(p) || !Object.keys(p).every((k) => ['groupAutoCleanup', 'commander', 'language', 'ntfy', 'handoffAt', 'idleHandoff', 'codeMode', 'codeHookRewrites', 'showReasoning', 'keepAwake', 'youShouldKnow', 'claimCheck', 'claimAutoCheck', 'claimCheckers', 'perf', 'browserAgents', 'defaults', 'providerDefaults', 'browserDefault', 'callVoice', 'visualBuild', 'recapRenderer', 'recapVoice'].includes(k))) return 'Unknown setting';
  if (p.recapRenderer !== undefined && p.recapRenderer !== 'kokoro' && p.recapRenderer !== 'codex') return 'Unknown recap voice provider';
  if (p.recapVoice !== undefined && p.recapVoice !== null && (typeof p.recapVoice !== 'string' || !VOICE_NAME.test(p.recapVoice))) return 'Unknown recap voice';
  if (p.visualBuild !== undefined && !VISUAL_BUILDS.includes(p.visualBuild as never)) return 'Unknown visual build setting';
  if (p.groupAutoCleanup !== undefined && typeof p.groupAutoCleanup !== 'boolean') return 'Unknown group cleanup setting';
  if (p.commander !== undefined && typeof p.commander !== 'boolean') return 'Unknown commander setting';
  if (p.defaults !== undefined) {
    const d = p.defaults;
    if (isObj(d) && d.speed !== undefined && d.speed !== 'standard' && d.speed !== 'fast') return 'Unknown speed';
    if (isObj(d) && d.codexAgentSpeed !== undefined && d.codexAgentSpeed !== 'standard' && d.codexAgentSpeed !== 'fast') return 'Unknown Codex agent speed';
    const ok = isObj(d) && MODES.includes(d.mode as never) && typeof d.model === 'string' && d.model.length <= 100
      && PROVIDER_EFFORTS[providerOf(d.model as string)].includes(d.effort as never);
    if (!ok) return 'Unknown new session settings';
  }
  if (p.browserAgents !== undefined && typeof p.browserAgents !== 'boolean') return 'Unknown browser setting';
  if (p.providerDefaults !== undefined) {
    if (!isObj(p.providerDefaults)) return 'Unknown provider defaults';
    for (const [provider, d] of Object.entries(p.providerDefaults)) {
      if (isObj(d) && d.speed !== undefined && d.speed !== 'standard' && d.speed !== 'fast') return 'Unknown speed';
      if (isObj(d) && d.codexAgentSpeed !== undefined && d.codexAgentSpeed !== 'standard' && d.codexAgentSpeed !== 'fast') return 'Unknown Codex agent speed';
      if (!PROVIDERS.includes(provider as Provider) || !isObj(d)
        || !MODES.includes(d.mode as never) || typeof d.model !== 'string' || d.model.length > 100
        || providerOf(d.model) !== provider || !PROVIDER_EFFORTS[provider as Provider].includes(d.effort as never)) return 'Unknown provider defaults';
    }
  }
  if (p.browserDefault !== undefined && !BROWSER_DEFAULTS.includes(p.browserDefault as never)) return 'Unknown browser default';
  // Shape only; the server checks the name against Codex's list (unknownCallVoice) before saving.
  if (p.callVoice !== undefined && p.callVoice !== null && !VOICE_NAME.test(p.callVoice as string)) return 'Unknown call voice';
  if (p.language !== undefined && !LANGUAGES.includes(p.language as never)) return 'Unknown language';
  if (p.ntfy !== undefined && typeof p.ntfy !== 'boolean') return 'Unknown notification setting';
  if (p.youShouldKnow !== undefined && typeof p.youShouldKnow !== 'boolean') return 'Unknown side notes setting';
  if (p.claimCheck !== undefined && typeof p.claimCheck !== 'boolean') return 'Unknown claim check setting';
  if (p.claimAutoCheck !== undefined && typeof p.claimAutoCheck !== 'boolean') return 'Unknown suspicion alert setting';
  if (p.claimCheckers !== undefined && !validClaimCheckers(p.claimCheckers)) return 'Choose one to four different claim checkers';
  if (p.idleHandoff !== undefined && typeof p.idleHandoff !== 'boolean') return 'Unknown idle handoff setting';
  if (p.codeMode !== undefined && typeof p.codeMode !== 'boolean') return 'Unknown Code Mode setting';
  if (p.codeHookRewrites !== undefined && typeof p.codeHookRewrites !== 'boolean') return 'Unknown Code Mode hook setting';
  if (p.showReasoning !== undefined && typeof p.showReasoning !== 'boolean') return 'Unknown reasoning setting';
  if (p.keepAwake !== undefined && typeof p.keepAwake !== 'boolean') return 'Unknown keep awake setting';
  if (p.perf !== undefined && !PERF_PROFILES.includes(p.perf as never)) return 'Unknown performance profile';
  const h = p.handoffAt;
  if (h !== undefined && h !== false && !(Number.isInteger(h) && (h as number) >= 50_000 && (h as number) <= 2_000_000)) return 'Unknown handoff size';
  return null;
}

export function settingsView(): SettingsView {
  const context = { claimAutoCheck: config.claimAutoCheck, claimCheck: config.claimAutoCheck, claimCheckers: configuredClaimCheckers(), keepAwake: config.keepAwake, codeMode: config.codeMode, codeHookRewrites: config.codeHookRewrites, showReasoning: config.showReasoning };
  if (IN_TAURI) return {
    groupAutoCleanup: config.groupAutoCleanup, commander: config.commander,
    language: config.language, ntfy: config.ntfy, handoffAt: handoffAt(), idleHandoff: config.idleHandoff, youShouldKnow: config.youShouldKnow, ...context,
    perf: config.perf ?? null, perfForced: perfForced(), path: CONFIG_PATH, defaults: config.defaults, providerDefaults: config.providerDefaults, browserDefault: config.browserDefault,
    callVoice: config.callVoice, visualBuild: config.visualBuild,
    recapRenderer: config.recapRenderer, recapVoice: config.recapVoice,
    openMode: config.openMode, shell: shellInfo(),
  };
  return {
    groupAutoCleanup: config.groupAutoCleanup, commander: config.commander,
    language: config.language, ntfy: config.ntfy, handoffAt: handoffAt(), idleHandoff: config.idleHandoff, youShouldKnow: config.youShouldKnow, ...context,
    perf: config.perf ?? null, perfForced: perfForced(), path: CONFIG_PATH, defaults: config.defaults, providerDefaults: config.providerDefaults, browserDefault: config.browserDefault,
    callVoice: config.callVoice, visualBuild: config.visualBuild,
    recapRenderer: config.recapRenderer, recapVoice: config.recapVoice,
  };
}

type SavedPatch = SettingsPatch & { mcpDefaults?: NonNullable<typeof config.mcpDefaults>; desktopInstallDismissed?: boolean };
function merge(raw: Raw, p: SavedPatch): Raw {
  const next: Raw = { ...raw };
  if (p.desktopInstallDismissed !== undefined) next.desktopInstallDismissed = p.desktopInstallDismissed;
  if (p.mcpDefaults) next.mcpDefaults = p.mcpDefaults;
  if (p.language) next.language = p.language;
  if (p.perf) next.perf = p.perf;
  if (p.handoffAt !== undefined) next.handoffAt = p.handoffAt;
  if (p.youShouldKnow !== undefined) next.youShouldKnow = p.youShouldKnow;
  const claimAutoCheck = p.claimAutoCheck ?? p.claimCheck;
  if (claimAutoCheck !== undefined) {
    next.claimAutoCheck = claimAutoCheck;
    delete next.claimCheck;
  }
  if (p.claimCheckers !== undefined) next.claimCheckers = p.claimCheckers.map(({ provider, model }) => ({ provider, model }));
  if (p.idleHandoff !== undefined) next.idleHandoff = p.idleHandoff;
  if (p.codeMode !== undefined) next.codeMode = p.codeMode;
  if (p.codeHookRewrites !== undefined) next.codeHookRewrites = p.codeHookRewrites;
  if (p.showReasoning !== undefined) next.showReasoning = p.showReasoning;
  if (p.keepAwake !== undefined) next.keepAwake = p.keepAwake;
  if (p.groupAutoCleanup !== undefined) next.groupAutoCleanup = p.groupAutoCleanup;
  if (p.commander !== undefined) next.commander = p.commander;
  if (p.defaults) {
    const { mode, model, effort, speed = 'standard', codexAgentSpeed } = p.defaults;
    // Bypass is never saved as a default: a pick made in Bypass keeps the saved mode.
    next.defaults = { ...obj(raw.defaults), ...(mode === 'bypassPermissions' ? {} : { mode }), model, effort, speed, ...(codexAgentSpeed && { codexAgentSpeed }) };
  }
  if (p.providerDefaults || p.defaults) {
    const providers = { ...normalize(raw).providerDefaults };
    for (const [key, d] of Object.entries({ ...p.providerDefaults, ...(p.defaults ? { [providerOf(p.defaults.model)]: p.defaults } : {}) })) {
      const provider = key as keyof typeof providers;
      providers[provider] = { ...d, mode: d.mode === 'bypassPermissions' ? providers[provider].mode : d.mode, codexAgentSpeed: d.codexAgentSpeed ?? providers[provider].codexAgentSpeed };
    }
    next.providerDefaults = providers;
  }
  // Next to the hand-edited browser keys (port, bin).
  if (p.browserAgents !== undefined) next.browser = { ...obj(raw.browser), agents: p.browserAgents };
  if (p.browserDefault !== undefined) next.browser = { ...obj(next.browser), default: p.browserDefault };
  if (p.visualBuild) next.visualBuild = p.visualBuild;
  if (p.callVoice) next.callVoice = p.callVoice;
  else if (p.callVoice === null) delete next.callVoice;
  if (p.recapRenderer) next.recapRenderer = p.recapRenderer;
  if (IN_TAURI && p.openMode) next.openMode = p.openMode;
  if (p.recapVoice !== undefined) next.recapVoice = p.recapVoice;
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
