// Finds a folder's commands in its project files, without running anything.
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { RunCommand, RunKind, RunSource } from './types.ts';

export const DESTRUCTIVE = /\b(reset|drop|clear|wipe|purge|nuke|destroy|flush(all|db)?|truncate)\b|rm\s+-[a-z]*r[a-z]*f|down\s+(-v|--volumes)|migrate\s+reset|db\s+drop/i;
const SERVICE_NAME = /^(dev|start|serve|preview|watch|storybook|run|up)(:|$)|:(dev|watch|serve)$/;
const SERVICE_BODY = /\bPORT=\d|--port\b|\b(vite(?!\s+build)|next\s+(dev|start)|nuxt\s+dev|astro\s+dev|remix\s+dev|react-scripts\s+start|storybook\s+dev|nodemon|tsx\s+watch|ng\s+serve|gatsby\s+develop|webpack\s+serve)\b|--watch\b/;
const WEB_BODY = /\b(vite|next|nuxt|astro|remix|react-scripts|storybook|gatsby|svelte-kit|ng\s+serve|parcel|rsbuild|webpack\s+serve)\b/;
const LIFECYCLE = /^(pre|post)?(install|prepare|prepublish(Only)?|prepack|postpack|publish|version)$/;
const DEFAULT_PORT: [RegExp, number][] = [
  [/\bvite\s+preview\b/, 4173], [/\bvite\b/, 5173], [/\bnext\b/, 3000], [/\bnuxt\b/, 3000], [/\bastro\b/, 4321], [/\bremix\b/, 3000],
  [/\breact-scripts\b/, 3000], [/\bstorybook\b/, 6006], [/\bgatsby\b/, 8000], [/\bng\s+serve\b/, 4200],
];
// Workspace packages read per folder; a big monorepo lists its first ones.
const WORKSPACE_MAX = 16;
const MAKE_MAX = 24;

type Found = { commands: RunCommand[]; pm: string | null; sources: string[] };

