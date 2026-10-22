import { depthAfter } from '../../server/stretch.ts';

// A line that is only an absolute image path becomes an image; fenced code is left alone.
const BARE = /^\s*(?:[-*]\s+)?(\/.+\.(?:png|jpe?g|webp|gif))\s*$/i;
const IMG_FENCE = /^ {0,3}(`{3,}|~{3,})/;
export function bareImages(src: string) {
  let fence = false;
  return src.split('\n').map((l) => {
    if (IMG_FENCE.test(l)) fence = !fence;
    const m = !fence && BARE.exec(l);
    return m ? `![](<${m[1]}>)` : l;
  }).join('\n');
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
// A line outside fences whose meaning can cross a blank line (a link or footnote definition, an HTML block): the message then stays one block.
const WHOLE = /^ {0,3}(?:\[[^\]\n]+\]:|<(?:!--|(?:pre|script|style|textarea)(?:[\s>]|$)))/i;

// The blocks of `lines` and the line each starts at; null when a WHOLE line keeps them together.
function splitLines(lines: string[], stretch: boolean): { blocks: string[]; starts: number[] } | null {
  const blocks: string[] = [];
  const starts = [0];
  let start = 0;
  let fence = '';
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = '';
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    if (WHOLE.test(l)) return null;
    if ((stretch && l.includes('{{')) || depth) depth = depthAfter(l, depth);
    if (l.trim() || i === start || depth) continue;
    const next = lines[i + 1];
    if (next === undefined || !next.trim() || /^\s/.test(next) || LIST.test(next)) continue;
    blocks.push(lines.slice(start, i).join('\n'));
    start = i + 1;
    starts.push(start);
  }
  blocks.push(lines.slice(start).join('\n'));
  return { blocks, starts };
}

// Top-level blocks, split at blank lines outside fences. A blank line followed by an indented
// line or a list item may continue a list, so it never splits. stretch: a blank line inside {{…}} never splits either.
export function blocksOf(src: string, stretch = false): string[] {
  return splitLines(src.split('\n'), stretch)?.blocks ?? [src];
}

// Where a block starts in the raw text, and whether bareImages counts that line as inside a fence.
// A block starts outside fences and stretches, so this is all the state a re-scan from there needs.
type Cut = { at: number; img: boolean };
type Split = { src: string; stretch: boolean; blocks: string[]; cuts: Cut[] };

// blocksOf(bareImages(src)) from `from` on.
function scanFrom(src: string, from: Cut, stretch: boolean): { blocks: string[]; cuts: Cut[] } | null {
  const raw = src.slice(from.at).split('\n');
  const lines: string[] = [];
  const cuts: Cut[] = [];
  let img = from.img;
  let at = from.at;
  for (const l of raw) {
    cuts.push({ at, img });
    at += l.length + 1;
    if (IMG_FENCE.test(l)) img = !img;
    const m = !img && BARE.exec(l);
    lines.push(m ? `![](<${m[1]}>)` : l);
  }
  const r = splitLines(lines, stretch);
  return r && { blocks: r.blocks, cuts: r.starts.map((i) => cuts[i]) };
}

// Streaming replies, by message id; only the few being written are worth keeping.
const splits = new Map<string, Split>();
const SPLITS_MAX = 16;

// blocksOf(bareImages(src)) for a reply that grows at its end: only its last block (or two) is scanned again.
export function liveBlocks(key: string, src: string, stretch: boolean): string[] {
  const prev = splits.get(key);
  let next: Split | null = null;
  if (prev && prev.stretch === stretch && src.startsWith(prev.src)) {
    if (src.length === prev.src.length) return prev.blocks;
    let r = prev.cuts.length - 1;
    // A one-line last block may be a half-written line that decided the split before it, so that split is re-checked.
    if (r > 0 && !prev.src.includes('\n', prev.cuts[r].at)) r--;
    const tail = scanFrom(src, prev.cuts[r], stretch);
    if (tail) next = { src, stretch, blocks: [...prev.blocks.slice(0, r), ...tail.blocks], cuts: [...prev.cuts.slice(0, r), ...tail.cuts] };
  } else {
    const all = scanFrom(src, { at: 0, img: false }, stretch);
    if (all) next = { src, stretch, ...all };
  }
  splits.delete(key);
  // A WHOLE line may be half-written too, so a whole message is never kept as the base for the next chunk.
  if (!next) return [bareImages(src)];
  splits.set(key, next);
  if (splits.size > SPLITS_MAX) splits.delete(splits.keys().next().value!);
  return next.blocks;
}
