import { depthAfter } from '../../server/stretch.ts';

// A line that is only an absolute image path becomes an image; fenced code is left alone.
const BARE = /^\s*(?:[-*]\s+)?(\/.+\.(?:png|jpe?g|webp|gif))\s*$/i;
export function bareImages(src: string) {
  let fence = false;
  return src.split('\n').map((l) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(l)) fence = !fence;
    const m = !fence && BARE.exec(l);
    return m ? `![](<${m[1]}>)` : l;
  }).join('\n');
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
// A line outside fences whose meaning can cross a blank line (a link or footnote definition, an HTML block): the message then stays one block.
const WHOLE = /^ {0,3}(?:\[[^\]\n]+\]:|<(?:!--|(?:pre|script|style|textarea)(?:[\s>]|$)))/i;

// Top-level blocks, split at blank lines outside fences. A blank line followed by an indented
// line or a list item may continue a list, so it never splits. stretch: a blank line inside {{…}} never splits either.
export function blocksOf(src: string, stretch = false): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
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
    if (WHOLE.test(l)) return [src];
    if ((stretch && l.includes('{{')) || depth) depth = depthAfter(l, depth);
    if (l.trim() || i === start || depth) continue;
    const next = lines[i + 1];
    if (next === undefined || !next.trim() || /^\s/.test(next) || LIST.test(next)) continue;
    out.push(lines.slice(start, i).join('\n'));
    start = i + 1;
  }
  out.push(lines.slice(start).join('\n'));
  return out;
}
