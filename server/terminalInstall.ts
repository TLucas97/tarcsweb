import { createHash } from 'node:crypto';
import { chmod, copyFile, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { HOOK_DIR, HOOK_SCRIPT } from './terminal.ts';
import { diffLines } from './changes.ts';
import type { DiffDetail, DiffLine, TerminalHooksView } from './protocol.ts';

// CW_CLAUDE_SETTINGS points checks at a copy, so the real file stays untouched.
const SETTINGS = process.env.CW_CLAUDE_SETTINGS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
// What marks an entry as ours, wherever the script lives.
const MARK = 'terminal-hook.mjs';
const BACKUPS_KEPT = 3;
const CONTEXT = 3;
const DIFF_MAX = 600;

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
// The full Node path, since a claude started without nvm loaded has no node on PATH.
const COMMAND = `${quote(process.execPath)} ${quote(HOOK_SCRIPT)} ${quote(HOOK_DIR)}`;
// PermissionRequest outlasts the hook's own 125 s wait. Tool results come often, so their hooks never block the turn.
const EVENTS: [string, Record<string, unknown>][] = [
  ['PermissionRequest', { timeout: 130 }],
  ['SessionStart', { timeout: 10 }],
  ['UserPromptSubmit', { timeout: 10 }],
  ['Notification', { timeout: 10 }],
  ['Stop', { timeout: 10 }],
  ['StopFailure', { timeout: 10 }],
  ['SessionEnd', { timeout: 10 }],
  ['PostToolUse', { timeout: 10, async: true }],
  ['PostToolUseFailure', { timeout: 10, async: true }],
];

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const ours = (h: unknown) => isObj(h) && typeof h.command === 'string' && h.command.includes(MARK);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const lines = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);

// The file's text (null when missing) and its parsed value; throws with a readable reason.
async function load(): Promise<{ text: string | null; data: Raw }> {
  let text: string | null = null;
  try {
    text = await readFile(SETTINGS, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${SETTINGS}: ${(e as Error).message}`);
  }
  if (text === null || !text.trim()) return { text, data: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${SETTINGS} is not valid JSON, so it was left alone: ${(e as Error).message}`);
  }
  if (!isObj(data)) throw new Error(`${SETTINGS} does not hold a JSON object, so it was left alone`);
  if (data.hooks !== undefined && !isObj(data.hooks)) throw new Error(`"hooks" in ${SETTINGS} is not an object, so it was left alone`);
  return { text, data };
}

// Removes only the hook entries this app added; groups and events left empty go too.
function strip(hooks: Raw): Raw {
  const out: Raw = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[ev] = groups;
      continue;
    }
    const kept = groups.flatMap((g) => {
      if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some(ours)) return [g];
      const rest = g.hooks.filter((h) => !ours(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length) out[ev] = kept;
  }
  return out;
}

function next(data: Raw, on: boolean): Raw {
  const hooks = strip(isObj(data.hooks) ? data.hooks : {});
  if (on) {
    for (const [ev, opts] of EVENTS) {
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
      hooks[ev] = [...list, { hooks: [{ type: 'command', command: COMMAND, ...opts }] }];
    }
  }
  const out = { ...data };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

function status(data: Raw): { installed: boolean; partial: boolean } {
  const hooks = isObj(data.hooks) ? data.hooks : {};
  const has = EVENTS.filter(([ev]) => Array.isArray(hooks[ev]) && (hooks[ev] as unknown[]).some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(ours)));
  return { installed: has.length > 0, partial: has.length > 0 && has.length < EVENTS.length };
}

const serialize = (data: Raw) => JSON.stringify(data, null, 2) + '\n';

export async function hooksView(): Promise<TerminalHooksView> {
  try {
    return { ...status((await load()).data), path: SETTINGS, error: null };
  } catch (e) {
    return { installed: false, partial: false, path: SETTINGS, error: (e as Error).message };
  }
}

// The changed lines with a little context; long unchanged runs fold into one ⋯ line.
function diffOf(before: string | null, after: string): DiffDetail {
  const all = diffLines(lines(before ?? ''), lines(after));
  const near = (i: number) => all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l[0] !== ' ');
  const out: DiffLine[] = [];
  all.forEach((l, i) => {
    if (l[0] !== ' ' || near(i)) out.push(l);
    else if (out.at(-1)?.[1] !== '⋯') out.push([' ', '⋯']);
  });
  const shown = out.slice(0, DIFF_MAX);
  return {
    kind: 'diff', path: SETTINGS, add: all.filter((l) => l[0] === '+').length, rm: all.filter((l) => l[0] === '-').length,
    lines: shown, more: out.length - shown.length, created: before === null,
  };
}

// Turning off with nothing installed leaves the file as it is, formatting included.
const target = (text: string | null, data: Raw, on: boolean) => (!on && !status(data).installed ? text : serialize(next(data, on)));

export async function previewHooks(on: boolean): Promise<{ diff: DiffDetail | null; base: string; error: string | null }> {
  try {
    const { text, data } = await load();
    const after = target(text, data, on);
    if (after === null) return { diff: null, base: sha(text ?? ''), error: null };
    return { diff: after === text ? null : diffOf(text, after), base: sha(text ?? ''), error: null };
  } catch (e) {
    return { diff: null, base: '', error: (e as Error).message };
  }
}

// Keeps the newest few backups; the ISO stamp in the name sorts by time.
async function pruneBackups() {
  const prefix = `${basename(SETTINGS)}.tarcsweb-`;
  const old = (await readdir(dirname(SETTINGS))).filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).sort().slice(0, -BACKUPS_KEPT);
  for (const f of old) await rm(join(dirname(SETTINGS), f), { force: true });
}

let chain: Promise<unknown> = Promise.resolve();

// Re-reads the file and refuses when it changed since the preview; backs it up next to itself, then swaps it in.
export function setHooks(on: boolean, base: string): Promise<{ error: string | null; backup: string | null }> {
  const job = chain.then(async () => {
    try {
      const { text, data } = await load();
      if (sha(text ?? '') !== base) return { error: 'settings.json changed since the preview. Review the change again.', backup: null };
      const after = target(text, data, on);
      if (after === null || after === text) return { error: null, backup: null };
      let backup: string | null = null;
      let mode = 0o600;
      // A symlinked settings.json (dotfiles) keeps its link: the write goes to the file it points at.
      let file = SETTINGS;
      if (text !== null) {
        file = await realpath(SETTINGS);
        mode = (await stat(file)).mode & 0o777;
        backup = `${SETTINGS}.tarcsweb-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        await copyFile(file, backup);
        await chmod(backup, 0o600);
        await pruneBackups();
      }
      const tmp = join(dirname(file), `.settings.json.${process.pid}.tmp`);
      await writeFile(tmp, after, { mode });
      await chmod(tmp, mode);
      await rename(tmp, file);
      return { error: null, backup };
    } catch (e) {
      return { error: (e as Error).message, backup: null };
    }
  });
  chain = job;
  return job;
}

// For uninstall.sh: takes out this app's entries with no preview, and leaves the file alone when there are none.
export async function removeHooks(): Promise<string | null> {
  try {
    const { text } = await load();
    return (await setHooks(false, sha(text ?? ''))).error;
  } catch (e) {
    return (e as Error).message;
  }
}
