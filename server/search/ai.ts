import { basename } from 'node:path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ask } from '../titles.ts';
import { oneLine } from '../text.ts';
import type { AiHit, SearchHit } from '../protocol.ts';
import { search } from './index.ts';

// Candidates Haiku picks from: the best text matches plus the newest sessions, kept to a few KB of prompt.
const MATCHES = 30;
const RECENT = 15;
const PICKS = 8;
const MAX_WORDS = 12;
const SNIP = 150;
const TIMEOUT_MS = 30_000;

// Question filler in Portuguese and English, compared without accents. Words under 3 letters are dropped anyway.
const STOP = new Set(
  (
    'que para pra por com sem como mais mas foi era ser sao tem tinha uma uns umas dos das nos nas pelo pela pelos pelas meu minha meus minhas seu sua ' +
    'voce eu ele ela isso esse essa este esta aquele aquela aquilo onde quando qual quais quem sobre entre ate fiz fez fazer feito estava estou quero ' +
    'queria tipo coisa sessao sessoes conversa conversas the and for with that this these those where what which when who was were are from into ' +
    'about have has had did does how you your there then than but not any some session sessions conversation conversations chat'
  ).split(' '),
);
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Any meaningful word may match, so a question in plain words still finds sessions that share only some of them.
export function orQuery(question: string) {
  const words = [...new Set(question.split(/[^\p{L}\p{N}]+/u).map((w) => w.toLowerCase()))]
    .filter((w) => w.length >= 3 && !STOP.has(fold(w)))
    .slice(0, MAX_WORDS);
  return words.length ? words.map((w) => `"${w}"*`).join(' OR ') : null;
}

const SYSTEM = 'You find past coding sessions that a question is about. Reply with JSON only, no prose and no code fence.';
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function promptFor(question: string, hits: SearchHit[]) {
  const list = hits.map((h, i) => `${i + 1}. ${h.name} · ${basename(h.cwd) || '?'} · ${day(h.lastModified)}\n   ${oneLine(h.snippet.replace(/[\u0002\u0003]/g, ''), SNIP)}`);
  return [
    `Question: ${oneLine(question, 300)}`,
    '',
    'Below are past coding sessions: title · folder · last active, then a short excerpt.',
    `Pick the sessions the question is about, best first, at most ${PICKS}. Skip sessions that only share a word with it.`,
    'For each pick, "why" says in at most 12 words what in that session fits, written in the language of the question.',
    'Answer with a JSON array like [{"i":3,"why":"..."}], or [] if none fits.',
    '',
    list.join('\n'),
  ].join('\n');
}

function parse(text: string, n: number) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let arr: unknown = [];
  try {
    if (start >= 0 && end > start) arr = JSON.parse(text.slice(start, end + 1));
  } catch {}
  const picks: { i: number; why: string }[] = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    const { i, why } = (o ?? {}) as { i?: unknown; why?: unknown };
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i > n || picks.some((p) => p.i === i)) continue;
    picks.push({ i, why: typeof why === 'string' ? oneLine(why, 120) : '' });
    if (picks.length >= PICKS) break;
  }
  return picks;
}

// One AI search per client: a new one closes the model call still running, and the old one gets no answer.
export class AiSearch {
  private n = 0;
  private q: Query | null = null;

  // null: superseded by a newer request or closed.
  async run(question: string, cwd: string | null): Promise<{ hits: AiHit[]; error?: string } | null> {
    const n = this.stop();
    const t0 = performance.now();
    const { hits: found, indexing } = await search.candidates(orQuery(question), cwd, MATCHES, RECENT);
    if (n !== this.n) return null;
    if (!found.length) return { hits: [], ...(indexing ? { error: 'Past conversations are still being indexed' } : {}) };
    const prompt = promptFor(question, found);
    let text: string | null = null;
    try {
      text = await ask(prompt, (q) => n === this.n && (this.q = q), SYSTEM, { maxTokens: 1000, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      if (n === this.n) console.error(`search: AI search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (n !== this.n) return null;
    if (text === null) return { hits: [], error: 'AI search failed, try again' };
    const picks = parse(text, found.length);
    console.log(`search: AI picked ${picks.length} of ${found.length} sessions (${prompt.length} chars) in ${Math.round(performance.now() - t0)} ms`);
    return { hits: picks.map((p) => ({ ...found[p.i - 1], why: p.why })) };
  }

  // Ends the request in flight, if any, and returns the next request number.
  stop() {
    this.q?.close();
    this.q = null;
    return ++this.n;
  }
}
