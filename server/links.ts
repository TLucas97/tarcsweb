import type { Attachment, TextLink, Upload } from './protocol.ts';

// A prompt in send order once it has links: typed text and attachments interleaved.
export type Seg = { text: string } | { file: Upload };
// The same read back from a transcript.
export type Piece = { text: string } | { file: Attachment };

const SPAN_MAX = 500;
// The reference line after a linked span; a linked paste follows it in the same block.
const REF = /^\n?\[Attachment (\d+)( \(attached above\))?(?: \(image \d+ of \d+\))?, refers to: ("(?:[^"\\\n]|\\.)*")\](?:\n\n([\s\S]*))?$/;

export const hasRef = (text: string) => text.startsWith('[Attachment ', text[0] === '\n' ? 1 : 0) && REF.test(text);

export const pdfNote =(path: string) => `The user attached a PDF, saved at ${path}.`;
export const PDF_NOTE = /^The user attached a PDF, saved at (.+)\.$/;

const quoted = (s: string) => JSON.stringify(s.length > SPAN_MAX ? `${s.slice(0, 240)}…${s.slice(-240)}` : s);

// Keeps links that fit the text, sorted and not overlapping; whitespace-only spans would make empty text blocks.
export function cleanLinks(text: string, links: TextLink[], count: number): TextLink[] {
  const out: TextLink[] = [];
  let end = 0;
  for (const l of [...links].sort((a, b) => a.start - b.start)) {
    if (l.start < end || l.end > text.length || l.start >= l.end || l.at >= count || !text.slice(l.start, l.end).trim()) continue;
    out.push(l);
    end = l.end;
  }
  return out;
}

// Splits the text after each linked span, followed by a reference line and the attachment; null without links,
// so such prompts go exactly as before. Unlinked files lead and unlinked pastes open the text, as before.
export function linkedSegs(text: string, pastes: string[], files: Upload[], links: TextLink[]): Seg[] | null {
  if (!links.length) return null;
  const linked = new Set(links.map((l) => l.at));
  const segs: Seg[] = files.filter((_, i) => !linked.has(i)).map((file) => ({ file }));
  const loose = pastes.filter((_, i) => !linked.has(files.length + i));
  const shown = new Set<number>();
  // Images in content order: the CLI lists their saved paths at the end without numbers, so the ref names the position.
  const images = files.filter((f) => f.kind === 'image').length;
  let image = segs.filter((s) => 'file' in s && s.file.kind === 'image').length;
  let from = 0;
  links.forEach((l, k) => {
    const part = text.slice(from, l.end);
    segs.push({ text: k ? part : [...loose, part].filter((t) => t.trim()).join('\n\n') });
    from = l.end;
    const above = shown.has(l.at);
    shown.add(l.at);
    const nth = !above && l.at < files.length && files[l.at].kind === 'image' ? ` (image ${++image} of ${images})` : '';
    const ref = `\n[Attachment ${l.at + 1}${above ? ' (attached above)' : ''}${nth}, refers to: ${quoted(text.slice(l.start, l.end))}]`;
    if (above) segs.push({ text: ref });
    else if (l.at < files.length) segs.push({ text: ref }, { file: files[l.at] });
    else segs.push({ text: `${ref}\n\n${pastes[l.at - files.length]}` });
  });
  const rest = text.slice(from);
  if (rest.trim()) segs.push({ text: rest });
  return segs;
}

type Found = { start: number; end: number; file: boolean; i: number };

// Rebuilds the text, chips and links of a prompt sent with links; null for any other prompt.
export function linkedPrompt(pieces: Piece[]): { text: string; files: Attachment[]; pastes: string[]; links: TextLink[] } | null {
  if (!pieces.some((p) => 'text' in p && hasRef(p.text))) return null;
  let text = '';
  const files: Attachment[] = [];
  const pastes: string[] = [];
  const found: Found[] = [];
  const byNum = new Map<string, Omit<Found, 'start' | 'end'>>();
  let waiting: { start: number; end: number; n: string } | null = null;
  const add = (start: number, end: number, to: Omit<Found, 'start' | 'end'>) => start >= 0 && found.push({ start, end, ...to });
  for (const p of pieces) {
    if ('file' in p) {
      files.push(p.file);
      if (waiting) {
        const to = { file: true, i: files.length - 1 };
        byNum.set(waiting.n, to);
        add(waiting.start, waiting.end, to);
      }
      waiting = null;
      continue;
    }
    const m = REF.exec(p.text);
    waiting = null;
    if (!m) {
      text += p.text;
      continue;
    }
    let span = '';
    try {
      span = JSON.parse(m[3]) as string;
    } catch {}
    // A span cut short in the reference line cannot be found again; its chip stays, unhighlighted.
    const start = span && text.endsWith(span) ? text.length - span.length : -1;
    if (m[4] !== undefined) {
      pastes.push(m[4]);
      const to = { file: false, i: pastes.length - 1 };
      byNum.set(m[1], to);
      add(start, text.length, to);
    } else if (m[2]) {
      const to = byNum.get(m[1]);
      if (to) add(start, text.length, to);
    } else waiting = { start, end: text.length, n: m[1] };
  }
  const links = found.map((f) => ({ start: f.start, end: f.end, at: f.file ? f.i : files.length + f.i }));
  return { text, files, pastes, links };
}
