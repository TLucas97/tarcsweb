import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Just enough LevelDB to read one key of a Chrome extension's storage: write-ahead logs and snappy table blocks.

function varint(b: Buffer, at: number): [number, number] {
  let v = 0;
  for (let shift = 0; shift < 50; shift += 7) {
    if (at >= b.length) throw new Error('LevelDB: truncated varint');
    const c = b[at++];
    v += (c & 0x7f) * 2 ** shift;
    if (c < 0x80) return [v, at];
  }
  throw new Error('LevelDB: bad varint');
}

// Raw snappy (no framing), as LevelDB stores a block with compression type 1.
export function unsnappy(src: Buffer): Buffer {
  const [len, start] = varint(src, 0);
  const out = Buffer.allocUnsafe(len);
  let i = start;
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        if (i + bytes > src.length) throw new Error('snappy: truncated literal length');
        n = src.readUIntLE(i, bytes);
        i += bytes;
      }
      n += 1;
      if (i + n > src.length || o + n > len) throw new Error('snappy: bad literal');
      src.copy(out, o, i, i + n);
      i += n;
      o += n;
      continue;
    }
    let n: number;
    let off: number;
    const need = kind === 1 ? 1 : kind === 2 ? 2 : 4;
    if (i + need > src.length) throw new Error('snappy: truncated copy');
    if (kind === 1) {
      n = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[i];
    } else {
      n = (tag >> 2) + 1;
      off = kind === 2 ? src.readUInt16LE(i) : src.readUInt32LE(i);
    }
    i += need;
    if (!off || off > o || o + n > len) throw new Error('snappy: bad copy');
    // A copy may overlap its own output (a repeated run), so it goes byte by byte.
    for (let k = 0; k < n; k++) out[o + k] = out[o - off + k];
    o += n;
  }
  if (o !== len) throw new Error('snappy: short output');
  return out;
}

type Hit = { seq: bigint; value: Buffer | null } | null;
const newer = (a: Hit, seq: bigint, value: Buffer | null): Hit => (a && a.seq >= seq ? a : { seq, value });

function handle(b: Buffer, at: number) {
  const [off, a] = varint(b, at);
  const [size, next] = varint(b, a);
  return { off, size, next };
}

function readBlock(file: Buffer, h: { off: number; size: number }) {
  if (h.off + h.size + 5 > file.length) throw new Error('LevelDB: block out of range');
  const raw = file.subarray(h.off, h.off + h.size);
  const type = file[h.off + h.size];
  if (type === 0) return raw;
  if (type === 1) return unsnappy(raw);
  throw new Error(`LevelDB: unsupported block compression ${type}`);
}

// Keys are prefix-compressed against the previous entry, so each one is rebuilt in order.
function* entries(block: Buffer): Generator<[Buffer, Buffer]> {
  if (block.length < 4) throw new Error('LevelDB: short block');
  const end = block.length - 4 - 4 * block.readUInt32LE(block.length - 4);
  if (end < 0) throw new Error('LevelDB: bad restarts');
  let key = Buffer.alloc(0);
  let at = 0;
  while (at < end) {
    const [shared, a] = varint(block, at);
    const [fresh, b] = varint(block, a);
    const [vlen, c] = varint(block, b);
    if (shared > key.length || c + fresh + vlen > end) throw new Error('LevelDB: bad entry');
    key = Buffer.concat([key.subarray(0, shared), block.subarray(c, c + fresh)]);
    at = c + fresh + vlen;
    yield [key, block.subarray(c + fresh, at)];
  }
}

const MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

// Internal keys are the user key plus 8 bytes of (sequence << 8 | type); type 1 is a value, 0 a deletion.
function tableGet(file: Buffer, key: Buffer, best: Hit): Hit {
  if (file.length < 48 || !file.subarray(-8).equals(MAGIC)) throw new Error('LevelDB: not a table');
  const meta = handle(file, file.length - 48);
  const index = handle(file, meta.next);
  for (const [sep, value] of entries(readBlock(file, index))) {
    if (sep.length < 8) throw new Error('LevelDB: bad index key');
    // Block i holds the keys up to its separator, so the key's versions sit from the first separator at or past it.
    const c = Buffer.compare(sep.subarray(0, -8), key);
    if (c < 0) continue;
    for (const [ik, v] of entries(readBlock(file, handle(value, 0)))) {
      if (ik.length < 8 || !ik.subarray(0, -8).equals(key)) continue;
      const tag = ik.readBigUInt64LE(ik.length - 8);
      best = newer(best, tag >> 8n, (tag & 0xffn) === 1n ? Buffer.from(v) : null);
    }
    if (c > 0) break;
  }
  return best;
}

const LOG_BLOCK = 32 * 1024;

// Log records are write batches split into 32 KiB blocks; a torn tail (crash mid-write) ends the scan quietly.
function logGet(file: Buffer, key: Buffer, best: Hit): Hit {
  let at = 0;
  let parts: Buffer[] = [];
  while (at + 7 <= file.length) {
    const left = LOG_BLOCK - (at % LOG_BLOCK);
    if (left < 7) {
      at += left;
      continue;
    }
    const len = file.readUInt16LE(at + 4);
    const type = file[at + 6];
    const body = file.subarray(at + 7, at + 7 + len);
    at += 7 + len;
    if (body.length < len || len > left - 7) break;
    if (type === 0) continue;
    if (type === 1 || type === 2) parts = [];
    parts.push(body);
    if (type !== 1 && type !== 4) continue;
    try {
      best = batchGet(Buffer.concat(parts), key, best);
    } catch {
      break;
    }
    parts = [];
  }
  return best;
}

function batchGet(b: Buffer, key: Buffer, best: Hit): Hit {
  let seq = b.readBigUInt64LE(0);
  const count = b.readUInt32LE(8);
  let at = 12;
  for (let n = 0; n < count; n++, seq++) {
    const tag = b[at++];
    const [klen, a] = varint(b, at);
    const k = b.subarray(a, a + klen);
    at = a + klen;
    let value: Buffer | null = null;
    if (tag === 1) {
      const [vlen, c] = varint(b, at);
      value = b.subarray(c, c + vlen);
      at = c + vlen;
    } else if (tag !== 0) throw new Error('LevelDB: bad batch');
    if (at > b.length) throw new Error('LevelDB: truncated batch');
    if (k.equals(key)) best = newer(best, seq, value && Buffer.from(value));
  }
  return best;
}

// The newest value of key across the store's tables and logs; null when it is absent, deleted or the store is missing.
// Throws when a table cannot be parsed. A compaction can delete a file mid-read, so a vanished file means one more pass.
export async function levelGet(dir: string, key: string): Promise<Buffer | null> {
  const k = Buffer.from(key);
  for (let pass = 0; ; pass++) {
    const files = await readdir(dir).catch(() => null);
    if (!files) return null;
    let best: Hit = null;
    try {
      for (const f of files) {
        const kind = /^\d+\.(log|ldb|sst)$/.exec(f)?.[1];
        if (!kind) continue;
        const data = await readFile(join(dir, f));
        best = kind === 'log' ? logGet(data, k, best) : tableGet(data, k, best);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && pass < 2) continue;
      throw e;
    }
    return best?.value ?? null;
  }
}
