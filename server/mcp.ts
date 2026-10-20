import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { browser } from './browser.ts';
import { CACHE_DIR } from './config.ts';
import type { BrowserTool, McpGroup } from './protocol.ts';

// The optional server sets `cc <name>` loads, one JSON file each.
const DIR = join(homedir(), '.claude/mcp');
const SAVED = join(CACHE_DIR, 'mcp.json');
const TTL_MS = 10_000;

type Pack = { key: string; servers: Record<string, McpServerConfig> };

function packOfFile(name: string, text: string): Pack[] {
  try {
    const servers = JSON.parse(text).mcpServers;
    return servers && typeof servers === 'object' ? [{ key: name.slice(0, -5), servers }] : [];
  } catch {
    return [];
  }
}

const names = (all: string[]) => all.filter((f) => f.endsWith('.json')).sort();

// Read once at boot; afterwards a background check re-reads only when a file's mtime changed.
let packs: Pack[] = [];
let stamp = '';
try {
  const files = names(readdirSync(DIR));
  stamp = files.map((f) => `${f}:${statSync(join(DIR, f)).mtimeMs}`).join('|');
  packs = files.flatMap((f) => packOfFile(f, readFileSync(join(DIR, f), 'utf8')));
} catch {}
let checkedAt = Date.now();
let checking = false;

async function recheck() {
  checking = true;
  try {
    const files = names(await readdir(DIR));
    const times = await Promise.all(files.map((f) => stat(join(DIR, f)).then((s) => s.mtimeMs, () => 0)));
    const next = files.map((f, i) => `${f}:${times[i]}`).join('|');
    if (next !== stamp) {
      const texts = await Promise.all(files.map((f) => readFile(join(DIR, f), 'utf8').catch(() => '')));
      packs = files.flatMap((f, i) => packOfFile(f, texts[i]));
      stamp = next;
    }
  } catch {
    packs = [];
    stamp = '';
  } finally {
    checkedAt = Date.now();
    checking = false;
  }
}

// Built-in packs that drive the Browser panel's Chrome over its DevTools port, by pack key and by server name.
export const PANEL_PACKS = { playwright: 'playwright (panel)', devtools: 'devtools (panel)' } as const;
export const PANEL_SERVERS = { playwright: 'panel-playwright', devtools: 'panel-devtools' } as const;
const PLAYWRIGHT_OUT = join(CACHE_DIR, 'browser', 'playwright-output');

