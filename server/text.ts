import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

export function oneLine(s: string, max = 140) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

const ERR_LINE = /\b(error|errors|failed|failure|fatal|cannot|can't|not found|no such|denied|exception|panic|refused|invalid|ERR!)\b/i;
// The one line of a failed command's output a reader needs: the last that names an error, else the last line.
export function failBrief(text: string, max = 140) {
  const all = text.replace(/<\/?tool_use_error>/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = all.filter((l) => !/^Exit code \d+$/.test(l) && !/^at\s/.test(l));
  return oneLine(lines.findLast((l) => ERR_LINE.test(l)) ?? lines.at(-1) ?? all[0] ?? '', max);
}

// Inside the project: relative; under home: ~/...; else as is.
export function displayPath(cwd: string, path: string) {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  const home = homedir();
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

// Slash-command wrappers, hook output and interrupt markers the CLI stores as user turns.
export const NOISE = /^\s*(<(command-[a-z]+|local-command-[a-z]+|system-reminder|task-notification|bash-[a-z]+|user-prompt-submit-hook)>|Caveat:|\[Request interrupted)/;
export const FILE_TEXT = /^File (.+?):\n\n/;
// A typed /command is stored as tags; shown again as the user typed it.
const CMD_NAME = /<command-name>\/?([^<]+)<\/command-name>/;
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
export function slashOf(text: string) {
  const name = CMD_NAME.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = CMD_ARGS.exec(text)?.[1]?.trim();
  return `/${name}${args ? ` ${args}` : ''}`;
}
