import { open } from 'node:fs/promises';

const CHUNK = 1 << 20;
const HEAD = 1024;

// Calls fn with each line from `from` up to `size` whose first bytes pass `wanted`, so huge tool-output lines are
// never parsed. Returns the offset after the last complete line.
export async function eachLine(path: string, from: number, size: number, wanted: (head: string) => boolean, fn: (line: Buffer) => void) {
  const fh = await open(path, 'r');
  try {
    let pos = from;
    let done = from;
    let parts: Buffer[] = [];
    let len = 0;
    let keep: boolean | null = null;
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      let start = 0;
      while (start < bytesRead) {
        const nl = buf.indexOf(10, start);
        const found = nl >= 0 && nl < bytesRead;
        const seg = buf.subarray(start, found ? nl : bytesRead);
        if (keep === null && (found || len + seg.length >= HEAD)) {
          keep = wanted((len ? Buffer.concat([...parts, seg]) : seg).subarray(0, HEAD).toString('latin1'));
          if (!keep) parts = [];
        }
        if (keep !== false) {
          parts.push(seg);
          len += seg.length;
        }
        if (!found) break;
        if (keep) fn(parts.length === 1 ? parts[0] : Buffer.concat(parts, len));
        parts = [];
        len = 0;
        keep = null;
        start = nl + 1;
        done = pos + start;
      }
      pos += bytesRead;
    }
    return done;
  } finally {
    await fh.close();
  }
}
