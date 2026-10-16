import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { SlashItem } from './protocol.ts';
import { oneLine } from './text.ts';

// The app owns these (model menu, session menu, new session) or they do nothing outside the terminal.
const HIDDEN = new Set(['clear', 'model', 'effort', 'rename', 'color', 'focus', 'reload-plugins', 'workflow-launch-exec']);
// Terminal-tagged, but it runs as a model skill here.
const KEEP = new Set(['doctor']);
const DESC_MAX = 150;

// Learned from each session's init message; the list itself does not carry the tag.
const terminal = new Set<string>();

// True when a name was new, so menus already sent need a refresh.
export function learnTerminal(names: string[] | undefined) {
  const before = terminal.size;
  for (const n of names ?? []) if (!KEEP.has(n)) terminal.add(n);
  return terminal.size > before;
}

const shown = (c: SlashCommand) =>
  !c.name.startsWith('_') && !HIDDEN.has(c.name) && !terminal.has(c.name) && !/^\((removed|deprecated)\)|^Renamed to /i.test(c.description);

export function menuOf(list: SlashCommand[]): SlashItem[] {
  return list.filter(shown).map((c) => ({
    name: c.name, description: oneLine(c.description, DESC_MAX), hint: c.argumentHint ?? '',
    ...(c.aliases?.length ? { aliases: c.aliases } : {}), ...(c.builtin ? {} : { skill: true }),
  }));
}

// The last list per folder, so a session without a process yet still gets a menu.
export class CommandCache {
  private byCwd = new Map<string, SlashCommand[]>();
  private latest: SlashCommand[] | null = null;

  set(cwd: string, list: SlashCommand[]) {
    this.byCwd.set(cwd, list);
    this.latest = list;
  }

  get(cwd: string) {
    return this.byCwd.get(cwd) ?? this.latest;
  }
}

// Local command output is terminal text; column layouts (/usage, /skill-doctor) keep their spacing in a code block.
export function localOutput(text: string) {
  if (text.includes('```') || /^\s*\|/m.test(text)) return text;
  return /^ {2,}\S|\S {2,}\S/m.test(text) ? '```text\n' + text.replace(/\s+$/, '') + '\n```' : text;
}
