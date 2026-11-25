import type { Attachment, SessionOrigin, TextLink, Upload } from './protocol.ts';
import { readOrigin } from './sessionOrigin.ts';

// A prompt in send order once it has links: typed text and attachments interleaved.
export type Seg = { text: string } | { file: Upload };
// The same read back from a transcript.
export type Piece = { text: string } | { file: Attachment };

const SPAN_MAX = 500;
// The reference line after a linked span; a linked paste follows it in the same block, closed by an end line.
// An unlinked paste has no span and ends with one newline, so the typed text after it starts on its own line.
const REF = /^\n?\[Attachment (\d+) \((pasted text|image \d+ of \d+|file|shown above)\)(?:, linked to the preceding words: ("(?:[^"\\\n]|\\.)*"))?\](?:\n([\s\S]*)\n\[End of attachment \1\]\n?)?$/;
// The format before end lines and kinds; saved transcripts still hold it.
const OLD_REF = /^\n?\[Attachment (\d+)( \(attached above\))?(?: \(image \d+ of \d+\))?, refers to: ("(?:[^"\\\n]|\\.)*")\](?:\n\n([\s\S]*))?$/;

type Ref = { n: string; above: boolean; span?: string; paste?: string };

function readRef(text: string): Ref | null {
  const m = REF.exec(text);
  if (m) return { n: m[1], above: m[2] === 'shown above', span: m[3], paste: m[4] };
  const o = OLD_REF.exec(text);
  return o && { n: o[1], above: !!o[2], span: o[3], paste: o[4] };
}

export const hasRef = (text: string) => text.startsWith('[Attachment ', text[0] === '\n' ? 1 : 0) && !!readRef(text);

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

// Splits the text after each linked span, followed by a reference line and the attachment; null without links or pastes,
// so such prompts go exactly as before. lead (the session-origin envelope) goes first; unlinked files follow,
// then unlinked pastes, each between its own start and end lines.
export function linkedSegs(text: string, pastes: string[], files: Upload[], links: TextLink[], lead = ''): Seg[] | null {
  if (!links.length && !pastes.length) return null;
  const linked = new Set(links.map((l) => l.at));
  const segs: Seg[] = [...(lead ? [{ text: lead }] : []), ...files.filter((_, i) => !linked.has(i)).map((file) => ({ file }))];
  pastes.forEach((p, i) => {
    const n = files.length + i + 1;
    if (!linked.has(n - 1)) segs.push({ text: `[Attachment ${n} (pasted text)]\n${p}\n[End of attachment ${n}]\n` });
  });
  const shown = new Set<number>();
  // Images in content order: the CLI lists their saved paths at the end without numbers, so the ref names the position.
  const images = files.filter((f) => f.kind === 'image').length;
  let image = segs.filter((s) => 'file' in s && s.file.kind === 'image').length;
  let from = 0;
  links.forEach((l, k) => {
    const part = text.slice(from, l.end);
    segs.push({ text: part });
    from = l.end;
    const above = shown.has(l.at);
    shown.add(l.at);
    const isFile = l.at < files.length;
    const kind = above ? 'shown above' : !isFile ? 'pasted text' : files[l.at].kind === 'image' ? `image ${++image} of ${images}` : 'file';
    const ref = `\n[Attachment ${l.at + 1} (${kind}), linked to the preceding words: ${quoted(text.slice(l.start, l.end))}]`;
    if (above) segs.push({ text: ref });
    else if (isFile) segs.push({ text: ref }, { file: files[l.at] });
    else segs.push({ text: `${ref}\n${pastes[l.at - files.length]}\n[End of attachment ${l.at + 1}]` });
  });
  const rest = text.slice(from);
  if (rest.trim()) segs.push({ text: rest });
  return segs;
}

type Found = { start: number; end: number; file: boolean; i: number };

// Rebuilds the text, chips and links of a prompt sent with links; null for any other prompt.
export function linkedPrompt(pieces: Piece[]): { text: string; files: Attachment[]; pastes: string[]; links: TextLink[]; origin?: SessionOrigin } | null {
  if (!pieces.some((p) => 'text' in p && hasRef(p.text))) return null;
  let text = '';
  // The session-origin envelope leads as its own block; read it off so span offsets stay those of the typed text.
  let origin: SessionOrigin | undefined;
  const first = pieces.findIndex((p) => 'text' in p);
  if (first >= 0) {
    const d = readOrigin((pieces[first] as { text: string }).text);
    if (d.origin) {
      origin = d.origin;
      pieces = pieces.toSpliced(first, 1, ...(d.text ? [{ text: d.text }] : []));
    }
  }
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
    const m = readRef(p.text);
    waiting = null;
    if (!m) {
      text += p.text;
      continue;
    }
    let span = '';
    try {
      span = m.span ? (JSON.parse(m.span) as string) : '';
    } catch {}
    // A span cut short in the reference line cannot be found again; its chip stays, unhighlighted.
    const start = span && text.endsWith(span) ? text.length - span.length : -1;
    if (m.paste !== undefined) {
      pastes.push(m.paste);
      const to = { file: false, i: pastes.length - 1 };
      byNum.set(m.n, to);
      add(start, text.length, to);
    } else if (m.above) {
      const to = byNum.get(m.n);
      if (to) add(start, text.length, to);
    } else waiting = { start, end: text.length, n: m.n };
  }
  const links = found.map((f) => ({ start: f.start, end: f.end, at: f.file ? f.i : files.length + f.i }));
  return { text, files, pastes, links, ...(origin ? { origin } : {}) };
}
