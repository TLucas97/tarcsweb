// [DEBUG-calltime] Per-call timing log for the long-pause investigation; remove every hook with a grep for the tag.
// Writes <stamp>-timing.jsonl next to the call files: event names, ms since the call started, ids, lengths and short hashes, never text.
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// A burst of deltas counts as one start after this much silence.
const GAP_MS = 700;
const sig = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

type P = Record<string, unknown>;

export class CallTiming {
  private chain: Promise<void>;
  private last = new Map<string, number>();
  private file: string;
  private t0: number;

  constructor(file: string, t0: number) {
    this.file = file;
    this.t0 = t0;
    this.chain = mkdir(dirname(file), { recursive: true }).then(() => {}, () => {});
  }

  // at: when it happened, for events that reach the server late (the browser's oai-events).
  mark(ev: string, f: P = {}, at = Date.now()) {
    const line = `${JSON.stringify({ ms: at - this.t0, ev, ...f })}\n`;
    this.chain = this.chain.then(() => appendFile(this.file, line)).catch(() => {});
  }

  // Thread and realtime notifications as they reach the server.
  event(method: string, params: unknown) {
    const p = (params ?? {}) as P;
    if (method.endsWith('/delta')) {
      const key = `${method}:${String(p.role ?? '')}`;
      const now = Date.now();
      const prev = this.last.get(key) ?? 0;
      this.last.set(key, now);
      if (now - prev >= GAP_MS) this.mark('start', { method, role: p.role, gapMs: prev ? now - prev : null });
      return;
    }
    if (method === 'thread/tokenUsage/updated') return;
    const turn = p.turn as P | undefined;
    const item = p.item as P | undefined;
    const f: P = { method, turnId: p.turnId ?? turn?.id, status: turn?.status, role: p.role, reason: p.reason };
    if (item) {
      Object.assign(f, { type: item.type, phase: item.phase, itemId: item.id });
      const content = item.content as { type: string; text?: string }[] | undefined;
      const text = typeof item.text === 'string' ? item.text : content?.map((c) => c.text ?? '').join(' ');
      if (text) Object.assign(f, { len: text.length, sig: sig(text) });
    } else if (typeof p.text === 'string') Object.assign(f, { len: p.text.length, sig: sig(p.text) });
    if (method.startsWith('thread/realtime/') && !item) f.keys = Object.keys(p).join(',');
    this.mark('event', f);
  }
}
