import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveToolPath } from './tools.ts';

export type HookEvent = 'PreToolUse' | 'PermissionRequest' | 'PostToolUse';
export type Hook = {
  config: Record<string, unknown>;
  matcher: unknown;
  source: string;
  pluginRoot?: string;
};
export type Rule = { text: string; root: string; source: string };
type RuleKind = 'allow' | 'deny' | 'ask';
type Layer = { path: string; root: string; scope: 'user' | 'workspace' | 'managed'; data: Record<string, unknown> };
export type Settings = {
  hooks: Record<HookEvent, Hook[]>;
  rules: Record<RuleKind, Rule[]>;
  directories: string[];
  sandbox: boolean;
  blockOutside: boolean;
  denyInsteadOfPrompting: boolean;
  disableBypass: boolean;
  gaps: string[];
};

// Claude Code's managed settings directory per platform (code.claude.com/docs/en/managed-settings).
const MANAGED = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
const CACHE_MS = 2000;
const CACHE_CAP = 64;
const cache = new Map<string, { until: number; pending: Promise<Settings> }>();
const warned = new Set<string>();

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function readObject(path: string, invalid: string[]) {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const data = object(value);
    if (data) return data;
    throw new Error('Expected a JSON object.');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (!warned.has(path)) {
      if (warned.size >= 128) warned.delete(warned.values().next().value!);
      warned.add(path);
      console.warn('Code Mode skipped unreadable settings:', path);
    }
    invalid.push(path);
    return undefined;
  }
}

function addHooks(settings: Settings, value: unknown, source: string, pluginRoot?: string) {
  const events = object(value);
  for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUse'] as const) {
    const groups = events?.[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entry = object(group);
      if (!Array.isArray(entry?.hooks)) continue;
      for (const handler of entry.hooks) {
        const config = object(handler);
        if (config) settings.hooks[event].push({ config, matcher: entry.matcher, source, pluginRoot });
      }
    }
  }
}

async function addPluginHooks(
  settings: Settings, cwd: string, configDir: string, enabled: Map<string, unknown>, invalid: string[],
) {
  if (![...enabled.values()].includes(true)) return;
  const registry = object((await readObject(resolve(configDir, 'plugins/installed_plugins.json'), invalid))?.plugins);
  // Built-in plugins live inside the CLI binary with no hooks.json to read; a gap for them would make every call ask.
  await Promise.all([...enabled].filter(([name, value]) => value === true && !name.endsWith('@builtin')).map(async ([name]) => {
    const candidates = registry?.[name];
    const installs = (Array.isArray(candidates) ? candidates : []).map(object).filter((item) => {
      if (!item || typeof item.installPath !== 'string' || !isAbsolute(item.installPath)) return false;
      if (item.scope === 'user') return true;
      return ['project', 'local'].includes(String(item.scope)) && item.projectPath === cwd;
    });
    const roots = [...new Set(installs.map((item) => item!.installPath as string))];
    if (roots.length !== 1) {
      settings.gaps.push('Code Mode could not resolve hooks for plugin ' + name + '.');
      return;
    }
    const [root] = roots;
    const source = 'plugin:' + name;
    if (!await realpath(root).catch(() => undefined)) {
      settings.gaps.push('Code Mode could not locate plugin ' + name + '.');
      return;
    }
    const [manifest, hooks] = await Promise.all([
      readObject(resolve(root, '.claude-plugin/plugin.json'), invalid),
      readObject(resolve(root, 'hooks/hooks.json'), invalid),
    ]);
    addHooks(settings, hooks?.hooks, source, root);
    if (manifest?.hooks !== undefined || manifest?.mods !== undefined) {
      settings.gaps.push('Code Mode cannot evaluate custom hook sources for plugin ' + name + '.');
    }
  }));
}

async function trustKey(cwd: string): Promise<string> {
  const start = await realpath(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = resolve(dir, '.git');
    const info = await lstat(dotGit).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info) {
      if (info.isFile()) {
        const gitdir = /^gitdir: (.+)$/.exec((await readFile(dotGit, 'utf8')).trim())?.[1];
        if (gitdir) {
          const metadata = resolve(dir, gitdir);
          const common = await readFile(resolve(metadata, 'commondir'), 'utf8').catch(() => undefined);
          if (common) {
            const mainGit = await realpath(resolve(metadata, common.trim()));
            const backlink = (await readFile(resolve(metadata, 'gitdir'), 'utf8')).trim();
            if (resolve(metadata, backlink) === dotGit && dirname(metadata) === resolve(mainGit, 'worktrees') &&
                resolve(dirname(mainGit), '.git') === mainGit) return dirname(mainGit);
          }
        }
      }
      return dir;
    }
    if (dir === dirname(dir)) return start;
  }
}

