// Turns a reply block with stretches into the markdown the reader sees. The anchor matching
// (anchorsOf, bare) and labelOf are adapted from cc-stretch, https://github.com/pro-vi/cc-stretch
// (hooks/grow.ts, hooks/register.tsx), MIT License, Copyright (c) 2026 pro-vi; the full notice is in server/stretch.ts.

import { closeAfter, codeSpanEnd, isLinkable, parse, shownText, stretches, verbatim, type Segment, type Stretch } from '../../../server/stretch.ts';
import { blocksOf } from '../mdBlocks.ts';

// Private-use marks around the words a long form adds; a reply never writes them. remarkStretch reads them.
export const TINT = '';
export const SEP = '';
export const TINT_END = '';
const UI_AT = '';
const UI_END = '';
const UI_MARK = /(\d+)/g;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

type Token = { kind: 'word' | 'space'; text: string } | { kind: 'nested'; stretch: Stretch };

// Open stretches are stored as `<block>#<key>`, so the same short form in two blocks stays apart.
export const fullKey = (block: number, key: string) => `${block}#${key}`;

export type Composed = { md: string; keys: string[] };

// open: this message's open keys. live: an unclosed stretch is still arriving, so only its short form shows.
export function composeBlock(text: string, block: number, open: readonly string[], live: boolean): Composed {
  const segments = parse(text);
  const all = stretches(segments);
  const keys = all.map((s) => fullKey(block, s.key));
  // ui blocks taken out of open long forms, per top-level stretch; they go below its paragraph.
  const groups: string[][] = [];
  let bucket: string[] = [];

  const draw = (s: Stretch): string => {
    if (!s.isClosed) return live ? s.short : verbatim(s);
    if (s.long === undefined) return verbatim(s);
    // A short form over several lines cannot be a link, so it is drawn open.
    if (!isLinkable(s)) return s.long.length === 0 ? s.short : write(s.long);
    const n = all.indexOf(s);
    if (!open.includes(keys[n])) return `[${labelOf(s.short)}](#st-o-${n})`;
    const long = grow(s.short, takeUi(s.long, bucket), draw, `${block}.${n}`);
    return closeAfter(long, `[«](#st-c-${n})`, '\n\n');
  };
  const write = (parts: Segment[]) => parts.map((p) => (typeof p === 'string' ? p : draw(p))).join('');

  const md = segments.map((p) => {
    if (typeof p === 'string') return p;
    bucket = [];
    const out = draw(p);
    if (!bucket.length) return out;
    groups.push(bucket);
    return `${out}${UI_AT}${groups.length - 1}${UI_END}`;
  }).join('');
  return { md: groups.length ? placeUi(md, groups) : md, keys };
}

// Each ui block goes right below the paragraph holding its stretch, never inside it.
function placeUi(md: string, groups: string[][]) {
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of md.split('\n')) {
    if (pending.length && (!line.trim() || FENCE_OPEN.test(line))) {
      out.push('', ...pending, '');
      pending = [];
    }
    out.push(line.replace(UI_MARK, (_, g: string) => (pending.push(...groups[Number(g)]), '')));
  }
  if (pending.length) out.push('', ...pending);
  return out.join('\n');
}

const UI_FENCE = /^[ \t]*(`{3,}|~{3,})ui[ \t]*\n[\s\S]*?^[ \t]*\1[ \t]*$\n?/gm;

function takeUi(long: Segment[], bucket: string[]): Segment[] {
  return long.map((p) => (typeof p === 'string' && p.includes('ui') ? p.replace(UI_FENCE, (m) => (bucket.push(m.trimEnd()), '')) : p));
}

// The long form with the short form's words kept as they are and every added run marked.
function grow(short: string, long: Segment[], draw: (s: Stretch) => string, id: string): string {
  const tokens = tokenize(long);
  const anchors = anchorsOf(short, tokens);
  let out = '';
  let run = '';
  const flush = () => {
    if (run) out += tint(run, id);
    run = '';
  };
  tokens.forEach((t, i) => {
    const text = t.kind === 'nested' ? draw(t.stretch) : t.text;
    if (anchors.has(i) && t.kind !== 'space') {
      flush();
      out += text;
    } else run += text;
  });
  flush();
  return out;
}

const HEAD = /^(?:(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)[ \t]+)*[*_~]*/;

// Marks sit inside whitespace, list markers and emphasis delimiters, so the markdown parses as written.
function tint(run: string, id: string) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(run)!;
  if (!/[\p{L}\p{N}]/u.test(core)) return run;
  const head = HEAD.exec(core)![0];
  const rest = core.slice(head.length);
  const tail = /[*_~]*$/.exec(rest)![0];
  return `${lead}${head}${TINT}${id}${SEP}${rest.slice(0, rest.length - tail.length)}${TINT_END}${tail}${trail}`;
}

// Words, whitespace runs and nested stretches; a code span stays one word so no mark lands inside it.
function tokenize(long: Segment[]): Token[] {
  const out: Token[] = [];
  for (const part of long) {
    if (typeof part !== 'string') {
      out.push({ kind: 'nested', stretch: part });
      continue;
    }
    for (let i = 0; i < part.length; ) {
      const space = /^\s+/.exec(part.slice(i, i + 200))?.[0];
      if (space) {
        out.push({ kind: 'space', text: space });
        i += space.length;
        continue;
      }
      const stop = part[i] === '`' ? codeSpanEnd(part, i) : i + (/^[^\s`]+/.exec(part.slice(i))?.[0].length ?? 1);
      out.push({ kind: 'word', text: part.slice(i, stop) });
      i = stop;
    }
  }
  return out;
}

