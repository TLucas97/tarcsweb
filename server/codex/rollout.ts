import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TimedEvent } from '../protocol.ts';
import { readOrigin } from '../sessionOrigin.ts';
import { oneLine } from '../text.ts';
import { summarizeFor, verbOf } from '../tools.ts';

const LINE_MAX = 8 * 1024 * 1024;
const EVENTS_MAX = 20_000;

async function locate(dir: string, id: string): Promise<string | null> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) return path;
    if (entry.isDirectory()) {
      const found = await locate(path, id);
      if (found) return found;
    }
  }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

// Snapshot the end so an actively growing rollout cannot keep this read running.
async function* lines(path: string): AsyncGenerator<string | null> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (!size) return;
    const stream = fh.createReadStream({ end: size - 1, autoClose: false });
    let parts: Buffer[] = [];
    let bytes = 0;
    let prefix = '';
    let output = false;
    const finish = () => {
      if (output) return '';
      if (bytes <= LINE_MAX) return Buffer.concat(parts, bytes).toString('utf8');
      const conversation = /"type"\s*:\s*"response_item"/.test(prefix)
        && (/"type"\s*:\s*"(?:function_call|custom_tool_call)"/.test(prefix)
          || /"type"\s*:\s*"message"/.test(prefix) && /"role"\s*:\s*"(?:user|assistant)"/.test(prefix));
      return conversation ? null : '';
    };
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf(10, start);
        const part = buf.subarray(start, nl < 0 ? buf.length : nl);
        if (prefix.length < 512) prefix += part.subarray(0, 512 - prefix.length).toString('utf8');
        output ||= /"type"\s*:\s*"(?:function_call_output|custom_tool_call_output)"/.test(prefix);
        bytes += part.length;
        if (output || bytes > LINE_MAX) parts = [];
        else parts.push(part);
        if (nl < 0) break;
        yield finish();
        parts = [];
        bytes = 0;
        prefix = '';
        output = false;
        start = nl + 1;
      }
    }
    if (bytes) yield finish();
  } finally {
    await fh.close();
  }
}

// Response items occur in old and new rollouts; event_msg duplicates them in newer CLI versions.
export async function readRollout(threadId: string, cwd: string) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const path = await locate(join(home, 'sessions'), threadId) ?? await locate(join(home, 'archived_sessions'), threadId);
  if (!path) return null;
  let limited = false;
  const events: TimedEvent[] = [];
  let lineNo = 0;
  for await (const line of lines(path)) {
    lineNo++;
    if (line === null) {
      limited = true;
      continue;
    }
    if (!line) continue;
    const record = object(json(line));
    if (record.type !== 'response_item') continue;
    const p = object(record.payload);
    const id = `cx:${typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : `rollout-${lineNo}`}`;
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    const at = Number.isFinite(time) ? { at: time } : {};
    if (p.type === 'message' && Array.isArray(p.content)) {
      const text = p.content.flatMap((part) => {
        const c = object(part);
        return (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string' ? [c.text] : [];
      }).join('\n\n');
      if (!text) continue;
      if (p.role === 'user') events.push({ type: 'user', id, ...readOrigin(text), ...at });
      if (p.role === 'assistant') events.push({ type: 'text', id, delta: text, ...at });
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') {
      const raw = p.type === 'function_call' ? p.arguments : p.input;
      const parsed = typeof raw === 'string' ? json(raw) : raw;
      if (p.type === 'function_call' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) continue;
      const input = object(parsed);
      if (p.name === 'update_plan' && Array.isArray(input.plan)) {
        for (const [i, value] of input.plan.entries()) {
          const step = object(value);
          if (typeof step.step === 'string' && typeof step.status === 'string') events.push({ type: 'tool', id: `${id}:${i}`, name: p.name, verb: 'plan', summary: `${step.status}: ${oneLine(step.step)}`, ...at });
        }
      } else {
        const command = input.cmd ?? input.command;
        const name = typeof command === 'string' && /^(exec_command|shell_command)$/.test(p.name) ? 'Bash' : p.name;
        const summary = summarizeFor(cwd, name, name === 'Bash' ? { command } : input) || oneLine(typeof raw === 'string' ? raw : name);
        events.push({ type: 'tool', id, name, verb: verbOf(name), summary, ...at });
      }
    }
    if (events.length > EVENTS_MAX * 2) {
      events.splice(0, events.length - EVENTS_MAX);
      limited = true;
    }
  }
  if (events.length > EVENTS_MAX) limited = true;
  return { events: events.slice(-EVENTS_MAX), limited };
}