async function workspaceTrusted(cwd: string, globalConfig: string): Promise<boolean> {
  const config = await readObject(globalConfig, []);
  const projects = object(config?.projects);
  if (!projects) return false;
  // Parent trust outside a repository does not grant the child's project settings.
  const key = await trustKey(cwd).catch(() => undefined);
  return key !== undefined && object(projects[key])?.hasTrustDialogAccepted === true;
}

async function load(cwd: string, configDir: string, globalConfig: string): Promise<Settings> {
  const settings: Settings = {
    hooks: { PreToolUse: [], PermissionRequest: [], PostToolUse: [] },
    rules: { allow: [], deny: [], ask: [] },
    directories: [cwd], sandbox: false, blockOutside: false, denyInsteadOfPrompting: false,
    disableBypass: false, gaps: [],
  };
  const invalid: string[] = [];
  const dropIns = resolve(MANAGED, 'managed-settings.d');
  const managedFilesPending = readdir(dropIns).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'ENOENT') invalid.push(dropIns);
    return [];
  });
  const [managedFiles, trusted] = await Promise.all([managedFilesPending, workspaceTrusted(cwd, globalConfig)]);
  const files = [
    { path: resolve(configDir, 'settings.json'), root: configDir, scope: 'user' as const },
    { path: resolve(cwd, '.claude/settings.json'), root: cwd, scope: 'workspace' as const },
    { path: resolve(cwd, '.claude/settings.local.json'), root: cwd, scope: 'workspace' as const },
    ...[resolve(MANAGED, 'managed-settings.json'), ...managedFiles
      .filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort().map((name) => resolve(dropIns, name))]
      .map((path) => ({ path, root: dirname(path), scope: 'managed' as const })),
  ];
  const layers = (await Promise.all(files.map(async (file): Promise<Layer | undefined> => {
    const data = await readObject(file.path, invalid);
    return data && { ...file, data };
  }))).filter((layer): layer is Layer => layer !== undefined);
  const managed = layers.filter((layer) => layer.scope === 'managed');
  const unmanaged = layers.filter((layer) => layer.scope === 'user' || (layer.scope === 'workspace' && trusted));
  const managedOnly = managed.some(({ data }) => data.allowManagedHooksOnly === true);
  const disabled = managed.some(({ data }) => data.disableAllHooks === true);
  const disabledLocal = unmanaged.some(({ data }) => data.disableAllHooks === true);
  const onlyManagedAllow = managed.some(({ data }) => data.allowManagedPermissionRulesOnly === true);
  const enabled = new Map<string, unknown>();
  for (const layer of layers) {
    const { data, root, path, scope } = layer;
    const canGrant = scope !== 'workspace' || trusted;
    const permissions = object(data.permissions);
    const sandbox = object(data.sandbox);
    settings.sandbox ||= sandbox?.enabled === true;
    settings.blockOutside ||= permissions?.blockReadsOutsideWorkingDirectories === true;
    settings.disableBypass ||= permissions?.disableBypassPermissionsMode === 'disable';
    settings.denyInsteadOfPrompting ||= permissions?.denyInsteadOfPrompting === true && scope !== 'workspace';
    for (const kind of ['allow', 'deny', 'ask'] as const) {
      if ((onlyManagedAllow && scope !== 'managed') || (kind === 'allow' && !canGrant)) continue;
      const entries = permissions?.[kind];
      if (!Array.isArray(entries)) continue;
      for (const text of entries) {
        if (typeof text === 'string') settings.rules[kind].push({ text, root, source: path });
      }
    }
    const directories = permissions?.additionalDirectories;
    if (canGrant && Array.isArray(directories) && (!onlyManagedAllow || scope === 'managed')) {
      for (const path of directories) {
        if (typeof path === 'string' && path && !/^[\\/]{2}[^\\/]/.test(path)) {
          settings.directories.push(resolveToolPath(cwd, path));
        }
      }
    }
    if (canGrant && !disabled && (scope === 'managed' || (!managedOnly && !disabledLocal))) {
      addHooks(settings, data.hooks, 'settings');
      for (const [name, active] of Object.entries(object(data.enabledPlugins) ?? {})) enabled.set(name, active);
    }
  }
  if (!disabled) await addPluginHooks(settings, cwd, configDir, enabled, invalid);
  if (invalid.length) settings.gaps.push('Code Mode skipped unreadable settings or hook files.');
  return settings;
}

export function settingsFor(cwd: string): Promise<Settings> {
  const configDir = resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'));
  const globalConfig = resolve(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
  const key = JSON.stringify([cwd, configDir, globalConfig]);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.pending;
  cache.delete(key);
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  const pending = load(cwd, configDir, globalConfig);
  cache.set(key, { until: now + CACHE_MS, pending });
  return pending;
}
