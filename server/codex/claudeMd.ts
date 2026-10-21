import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The user's Claude Code CLAUDE.md, for Codex threads when Codex has no global AGENTS.md of its own.
const DEPTH_MAX = 5;
const SIZE_MAX = 40_000;
const FILE_MAX = 1 << 20;
const IMPORT = /^\s*@(\S+)\s*$/;
const FENCE = /^\s*(```|~~~)/;

const exists = (p: string) => access(p).then(() => true, () => false);
const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Inlines `@path` lines the way Claude Code imports them; a missing, oversized or already seen file leaves its line as it is.
async function expand(path: string, depth: number, seen: Set<string>): Promise<string | null> {
  if (seen.has(path)) return null;
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || st.size > FILE_MAX) return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  seen.add(path);
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const m = fenced || depth >= DEPTH_MAX ? null : IMPORT.exec(line);
    const ref = m?.[1];
    const sub = ref ? await expand(ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : resolve(dirname(path), ref), depth + 1, seen) : null;
    out.push(sub ?? line);
  }
  return out.join('\n');
}

// Read on every thread start, so edits apply to the next one; null when Codex has its own global file or there is nothing to add.
export async function claudeUserDoc(): Promise<string | null> {
  const home = codexHome();
  if ((await exists(join(home, 'AGENTS.override.md'))) || (await exists(join(home, 'AGENTS.md')))) return null;
  const text = (await expand(join(claudeHome(), 'CLAUDE.md'), 0, new Set()))?.trim();
  if (!text) return null;
  return text.length > SIZE_MAX ? `${text.slice(0, SIZE_MAX)}\n\n[The rest was cut at ${SIZE_MAX / 1000} KB.]` : text;
}
