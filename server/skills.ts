import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { Provider, SkillCatalog, SkillInfo, SkillOrigin, SkillPick } from './protocol.ts';
import { oneLine } from './text.ts';
import { fullText } from './stretch.ts';
import { ask, type Asking } from './titles.ts';
import { CACHE_DIR } from './config.ts';

const HOME = homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
const CODEX = process.env.CODEX_HOME || join(HOME, '.codex');
const TTL_MS = 30_000;
// Enough for any frontmatter; the body is never needed.
const HEAD_BYTES = 12_288;
const DESC_MAX = 1200;
const NEST_DEPTH = 3;
const PROJECTS_MAX = 20;

type LinkOf = (rel: string) => string | null;
// fp fingerprints the text read, so an edited skill gets its author checked again.
type Raw = { dir: string; name: string; desc: string; path: string; link: string | null; author: string | null; fp: string; children: Raw[] };
// prefix turns a folder name into its slash command ("figma:"); slash is false for Codex, which has none.
type Group = { origin: SkillOrigin; prefix: string; slash: boolean; raws: Raw[] };

const noLink: LinkOf = () => null;

async function list(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isDir(p: string) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function head(path: string) {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// Top-level keys of a YAML frontmatter: plain, quoted, folded (>) and literal (|) values.
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i]);
    const v = kv[2].trim();
    const block = /^([>|])[-+]?$/.exec(v);
    if (block) {
      const body = more.map((l) => l.trim());
      out[kv[1]] = (block[1] === '>' ? body.join(' ') : body.join('\n')).trim();
      continue;
    }
    const joined = [v, ...more.map((l) => l.trim())].filter(Boolean).join(' ');
    if (joined.startsWith('"')) {
      try {
        out[kv[1]] = JSON.parse(joined);
      } catch {
        out[kv[1]] = joined.replace(/^"|"$/g, '');
      }
    } else if (joined.startsWith("'")) out[kv[1]] = joined.replace(/^'|'$/g, '').replace(/''/g, "'");
    else out[kv[1]] = joined;
  }
  return out;
}

// A browsable https URL from a package-style repository field, or null.
function webUrl(u: unknown): string | null {
  if (u && typeof u === 'object' && 'url' in u) u = (u as { url: unknown }).url;
  if (typeof u !== 'string') return null;
  let s = u.trim().replace(/^git\+/, '');
  const ssh = /^git@([^:]+):(.+)$/.exec(s);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  return /^https?:\/\/\S+$/.test(s) ? s : null;
}

// A homepage that is just a company's front page says nothing about the plugin.
const page = (u: unknown) => {
  const s = webUrl(u);
  return s && new URL(s).pathname.length > 1 ? s : null;
};

const ghRepo = (repo: unknown) => (typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : null);

// A folder inside a repo: GitHub gets a tree link, other hosts just the repo.
function inRepo(base: string, dir: string) {
  const d = dir.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return d && d !== '.' && base.startsWith('https://github.com/') ? `${base}/tree/HEAD/${d}` : base;
}

async function readSkill(dir: string, rel: string, linkOf: LinkOf, nest: boolean): Promise<Raw | null> {
  const path = join(dir, 'SKILL.md');
  const text = await head(path);
  if (text === null) return null;
  const fm = frontmatter(text);
  const source = webUrl(fm.source);
  const folder = dir.split('/').pop()!;
  const link = source ?? linkOf(rel);
  // Without an author: field, the GitHub owner of the source repo stands in.
  const author = (fm.author ?? '').trim().slice(0, 80) || (link && /^https:\/\/github\.com\/([\w.-]+)\//.exec(link)?.[1]) || null;
  return {
    dir: folder, name: (fm.name ?? '').trim() || folder, desc: (fm.description ?? '').slice(0, DESC_MAX), path,
    link, author, fp: fingerprint(text), children: nest ? await nested(dir, dir, linkOf, 1) : [],
  };
}

const fingerprint = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16);