const read = (path: string) => readFile(path, 'utf8').catch(() => null);
const exists = (path: string) => stat(path).then(() => true, () => false);
const json = (text: string | null): Record<string, unknown> | null => {
  try {
    const v = text ? JSON.parse(text) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

function portOf(body: string, config: number | undefined) {
  const flag = /(?:--port|-p)[= ](\d{2,5})\b|\bPORT=(\d{2,5})\b/.exec(body);
  if (flag) return Number(flag[1] ?? flag[2]);
  if (config && /\bvite\b(?!\s+preview)/.test(body)) return config;
  return DEFAULT_PORT.find(([re]) => re.test(body))?.[1];
}

function cmd(source: RunSource, id: string, label: string, command: string, kind: RunKind, cwd = '', extra: Partial<RunCommand> = {}): RunCommand {
  return { id, label, command, cwd, kind, destructive: DESTRUCTIVE.test(`${label} ${command}`), source, ...extra };
}

async function pmOf(dir: string, pkg: Record<string, unknown> | null) {
  for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']] as const) {
    if (await exists(join(dir, file))) return pm;
  }
  const named = typeof pkg?.packageManager === 'string' ? /^(pnpm|yarn|bun|npm)@/.exec(pkg.packageManager)?.[1] : undefined;
  return named ?? 'npm';
}

// Names from project files go into a shell line, so anything unusual is single-quoted.
const q = (s: string) => (/^[\w:.@/+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const runScript = (pm: string, name: string) => (pm === 'npm' || pm === 'bun' ? `${pm} run ${q(name)}` : `${pm} ${q(name)}`);

async function vitePort(dir: string) {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    const text = await read(join(dir, f));
    if (text) {
      const m = /\bport\s*:\s*(\d{2,5})/.exec(text);
      return m ? Number(m[1]) : undefined;
    }
  }
}

async function packageScripts(dir: string, pm: string, scripts: Record<string, string>): Promise<RunCommand[]> {
  const names = Object.keys(scripts).filter((n) => typeof scripts[n] === 'string' && !LIFECYCLE.test(n) && !(/^(pre|post)/.test(n) && n.replace(/^(pre|post)/, '') in scripts));
  const config = await vitePort(dir);
  const out: RunCommand[] = [];
  const hasDev = names.some((n) => /^dev(:|$)/.test(n));
  const startName = names.includes('start') ? 'start' : names.includes('preview') ? 'preview' : null;
  // build + start (or preview) is the local production run; start is then not a dev service.
  const prod = names.includes('build') && startName && (hasDev || startName === 'preview');
  if (prod) {
    const body = scripts[startName]!;
    out.push(cmd('package.json', 'pkg::prod', 'Build and start', runScript(pm, startName), 'prod', '', { build: runScript(pm, 'build'), port: portOf(body, undefined), web: WEB_BODY.test(body) }));
  }
  for (const n of names) {
    if (prod && (n === 'build' || n === startName)) continue;
    const body = scripts[n]!;
    const service = SERVICE_NAME.test(n) || SERVICE_BODY.test(body);
    const destructive = DESTRUCTIVE.test(`${n} ${body}`);
    out.push(cmd('package.json', `pkg::${n}`, n, runScript(pm, n), service ? 'service' : 'action', '', service ? { port: portOf(body, config), web: WEB_BODY.test(body), destructive } : { destructive }));
  }
  return out;
}

// pnpm-workspace.yaml's packages list, or package.json workspaces; one-level globs only.
async function workspaceDirs(dir: string, pkg: Record<string, unknown> | null) {
  const pats: string[] = [];
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  for (const p of list) if (typeof p === 'string') pats.push(p);
  const yaml = await read(join(dir, 'pnpm-workspace.yaml'));
  const block = yaml && /^packages:\s*\n((?:[ \t]+-.*\n?)+)/m.exec(yaml);
  if (block) for (const m of block[1]!.matchAll(/-\s*['"]?([^'"\n#]+)['"]?/g)) pats.push(m[1]!.trim());
  const dirs: string[] = [];
  for (const p of pats) {
    if (p.startsWith('!')) continue;
    const base = p.replace(/\/\*\*?$/, '');
    if (base === p) dirs.push(p);
    else {
      const ents = await readdir(join(dir, base), { withFileTypes: true }).catch(() => []);
      for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') dirs.push(`${base}/${e.name}`);
    }
    if (dirs.length >= WORKSPACE_MAX) break;
  }
  return dirs.slice(0, WORKSPACE_MAX);
}

function makeTargets(text: string, tool: 'make' | 'just', source: RunSource) {
  const out: RunCommand[] = [];
  const re = tool === 'make' ? /^([A-Za-z0-9][\w-]*)\s*:(?![=:])/gm : /^(?:@)?([A-Za-z0-9][\w-]*)\s*:(?!=)/gm;
  for (const m of text.matchAll(re)) {
    const t = m[1]!;
    if (out.some((c) => c.label === t)) continue;
    out.push(cmd(source, `${tool}::${t}`, t, `${tool} ${t}`, /^(dev|run|serve|start|watch)$/.test(t) ? 'service' : 'action'));
    if (out.length >= MAKE_MAX) break;
  }
  return out;
}

// Top-level service names under services:, and each one's first host port.
function composeServices(text: string) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (at < 0) return [];
  const out: { name: string; port?: number }[] = [];
  let indent = -1;
  let inPorts = false;
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^(\s+)([\w.-]+):\s*(#.*)?$/.exec(line);
    const depth = line.search(/\S/);
    if (m && (indent < 0 || depth === indent)) {
      indent = depth;
      out.push({ name: m[2]! });
      inPorts = false;
      continue;
    }
    const cur = out[out.length - 1];
    if (!cur) continue;
    if (/^\s+ports:\s*$/.test(line)) inPorts = true;
    else if (inPorts) {
      const p = /^\s+-\s*['"]?(?:[\d.]+:)?(\d{2,5}):\d+/.exec(line);
      if (p) cur.port ??= Number(p[1]);
      else if (!/^\s+-/.test(line)) inPorts = false;
    }
  }
  return out;
}

const SCRIPT_RUNNER: Record<string, string> = { '.sh': 'bash', '.mjs': 'node', '.js': 'node', '.ts': 'node', '.py': 'python3' };

export async function detect(dir: string): Promise<Found> {
  const commands: RunCommand[] = [];
  const sources: string[] = [];
  const pkgText = await read(join(dir, 'package.json'));
  const pkg = json(pkgText);
  let pm: string | null = null;
  if (pkg) {
    pm = await pmOf(dir, pkg);
    sources.push('package.json');
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    commands.push(...(await packageScripts(dir, pm, scripts)));
    const rootDev = Object.keys(scripts).some((n) => /^dev(:|$)/.test(n));
    for (const rel of await workspaceDirs(dir, pkg)) {
      const sub = json(await read(join(dir, rel, 'package.json')));
      const subScripts = (sub?.scripts && typeof sub.scripts === 'object' ? sub.scripts : {}) as Record<string, string>;
      const name = basename(rel);
      for (const n of Object.keys(subScripts)) {
        const body = subScripts[n];
        if (typeof body !== 'string' || !(/^dev(:|$)/.test(n) || (n === 'start' && !('dev' in subScripts)))) continue;
        // The root dev usually starts these through turbo or -r, so they stay in Edit until shown.
        commands.push(cmd('workspace', `ws:${rel}:${n}`, n === 'dev' ? name : `${name} · ${n}`, runScript(pm, n), 'service', rel, {
          port: portOf(body, await vitePort(join(dir, rel))), web: WEB_BODY.test(body), ...(rootDev ? { hidden: true } : {}),
        }));
      }
    }
    if (await exists(join(dir, 'turbo.json'))) sources.push('turbo.json');
  }
  for (const [file, tool] of [['Makefile', 'make'], ['makefile', 'make'], ['justfile', 'just'], ['Justfile', 'just']] as const) {
    const text = await read(join(dir, file));
    if (!text) continue;
    sources.push(file);
    commands.push(...makeTargets(text, tool, tool === 'make' ? 'Makefile' : 'justfile'));
    break;
  }
  for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
    const text = await read(join(dir, file));
    if (!text) continue;
    sources.push(file);
    for (const s of composeServices(text)) commands.push(cmd('compose', `compose::${s.name}`, s.name, `docker compose up ${s.name}`, 'service', '', s.port ? { port: s.port } : {}));
    commands.push(cmd('compose', 'compose::down', 'compose down', 'docker compose down', 'action'));
    commands.push(cmd('compose', 'compose::down-v', 'Remove containers and volumes', 'docker compose down -v', 'action'));
    break;
  }
  const procfile = await read(join(dir, 'Procfile'));
  if (procfile) {
    sources.push('Procfile');
    for (const m of procfile.matchAll(/^([\w-]+):\s*(.+)$/gm)) commands.push(cmd('Procfile', `proc::${m[1]}`, m[1]!, m[2]!.trim(), 'service'));
  }
  const cargo = await read(join(dir, 'Cargo.toml'));
  if (cargo) {
    sources.push('Cargo.toml');
    if (/^\[package\]/m.test(cargo) && ((await exists(join(dir, 'src/main.rs'))) || /^\[\[bin\]\]/m.test(cargo))) commands.push(cmd('Cargo', 'cargo::run', 'cargo run', 'cargo run', 'service'));
    commands.push(cmd('Cargo', 'cargo::check', 'cargo check', 'cargo check', 'action'), cmd('Cargo', 'cargo::test', 'cargo test', 'cargo test', 'action'));
  }
  // The learn-app playbook's helper scripts (seed, reset, login).
  const qa = join(dir, '.claude/skills/app-qa/scripts');
  const scripts = await readdir(qa).catch(() => [] as string[]);
  for (const f of scripts.sort()) {
    const runner = SCRIPT_RUNNER[extname(f)];
    if (!runner) continue;
    if (!sources.includes('app-qa')) sources.push('app-qa');
    commands.push(cmd('app-qa', `qa::${f}`, basename(f, extname(f)), `${runner} ${q(relative(dir, join(qa, f)))}`, 'action'));
  }
  return { commands, pm, sources };
}

// What the finder agent reads: the project files that name commands, cut to a few KB each. Never .env files.
export async function finderContext(dir: string) {
  const parts: string[] = [];
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  parts.push(`Top-level entries: ${ents.slice(0, 80).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(', ')}`);
  for (const f of ['README.md', 'package.json', 'Makefile', 'justfile', 'compose.yaml', 'docker-compose.yml', 'Procfile', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Taskfile.yml', '.claude/skills/app-qa/SKILL.md', 'CLAUDE.md', 'AGENTS.md']) {
    const text = await read(join(dir, f));
    if (text) parts.push(`--- ${f} ---\n${text.slice(0, f === 'package.json' ? 6000 : 4000)}`);
  }
  return parts.join('\n\n');
}