function panelPacks(port: number): Pack[] {
  const url = `http://127.0.0.1:${port}`;
  return [
    { key: PANEL_PACKS.playwright, servers: { [PANEL_SERVERS.playwright]: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', url, '--caps', 'vision,devtools', '--output-dir', PLAYWRIGHT_OUT] } } },
    { key: PANEL_PACKS.devtools, servers: { [PANEL_SERVERS.devtools]: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', url, '--no-usage-statistics', '--no-performance-crux'] } } },
  ];
}

// The browser layer a tool call belongs to, for the panel's badges.
export const BROWSER_TOOLS = `^mcp__(claude-in-chrome|${PANEL_SERVERS.playwright}|${PANEL_SERVERS.devtools})__`;
export function browserToolOf(name: string): BrowserTool | null {
  if (name.startsWith('mcp__claude-in-chrome__')) return 'claude';
  if (name.startsWith(`mcp__${PANEL_SERVERS.playwright}__`)) return 'playwright';
  if (name.startsWith(`mcp__${PANEL_SERVERS.devtools}__`)) return 'devtools';
  return null;
}

let all: { files: Pack[]; port: number; packs: Pack[] } | null = null;

// Called on every roster build, so it never touches the disk itself.
export function mcpPacks(): Pack[] {
  if (!checking && Date.now() - checkedAt > TTL_MS) void recheck();
  const port = browser.devtoolsPort;
  if (all?.files !== packs || all.port !== port) all = { files: packs, port, packs: [...packs, ...panelPacks(port)] };
  return all.packs;
}

// The panel packs stay chosen while the agents switch is off, but do not run.
export const isPanelPack = (key: string) => key === PANEL_PACKS.playwright || key === PANEL_PACKS.devtools;

export function serversFor(keys: string[]): Record<string, McpServerConfig> {
  return Object.assign({}, ...mcpPacks().filter((p) => keys.includes(p.key) && (browser.agents || !isPanelPack(p.key))).map((p) => p.servers));
}

// Server name to the pack that brings it, for status and errors.
export function packOf(server: string) {
  return mcpPacks().find((p) => server in p.servers)?.key ?? null;
}

function readSaved(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(SAVED, 'utf8'));
  } catch {
    return {};
  }
}

export const savedMcp = (sessionId: string) => readSaved()[sessionId] ?? [];

export function saveMcp(sessionId: string, keys: string[]) {
  const all = readSaved();
  if (keys.length) all[sessionId] = keys;
  else delete all[sessionId];
  try {
    mkdirSync(join(SAVED, '..'), { recursive: true });
    writeFileSync(SAVED, JSON.stringify(all));
  } catch (err) {
    console.error('saving MCP choice failed', err);
  }
}

// The mods every CLI of this app loads; the menu shows them read-only.
export const MODS = ['visual', 'replay', 'agents-panel'];
// Where a mod lives; the CLI loads it from here and Codex tabs run its helper from here.
export const modDir = (name: string) => fileURLToPath(new URL(`../mods/${name}`, import.meta.url));

// Settings-loaded servers start on unless the session turned them off; a default-off list would plug in here.
export const defaultOn = (_name: string) => true;

const byName = (name: string): McpGroup => (name.startsWith('claude.ai ') ? 'claudeai' : name.startsWith('plugin:') ? 'plugin' : 'other');

// Trusts the CLI's source over the name; a server it did not report goes by its name.
export function groupOf(name: string, source?: string): McpGroup {
  if (source === 'sdk' || (source === 'plugin' && MODS.includes(name))) return 'builtin';
  if (packOf(name)) return 'pack';
  if (source === 'user') return 'user';
  if (source === 'project' || source === 'local') return 'project';
  if (source === 'claudeai' || source === 'plugin') return source;
  return byName(name);
}

// Claude Code's own config: user servers, plus per folder the local-scope servers and the ones /mcp switched off.
const CLAUDE_JSON = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
type FolderCfg = { local: string[]; disabled: string[] };
let claudeJson: { user: string[]; projects: Record<string, FolderCfg> } = { user: [], projects: {} };
let claudeStamp = 0;
let claudeAt = 0;
let claudeLoad: Promise<void> | null = null;

const keysOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

async function loadClaudeJson() {
  try {
    const { mtimeMs } = await stat(CLAUDE_JSON);
    if (mtimeMs === claudeStamp) return;
    const raw = JSON.parse(await readFile(CLAUDE_JSON, 'utf8'));
    const projects: Record<string, FolderCfg> = {};
    for (const [path, p] of Object.entries((raw.projects ?? {}) as Record<string, { mcpServers?: unknown; disabledMcpServers?: unknown }>)) {
      const local = keysOf(p?.mcpServers);
      const disabled = strings(p?.disabledMcpServers);
      if (local.length || disabled.length) projects[path] = { local, disabled };
    }
    claudeJson = { user: keysOf(raw.mcpServers), projects };
    claudeStamp = mtimeMs;
  } catch {}
}

// The folder's .mcp.json server names, a few folders at a time.
const FOLDERS_MAX = 32;
const folderJson = new Map<string, { at: number; names: string[] }>();

async function loadFolder(cwd: string) {
  let names: string[] = [];
  try {
    names = keysOf(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers);
  } catch {}
  folderJson.delete(cwd);
  folderJson.set(cwd, { at: Date.now(), names });
  if (folderJson.size > FOLDERS_MAX) folderJson.delete(folderJson.keys().next().value!);
  return names;
}

export type Catalog = { user: string[]; project: string[]; disabled: string[] };

// What a CLI in this folder would load from config files; re-read at most every TTL_MS.
export async function catalog(cwd: string): Promise<Catalog> {
  if (Date.now() - claudeAt > TTL_MS) {
    claudeLoad ??= loadClaudeJson().finally(() => {
      claudeAt = Date.now();
      claudeLoad = null;
    });
    await claudeLoad;
  }
  const f = folderJson.get(cwd);
  const project = f && Date.now() - f.at < TTL_MS ? f.names : await loadFolder(cwd);
  const p = claudeJson.projects[cwd];
  return { user: claudeJson.user, project: [...project, ...(p?.local ?? [])], disabled: p?.disabled ?? [] };
}

let writing = Promise.resolve();
function writeQueued(path: string, data: unknown) {
  const text = JSON.stringify(data);
  writing = writing.then(() => mkdir(CACHE_DIR, { recursive: true })).then(() => writeFile(path, text)).catch((err) => console.error('saving MCP state failed', err));
}

// claude.ai connectors and plugin servers are known only once a CLI ran; the last ones seen stand in until then.
const SEEN = join(CACHE_DIR, 'mcp-seen.json');
const SEEN_MAX = 80;
let seen: Record<string, McpGroup> = {};
try {
  seen = JSON.parse(readFileSync(SEEN, 'utf8'));
} catch {}

export const seenServers = () => seen;

// hidden: servers the session turned off, which the CLI no longer reports.
export function rememberSeen(live: [string, McpGroup][], hidden: Set<string>) {
  const next: Record<string, McpGroup> = Object.fromEntries(live.slice(0, SEEN_MAX));
  for (const [n, g] of Object.entries(seen)) if (hidden.has(n) && !(n in next)) next[n] = g;
  if (JSON.stringify(next) === JSON.stringify(seen)) return;
  seen = next;
  writeQueued(SEEN, next);
}

// Per session, the settings-loaded servers whose on/off differs from defaultOn. Kept apart from SAVED so older servers still read it.
const CHOICES = join(CACHE_DIR, 'mcp-servers.json');
let choices: Record<string, Record<string, boolean>> = {};
try {
  choices = JSON.parse(readFileSync(CHOICES, 'utf8'));
} catch {}

export const savedChoices = (sessionId: string): Record<string, boolean> => ({ ...choices[sessionId] });

export function saveChoices(sessionId: string, map: Record<string, boolean>) {
  if (Object.keys(map).length) choices[sessionId] = map;
  else if (sessionId in choices) delete choices[sessionId];
  else return;
  writeQueued(CHOICES, choices);
}