// SKILL.md files further down a skill folder (references/animations/SKILL.md); a found one ends that branch.
async function nested(root: string, dir: string, linkOf: LinkOf, depth: number): Promise<Raw[]> {
  if (depth > NEST_DEPTH) return [];
  const found = await Promise.all(
    (await list(dir)).map(async (e) => {
      if (e.name.startsWith('.') || e.name === 'node_modules') return [];
      const p = join(dir, e.name);
      if (!e.isDirectory() && !(e.isSymbolicLink() && (await isDir(p)))) return [];
      if (await isFile(join(p, 'SKILL.md'))) {
        const own = await readSkill(p, relative(root, p), linkOf, false);
        return own ? [own] : [];
      }
      return nested(root, p, linkOf, depth + 1);
    }),
  );
  return found.flat().sort((a, b) => a.name.localeCompare(b.name));
}

// Skill folders right under root; symlinked ones (into ~/.agents/skills) count.
async function skillsIn(root: string, linkFor: (folder: string) => LinkOf = () => noLink, skip: Set<string> = new Set()): Promise<Raw[]> {
  const found = await Promise.all(
    (await list(root)).map(async (e) => {
      if (e.name.startsWith('.') || skip.has(e.name)) return null;
      const p = join(root, e.name);
      if (!e.isDirectory() && !(e.isSymbolicLink() && (await isDir(p)))) return null;
      if (!(await isFile(join(p, 'SKILL.md')))) return null;
      return readSkill(p, '', linkFor(e.name), true);
    }),
  );
  return found.filter((r): r is Raw => !!r).sort((a, b) => a.name.localeCompare(b.name));
}

// Where `npx skills` installed a skill from: skills[name].sourceUrl plus its skillPath.
async function lockLinks(): Promise<(folder: string) => LinkOf> {
  const lock = await json(join(HOME, '.agents', '.skill-lock.json'));
  const skills = (lock?.skills ?? {}) as Record<string, { sourceUrl?: unknown; skillPath?: unknown }>;
  return (folder) => {
    const e = skills[folder];
    const base = webUrl(e?.sourceUrl);
    if (!base) return noLink;
    const dir = typeof e?.skillPath === 'string' ? dirname(e.skillPath) : '';
    return (rel) => inRepo(base, rel ? join(dir, rel) : dir);
  };
}

// A plugin's skill folders: skills/ plus any the manifest names.
async function pluginSkills(root: string, manifest: Record<string, unknown> | null, link: string | null): Promise<Raw[]> {
  const extra = manifest?.skills;
  const dirs = ['skills', ...(typeof extra === 'string' ? [extra] : Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string') : [])];
  const roots = [...new Set(dirs.map((d) => resolve(root, d)))].filter((d) => d.startsWith(root));
  const linkOf: LinkOf = () => link;
  const out: Raw[] = [];
  for (const d of roots) {
    if (await isFile(join(d, 'SKILL.md'))) {
      const own = await readSkill(d, '', linkOf, true);
      if (own) out.push(own);
    } else out.push(...(await skillsIn(d, () => linkOf)));
  }
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.path) && seen.add(r.path));
}

