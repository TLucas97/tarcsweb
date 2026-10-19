import { promisify } from 'node:util';
import { crc32, deflate, inflate } from 'node:zlib';

// Halves an 8-bit RGB or RGBA PNG (what the board's canvas exports), so an oversized region fits a model's image limit.

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Raw = { w: number; h: number; px: Uint8Array };

async function decode(png: Buffer): Promise<Raw | null> {
  if (!png.subarray(0, 8).equals(SIG)) return null;
  let w = 0, h = 0, bpp = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const len = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) return null;
      bpp = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!w || !h || !bpp) return null;
  const src = await inflateAsync(Buffer.concat(idat));
  const stride = w * bpp;
  if (src.length < (stride + 1) * h) return null;
  const px = new Uint8Array(w * h * 4), cur = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = src[y * (stride + 1)], row = src.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (row[i] + p) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = cur[x * bpp];
      px[o + 1] = cur[x * bpp + 1];
      px[o + 2] = cur[x * bpp + 2];
      px[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = Uint8Array.from(cur);
  }
  return { w, h, px };
}

// 2x2 box filter with alpha weighting, so transparent pixels do not darken the ink's edges.
function half({ w, h, px }: Raw): Raw {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy), o = (sy * w + sx) * 4, al = px[o + 3];
          r += px[o] * al;
          g += px[o + 1] * al;
          b += px[o + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * w2 + x) * 4;
      if (a) (out[o] = Math.round(r / a)), (out[o + 1] = Math.round(g / a)), (out[o + 2] = Math.round(b / a));
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w: w2, h: h2, px: out };
}

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

async function encode({ w, h, px }: Raw): Promise<Buffer> {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  // Sub filter on every row: cheap and compresses flat areas well.
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (px[s + i] - (i >= 4 ? px[s + i - 4] : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', await deflateAsync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Halves the PNG until it is at most `max` bytes; null when it cannot be read or will not get small enough.
export async function shrinkPng(png: Buffer, max: number): Promise<{ png: Buffer; w: number; h: number } | null> {
  let raw = await decode(png);
  if (!raw) return null;
  for (let i = 0; i < 4 && raw.w > 1 && raw.h > 1; i++) {
    raw = half(raw);
    const out = await encode(raw);
    if (out.length <= max) return { png: out, w: raw.w, h: raw.h };
  }
  return null;
}
