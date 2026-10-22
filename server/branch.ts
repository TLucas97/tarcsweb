import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { projectsDir, transcriptPath } from './watch.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The CLI hashes project folder names past this length, so a longer worktree path would not be found by resume.
const PROJECT_NAME_MAX = 200;

type Block = { type?: string } | null;
const contentOf = (m: SessionMessage) => (m.message as { content?: unknown } | null)?.content;
const onlyResults = (m: SessionMessage) => {
  const c = contentOf(m);
  return Array.isArray(c) && c.length > 0 && c.every((b: Block) => b?.type === 'tool_result');
};
const hasText = (m: SessionMessage) => {
  const c = contentOf(m);
  return Array.isArray(c) && c.some((b: Block) => b?.type === 'text');
};

// A user message that starts a turn: not tool results, and not a note read between them.
function opensTurn(list: SessionMessage[], i: number) {
  const m = list[i];
  if (m.type !== 'user' || onlyResults(m)) return false;
  const prev = list[i - 1];
  return !prev || !(prev.type === 'user' && onlyResults(prev));
}

// The transcript uuid a branch keeps everything through. A user row keeps its whole turn; a reply keeps up to itself.
// Item ids: a user row is its prompt uuid; a reply is "<uuid>:<block>" from history or "<msg_id>:<x>" while live.
export function forkPoint(all: SessionMessage[], item: string, running: boolean): string {
  const list = all.filter((m) => !m.parent_tool_use_id);
  let i = -1;
  if (UUID.test(item)) {
    i = list.findIndex((m) => m.type === 'user' && m.uuid === item);
    if (i >= 0) while (i + 1 < list.length && !opensTurn(list, i + 1)) i++;
  } else {
    const head = item.split(':')[0];
    if (head.startsWith('msg_')) i = list.findLastIndex((m) => m.type === 'assistant' && (m.message as { id?: unknown } | null)?.id === head && hasText(m));
    else if (UUID.test(head)) i = list.findIndex((m) => m.type === 'assistant' && m.uuid === head);
  }
  if (i < 0) throw new Error('That message is not in the saved transcript yet, or it is from before a compaction.');
  if (running && !list.some((_, j) => j > i && opensTurn(list, j))) throw new Error('Its turn is still running. Branch from it once the turn ends.');
  return list[i].uuid;
}

// The fork lands in the source's project folder. A worktree branch moves to the worktree's, with each entry's cwd
// rewritten, so the session list, a restart and `claude --resume` there all see the worktree as its folder.
export async function moveTranscript(id: string, from: string, to: string) {
  const name = to.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length > PROJECT_NAME_MAX) throw new Error('The worktree path is too long for Claude Code to find the branch there.');
  const src = await transcriptPath(from, id);
  if (!src) throw new Error('The forked transcript was not found.');
  const remap = (cwd: unknown) => (cwd === from ? to : typeof cwd === 'string' && cwd.startsWith(from + '/') ? to + cwd.slice(from.length) : null);
  const lines = (await readFile(src, 'utf8')).split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    try {
      const o = JSON.parse(line) as { cwd?: unknown };
      const cwd = remap(o.cwd);
      if (cwd) return JSON.stringify({ ...o, cwd });
    } catch {}
    return line;
  });
  const dir = join(projectsDir(), name);
  const dest = join(dir, `${id}.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile(dest, lines.join('\n'));
  if (dest !== src) await rm(src);
}