// Claude Code plugins from installed_plugins.json, skipping ones switched off in settings.
async function claudePlugins(): Promise<Group[]> {
  const [installed, settings, known] = await Promise.all([
    json(join(CLAUDE, 'plugins', 'installed_plugins.json')),
    json(join(CLAUDE, 'settings.json')),
    json(join(CLAUDE, 'plugins', 'known_marketplaces.json')),
  ]);
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>;
  const plugins = (installed?.plugins ?? {}) as Record<string, { scope?: string; installPath?: string }[]>;
  const groups = await Promise.all(
    Object.entries(plugins).map(async ([id, entries]): Promise<Group | null> => {
      if (enabled[id] === false) return null;
      const entry = (Array.isArray(entries) ? entries : []).find((e) => e.scope === 'user' && typeof e.installPath === 'string');
      if (!entry) return null;
      const [name, market] = id.split('@');
      const root = entry.installPath!;
      const manifest = await json(join(root, '.claude-plugin', 'plugin.json'));
      const mk = (known?.[market] ?? {}) as { installLocation?: string; source?: { source?: string; repo?: string; url?: string } };
      const listing = mk.installLocation ? await json(join(mk.installLocation, '.claude-plugin', 'marketplace.json')) : null;
      const item = ((listing?.plugins ?? []) as Record<string, unknown>[]).find((p) => p?.name === name);
      const src = item?.source as { source?: string; repo?: string; url?: string } | string | undefined;
      const marketRepo = mk.source?.source === 'github' ? ghRepo(mk.source.repo) : webUrl(mk.source?.url);
      const link = webUrl(manifest?.repository) ?? page(manifest?.homepage) ?? webUrl(item?.repository) ?? page(item?.homepage)
        ?? (typeof src === 'object' ? (src.source === 'github' ? ghRepo(src.repo) : webUrl(src.url)) : typeof src === 'string' ? marketRepo : null);
      const raws = await pluginSkills(root, manifest, link);
      if (!raws.length) return null;
      return { origin: { key: `plugin:${name}`, label: name, kind: 'plugin' }, prefix: `${name}:`, slash: true, raws };
    }),
  );
  return groups.filter((g): g is Group => !!g).sort((a, b) => a.origin.label.localeCompare(b.origin.label));
}

// Skills synced from claude.ai live in synced/<account>/; the SDK lists them as anthropic-skills:<name>.
async function synced(skip: Set<string>): Promise<Raw[]> {
  const root = join(CLAUDE, 'skills', 'synced');
  const per = await Promise.all((await list(root)).filter((e) => !e.name.startsWith('.')).map((e) => skillsIn(join(root, e.name), undefined, skip)));
  const seen = new Set<string>();
  return per.flat().filter((r) => !seen.has(r.dir) && seen.add(r.dir));
}

// Codex plugins: cache/<marketplace>/<plugin>/<version>/, the newest version of each.
async function codexPlugins(): Promise<Group[]> {
  const cache = join(CODEX, 'plugins', 'cache');
  const plugins = (await Promise.all((await list(cache)).filter((m) => m.isDirectory()).map(async (m) => (await list(join(cache, m.name))).filter((p) => p.isDirectory()).map((p) => join(cache, m.name, p.name))))).flat();
  const groups = await Promise.all(
    plugins.map(async (dir): Promise<Group | null> => {
      const versions = await Promise.all((await list(dir)).filter((v) => v.isDirectory()).map(async (v) => ({ p: join(dir, v.name), t: (await stat(join(dir, v.name)).catch(() => null))?.mtimeMs ?? 0 })));
      const root = versions.sort((a, b) => b.t - a.t)[0]?.p;
      if (!root) return null;
      const manifest = await json(join(root, '.codex-plugin', 'plugin.json'));
      const name = typeof manifest?.name === 'string' ? manifest.name : dir.split('/').pop()!;
      const raws = await pluginSkills(root, manifest, webUrl(manifest?.repository) ?? page(manifest?.homepage));
      if (!raws.length) return null;
      return { origin: { key: `codex-plugin:${name}`, label: name, kind: 'codex-plugin' }, prefix: `codex:${name}:`, slash: false, raws };
    }),
  );
  return groups.filter((g): g is Group => !!g).sort((a, b) => a.origin.label.localeCompare(b.origin.label));
}

