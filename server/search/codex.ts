import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { oneLine } from '../text.ts';
import type { Source, SourceFile } from './db.ts';
import { eachLine } from './lines.ts';

const ROOT = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
// sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// The event_msg copies hold only what was typed and said; response_item lines add injected instructions and tool calls.
const WANTED = /^\{"timestamp":"[^"]*","type":"(session_meta"|event_msg","payload":\{"type":"(user_message|agent_message)")/;

type Line = { type?: string; payload?: { type?: string; cwd?: unknown; message?: unknown } };
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

async function walk(dir: string, out: SourceFile[]) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(path, out);
      continue;
    }
    const m = ROLLOUT.exec(e.name);
    const st = m && (await stat(path).catch(() => null));
    if (m && st?.isFile()) out.push({ path, sid: m[1], mtime: st.mtimeMs, size: st.size });
  }
}

export const codex: Source = {
  name: 'codex',

  async list() {
    const out: SourceFile[] = [];
    await walk(ROOT, out);
    return out;
  },

  read(file, offset, sink) {
    return eachLine(file.path, offset, file.size, (head) => WANTED.test(head), (line) => {
      let o: Line;
      try {
        o = JSON.parse(line.toString('utf8')) as Line;
      } catch {
        return;
      }
      const p = o.payload;
      if (o.type === 'session_meta') {
        if (str(p?.cwd)) sink.cwd(p.cwd);
      } else if (str(p?.message)) {
        sink.text(p.message);
        if (p.type === 'user_message') sink.title('first', oneLine(p.message, 80));
      }
    });
  },
};