// The token indexes of the long form that carry the short form's words, as many as can be kept in
// order (a longest common subsequence). A nested stretch shows its own short form, so its words count where it stands.
function anchorsOf(short: string, tokens: Token[]): Set<number> {
  const want = short.split(/\s+/).map(bare).filter((w) => w !== '');
  const have: { token: number; word: string }[] = [];
  tokens.forEach((token, i) => {
    const words = token.kind === 'nested' ? token.stretch.short : token.kind === 'word' ? token.text : '';
    for (const word of words.split(/\s+/).map(bare).filter((w) => w !== '')) have.push({ token: i, word });
  });

  const lengths = Array.from({ length: want.length + 1 }, () => new Array<number>(have.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = have.length - 1; j >= 0; j--) {
      lengths[i][j] = want[i] === have[j].word ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const anchors = new Set<number>();
  for (let i = 0, j = 0; i < want.length && j < have.length; ) {
    if (want[i] === have[j].word) {
      anchors.add(have[j].token);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  // Punctuation standing on its own right after an anchor (`{{...}}.`) belongs to that anchor.
  let last = -1;
  tokens.forEach((token, i) => {
    if (token.kind === 'space') return;
    if (token.kind === 'word' && bare(token.text) === '' && anchors.has(last)) anchors.add(i);
    last = i;
  });
  return anchors;
}

// A word without its surrounding punctuation or markdown marks, lowercased, so `cache.` meets `**cache**`.
const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();

// A short form as link text: links inside become text and target, brackets and backslashes are escaped; code spans stay as written.
function labelOf(short: string): string {
  const plain = (text: string) => text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)').replace(/([[\]\\])/g, '\\$1');
  let label = '';
  let from = 0;
  for (let at = short.indexOf('`'); at !== -1; at = short.indexOf('`', from)) {
    const stop = codeSpanEnd(short, at);
    label += plain(short.slice(from, at)) + short.slice(at, stop);
    from = stop;
  }
  return label + plain(short.slice(from));
}

// Every stretch a reader can open in a reply, keyed as the blocks key them.
export function replyStretches(raw: string): { key: string; short: string }[] {
  if (!raw.includes('{{')) return [];
  return blocksOf(raw, true).flatMap((b, i) =>
    b.includes('{{') ? stretches(parse(b)).filter(isLinkable).map((s) => ({ key: fullKey(i, s.key), short: s.short.trim() })) : [],
  );
}

// The reply as the reader sees it, short forms plus opened long forms, markup gone: for copy and reading.
export function shownReply(raw: string, open: readonly string[]): string {
  if (!raw.includes('{{')) return raw;
  return blocksOf(raw, true).map((b, i) => shownText(b, (s) => open.includes(fullKey(i, s.key)))).join('\n\n');
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[]; data?: Record<string, unknown> };
const MARKS = /[]/g;

// Wraps the text a long form added in <span class="st-new" data-st="block.n">, following the marks across nodes in document order.
export function remarkStretch() {
  return (tree: MdNode) => {
    const stack: string[] = [];
    const wrap = (children: MdNode[]): MdNode => ({ type: 'stNew', data: { hName: 'span', hProperties: { className: ['st-new'], dataSt: stack.at(-1) } }, children });
    // Reads the marks in s, updating the stack; emit gets each unmarked piece with the stack as it stood.
    const read = (s: string, emit: (piece: string) => void) => {
      let buf = '';
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === TINT || c === TINT_END) {
          if (buf) emit(buf);
          buf = '';
          if (c === TINT_END) stack.pop();
          else {
            const sep = s.indexOf(SEP, i + 1);
            stack.push(s.slice(i + 1, sep));
            i = sep;
          }
        } else buf += c;
      }
      if (buf) emit(buf);
    };
    const visit = (node: MdNode) => {
      if (!node.children) return;
      const next: MdNode[] = [];
      for (const c of node.children) {
        if (c.type === 'text') {
          read(c.value ?? '', (value) => next.push(stack.length ? wrap([{ type: 'text', value }]) : { type: 'text', value }));
          continue;
        }
        // An autolink can swallow a mark that follows it.
        if (typeof c.url === 'string') c.url = c.url.replace(MARKS, '');
        const on = stack.length > 0;
        if (c.type === 'inlineCode' || c.type === 'code' || c.type === 'html') {
          let value = '';
          read(c.value ?? '', (piece) => (value += piece));
          c.value = value;
          next.push(on && c.type === 'inlineCode' ? wrap([c]) : c);
          continue;
        }
        visit(c);
        next.push(on && c.type === 'image' ? wrap([c]) : c);
      }
      node.children = next;
    };
    visit(tree);
  };
}