async function scanGlobal(): Promise<Group[]> {
  const links = await lockLinks();
  const userDir = join(CLAUDE, 'skills');
  const [user, plugins, codexOwn, codexSystem, cxPlugins] = await Promise.all([
    skillsIn(userDir, links, new Set(['synced'])),
    claudePlugins(),
    skillsIn(join(CODEX, 'skills')),
    skillsIn(join(CODEX, 'skills', '.system')),
    codexPlugins(),
  ]);
  // A synced skill also installed by hand shows once, under My skills.
  const sync = await synced(new Set(user.map((r) => r.dir)));
  const codex = [...codexOwn, ...codexSystem].sort((a, b) => a.name.localeCompare(b.name));
  return [
    { origin: { key: 'user', label: 'My skills', kind: 'user' }, prefix: '', slash: true, raws: user },
    ...plugins,
    { origin: { key: 'synced', label: 'anthropic-skills', kind: 'synced' }, prefix: 'anthropic-skills:', slash: true, raws: sync },
    { origin: { key: 'codex', label: 'Codex skills', kind: 'codex' }, prefix: 'codex:', slash: false, raws: codex },
    ...cxPlugins,
  ];
}

// .claude/skills in the session folder and its parents, below home (home's own is My skills).
async function scanProject(cwd: string): Promise<Group | null> {
  const dirs: string[] = [];
  for (let d = resolve(cwd); d.startsWith(HOME + '/') && dirs.length < 8; d = dirname(d)) dirs.push(join(d, '.claude', 'skills'));
  const raws = (await Promise.all(dirs.map((d) => skillsIn(d)))).flat();
  return raws.length ? { origin: { key: 'project', label: 'This project', kind: 'project' }, prefix: '', slash: true, raws } : null;
}

type Cached<T> = { at: number; value: Promise<T> };
let global: Cached<Group[]> | null = null;
const projects = new Map<string, Cached<Group | null>>();

// The next catalog reads the disk again; called after Organize stored new authors.
export function invalidateSkills() {
  global = null;
  projects.clear();
}

// Authors Organize found, by SKILL.md path; null means checked and none found. Skill files are never written.
type Inferred = { fp: string; author: string | null; at: number };
const AUTHORS_FILE = join(CACHE_DIR, 'skill-authors.json');
const AUTHORS_MAX = 3000;
let authors: Promise<Map<string, Inferred>> | null = null;
let saving: Promise<void> = Promise.resolve();

function loadAuthors() {
  authors ??= readFile(AUTHORS_FILE, 'utf8')
    .then((t) => {
      const raw: unknown = JSON.parse(t);
      const m = new Map<string, Inferred>();
      for (const [p, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        const e = v as Partial<Inferred> | null;
        if (e && typeof e.fp === 'string' && (e.author === null || typeof e.author === 'string')) m.set(p, { fp: e.fp, author: e.author, at: typeof e.at === 'number' ? e.at : 0 });
      }
      return m;
    })
    .catch(() => new Map<string, Inferred>());
  return authors;
}

// prune drops entries whose file is gone; the newest AUTHORS_MAX stay. Written to a temp file first, so a crash keeps the old one.
function saveAuthors(m: Map<string, Inferred>, prune: boolean) {
  saving = saving
    .then(async () => {
      if (prune) for (const p of await Promise.all([...m.keys()].map(async (p) => ((await isFile(p)) ? null : p)))) if (p) m.delete(p);
      const keep = [...m].sort((a, b) => b[1].at - a[1].at).slice(0, AUTHORS_MAX);
      if (keep.length < m.size) {
        m.clear();
        for (const [p, e] of keep) m.set(p, e);
      }
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(AUTHORS_FILE + '.tmp', JSON.stringify(Object.fromEntries(keep)));
      await rename(AUTHORS_FILE + '.tmp', AUTHORS_FILE);
    })
    .catch((err) => console.error(`skills: saving inferred authors failed: ${err instanceof Error ? err.message : String(err)}`));
  return saving;
}

function cached<T>(hit: Cached<T> | null | undefined, load: () => Promise<T>): Cached<T> {
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  return { at: Date.now(), value: load() };
}

// Every skill on disk, keyed by the slash names the session's CLI actually offers.
export async function skillCatalog(cwd: string | null, slashNames: string[]): Promise<SkillCatalog> {
  global = cached(global, scanGlobal);
  let project: Promise<Group | null> = Promise.resolve(null);
  if (cwd) {
    const hit = cached(projects.get(cwd), () => scanProject(cwd));
    projects.delete(cwd);
    projects.set(cwd, hit);
    while (projects.size > PROJECTS_MAX) projects.delete(projects.keys().next().value!);
    project = hit.value;
  }
  const [groups, own, inferred] = await Promise.all([global.value, project, loadAuthors()]);
  const all = own ? [groups[0], own, ...groups.slice(1)] : groups;
  return build(all.filter((g) => g.raws.length), new Set(slashNames), inferred);
}

// Frontmatter author: or the GitHub owner first, then what Organize stored for this exact text.
type Who = { author?: string; authorInferred?: true; pending?: true };
function whoOf(r: Raw, inferred: Map<string, Inferred>): Who {
  if (r.author) return { author: r.author };
  const e = inferred.get(r.path);
  if (!e || e.fp !== r.fp) return { pending: true };
  return e.author ? { author: e.author, authorInferred: true } : {};
}

// Skills with no author that Organize has not read yet, per catalog.
type Pending = { key: string; name: string; path: string };
const pendingOf = new WeakMap<SkillCatalog, Pending[]>();

function build(groups: Group[], slash: Set<string>, inferred: Map<string, Inferred>): SkillCatalog {
  const pending: Pending[] = [];
  const authorOf = (w: Who) => ({ ...(w.author ? { author: w.author } : {}), ...(w.authorInferred ? { authorInferred: true as const } : {}) });
  const keys = new Set<string>();
  const unique = (k: string, origin: string) => {
    let key = keys.has(k) ? `${k}@${origin}` : k;
    for (let i = 2; keys.has(key); i++) key = `${k}@${origin}${i}`;
    keys.add(key);
    return key;
  };
  const skills: SkillInfo[] = [];
  for (const g of groups) {
    for (const r of g.raws) {
      const names = [...new Set([r.dir, r.name])].map((n) => g.prefix + n);
      const cmd = g.slash ? names.find((n) => slash.has(n)) : undefined;
      const key = unique(cmd ?? names[0], g.origin.key);
      const who = whoOf(r, inferred);
      if (who.pending) pending.push({ key, name: r.name, path: r.path });
      skills.push({ key, name: r.name, desc: r.desc, path: r.path, origin: g.origin.key, ...(cmd ? { cmd } : {}), ...(r.link ? { link: r.link } : {}), ...authorOf(who) });
      for (const c of r.children) {
        const ckey = unique(`${key}/${c.name}`, g.origin.key);
        // Sub-skills inherit the parent's author when they have none of their own.
        const own = whoOf(c, inferred);
        const cw = own.author ? own : who.author ? { author: who.author, ...(who.authorInferred ? { authorInferred: true as const } : {}) } : own;
        if (cw.pending) pending.push({ key: ckey, name: c.name, path: c.path });
        skills.push({ key: ckey, name: c.name, desc: c.desc, path: c.path, origin: g.origin.key, parent: key, ...(c.link ? { link: c.link } : {}), ...authorOf(cw) });
      }
    }
  }
  const catalog: SkillCatalog = { origins: groups.map((g) => g.origin), skills, authorsPending: pending.length };
  pendingOf.set(catalog, pending);
  return catalog;
}

// What the suggestion reads about the chat: chapter titles and the last few prompts and replies.
export type SkillContext = { draft: string; titles: string[]; turns: { prompt: string; reply: string }[] };

const PICKS = 5;
const TITLES = 30;
const CATALOG_DESC = 140;
const TIMEOUT_MS = 45_000;
const SYSTEM = 'You pick agent skills (instruction files a coding agent reads) that fit what a user is working on. Reply with JSON only, no prose and no code fence.';

function promptFor(ctx: SkillContext, skills: SkillInfo[]) {
  const turns = ctx.turns.map((t) => {
    const reply = t.reply.trim() ? oneLine(fullText(t.reply).slice(-600), 600) : '(no reply text)';
    return `User: ${oneLine(t.prompt, 700)}\nAgent reply, last part: ${reply}`;
  });
  const catalog = skills.map((s) => `${s.key}: ${oneLine(s.desc, CATALOG_DESC) || s.name}`);
  return [
    `Pick at most ${PICKS} skills from the catalog that would clearly help with what the user is doing or about to do, best first.`,
    'The draft the user is typing now matters most; the session so far gives context. Skip loose matches; an empty list is a fine answer.',
    `For each pick, "why" is one short sentence (at most 16 words) on how it helps, written in the same language as the user's messages.`,
    'Answer with a JSON array like [{"key":"gsap-core","why":"..."}], using keys exactly as the catalog writes them.',
    '',
    `Draft being typed: ${ctx.draft.trim() ? oneLine(ctx.draft, 1500) : '(empty)'}`,
    ctx.titles.length ? `Session chapters, oldest first: ${ctx.titles.slice(-TITLES).map((t) => oneLine(t, 80)).join(' · ')}` : '',
    turns.length ? `Recent turns, oldest first:\n${turns.join('\n\n')}` : '',
    '',
    'Catalog (key: description):',
    catalog.join('\n'),
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

function parse(text: string, skills: SkillInfo[]): SkillPick[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let arr: unknown = [];
  try {
    if (start >= 0 && end > start) arr = JSON.parse(text.slice(start, end + 1));
  } catch {}
  const byKey = new Map(skills.map((s) => [s.key, s]));
  // A model that answers with a display name still lands when that name is unique.
  const byName = new Map<string, SkillInfo | null>();
  for (const s of skills) byName.set(s.name, byName.has(s.name) ? null : s);
  const picks: SkillPick[] = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    const { key, name, why } = (o ?? {}) as { key?: unknown; name?: unknown; why?: unknown };
    const k = typeof key === 'string' ? key.trim().replace(/^\//, '') : typeof name === 'string' ? name.trim() : '';
    const s = byKey.get(k) ?? byName.get(k);
    if (!s || picks.some((p) => p.key === s.key)) continue;
    picks.push({ key: s.key, why: typeof why === 'string' ? oneLine(why, 160) : '' });
    if (picks.length >= PICKS) break;
  }
  return picks;
}

// One suggestion per client: a new one closes the model call still running, and the old one gets no answer.
export class SkillSuggest {
  private n = 0;
  private q: Asking | null = null;

  // null: superseded by a newer request or stopped.
  async run(catalog: SkillCatalog, ctx: SkillContext, provider: Provider): Promise<{ picks: SkillPick[]; error?: string } | null> {
    const n = this.stop();
    if (!ctx.draft.trim() && !ctx.turns.length) return { picks: [], error: 'Write what you want to do first, then ask again' };
    if (!catalog.skills.length) return { picks: [], error: 'No skills found on this machine' };
    const t0 = performance.now();
    let text: string | null = null;
    try {
      text = await ask(promptFor(ctx, catalog.skills), (q) => n === this.n && (this.q = q), SYSTEM, { provider, maxTokens: 800, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      if (n === this.n) console.error(`skills: suggestion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (n !== this.n) return null;
    if (text === null) return { picks: [], error: "Couldn't get suggestions, try again" };
    const picks = parse(text, catalog.skills);
    console.log(`skills: suggested ${picks.length} of ${catalog.skills.length} (${provider}) in ${Math.round(performance.now() - t0)} ms`);
    return { picks };
  }

  stop() {
    this.q?.close();
    this.q = null;
    return ++this.n;
  }
}

const ORG_BATCH = 20;
const ORG_EXCERPT = 1500;
const ORG_TIMEOUT_MS = 90_000;
const ORG_SYSTEM = 'You read the start of agent skill files and report who made each one. Reply with JSON only, no prose and no code fence.';

type OrgItem = Pending & { text: string; fp: string };

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const afterFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---[^\n]*(\n|$)/, '').trim().slice(0, ORG_EXCERPT);

function orgPrompt(items: OrgItem[]) {
  return [
    'For each skill below, find the person, company or project its text names as the author or maker: a byline, "made by", "maintained by", a copyright line, or "the official X skill".',
    'Do not guess from the topic or from a library or tool the skill only talks about. When the text names no author, use null.',
    '"quote" is the exact words from that skill\'s text that name the author, copied character for character; use "" with null.',
    `Answer with a JSON array of ${items.length} objects like [{"key":"...","author":"Name","quote":"..."},{"key":"...","author":null,"quote":""}], using keys exactly as given.`,
    '',
    items.map((it) => `Skill key: ${it.key}\nName: ${it.name}\nText:\n"""\n${it.text}\n"""`).join('\n\n'),
  ].join('\n');
}

// An author counts only when its quote is really in that skill's text and names it; anything else is stored as none.
function orgParse(reply: string, items: OrgItem[]) {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  let arr: unknown = [];
  try {
    if (start >= 0 && end > start) arr = JSON.parse(reply.slice(start, end + 1));
  } catch {}
  const byKey = new Map(items.map((it) => [it.key, it]));
  const out = new Map<string, string | null>();
  for (const o of Array.isArray(arr) ? arr : []) {
    const { key, author, quote } = (o ?? {}) as { key?: unknown; author?: unknown; quote?: unknown };
    const it = typeof key === 'string' ? byKey.get(key.trim()) : undefined;
    if (!it || out.has(it.key)) continue;
    const a = typeof author === 'string' ? oneLine(author, 80) : '';
    const q = typeof quote === 'string' ? norm(quote) : '';
    out.set(it.key, a && q && norm(it.text).includes(q) && q.includes(norm(a)) ? a : null);
  }
  return out;
}

// One Organize run per client, in batches; a stop closes the call in flight and keeps what earlier batches stored.
export class SkillOrganize {
  private n = 0;
  private q: Asking | null = null;

  // null: stopped or superseded. provider undefined lets ask() pick the signed-in account.
  async run(catalog: SkillCatalog, provider: Provider | undefined, progress: (done: number, total: number) => void): Promise<{ found: number; checked: number; error?: string } | null> {
    const n = this.stop();
    const todo = pendingOf.get(catalog) ?? [];
    if (!todo.length) return { found: 0, checked: 0 };
    const store = await loadAuthors();
    let done = 0;
    let found = 0;
    progress(0, todo.length);
    try {
      for (let i = 0; i < todo.length; i += ORG_BATCH) {
        const batch = todo.slice(i, i + ORG_BATCH);
        const read = await Promise.all(batch.map(async (s) => {
          const text = await head(s.path);
          return text === null ? null : { ...s, text: afterFrontmatter(text), fp: fingerprint(text) };
        }));
        if (n !== this.n) return null;
        const items = read.filter((it): it is OrgItem => !!it);
        const asked = items.filter((it) => it.text);
        let got = new Map<string, string | null>();
        if (asked.length) {
          let reply: string | null = null;
          try {
            reply = await ask(orgPrompt(asked), (q) => n === this.n && (this.q = q), ORG_SYSTEM, { ...(provider ? { provider } : {}), maxTokens: 2000, timeoutMs: ORG_TIMEOUT_MS });
          } catch (e) {
            if (n === this.n) console.error(`skills: organize failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (n !== this.n) return null;
          if (reply === null) return { found, checked: done, error: "Couldn't read the skills, try again" };
          got = orgParse(reply, asked);
        }
        const at = Date.now();
        for (const it of items) {
          const a = got.get(it.key) ?? null;
          store.set(it.path, { fp: it.fp, author: a, at });
          if (a) found++;
        }
        done += batch.length;
        void saveAuthors(store, false);
        progress(done, todo.length);
      }
      console.log(`skills: organize found ${found} authors in ${done} skills (${provider ?? 'default'})`);
      return { found, checked: done };
    } finally {
      await saveAuthors(store, true);
    }
  }

  stop() {
    this.q?.close();
    this.q = null;
    return ++this.n;
  }
}
