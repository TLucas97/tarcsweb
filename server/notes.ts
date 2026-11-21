import { ask, type Asking } from './titles.ts';
import { proseWords } from './voice.ts';
import { t } from './config.ts';
import { oneLine } from './text.ts';
import { CLAIMS_MODEL, type Provider } from './protocol.ts';
import { tuning } from './profile.ts';

// pt-BR is verbatim from the tldr mod; en is a faithful translation.
const TLDR_EN = `You rewrite a coding assistant's answer as a short summary for a developer who wants the gist without reading the whole answer, told the way a colleague would explain it in person.

Format: a single paragraph, in English, 2 to 3 sentences, at most 40 words. No markdown, no list, no label, no title.

How to write:
- The first sentence gives the result or the answer. The last sentence says what they need to do, only if there is something. If there is nothing, do not write "nothing": just end before it.
- One idea per sentence, up to 20 words each, but the sentences link with "because", "so", "but", "and". The text has to flow, it must not read like a chopped-up list.
- Everyday words. Explain in one sentence any concept the answer used that they may not know. No unexplained jargon.
- Talk about what happens, not about names. Do not list names of mods, files, commands or options in parentheses. Mention a name only if they need to type it.
- Active voice, simple tenses, subject and verb before any detail.
- Ignore the "I can go deeper on" line and any offer to go deeper.

Example of what NOT to do:
"Three mods use toast: decision-log (decision noted, 15s), context-handoff (three warnings) and phone-ping (errors only). The other two do not. Nothing, it is all mapped."

Example of what to do:
"The notice that goes away on its own shows up in three cases: when I note a decision of yours, when the context compacts, and when the push to your phone fails. The summary and the error translation do not use it, because they stay on screen until you close them."`;
const TLDR_PT = `Você reescreve a resposta de um assistente de código como um resumo curto para um dev que quer o essencial sem ler a resposta inteira, contado do jeito que um colega explicaria pessoalmente.

Formato: um parágrafo só, em pt-BR, de 2 a 3 frases, no máximo 40 palavras. Sem markdown, sem lista, sem rótulo, sem título.

Como escrever:
- Primeira frase diz o resultado ou a resposta. Última frase diz o que ele precisa fazer, só se houver algo. Se não houver, não escreva "nada": apenas termine antes.
- Uma ideia por frase, até 20 palavras cada, mas as frases se ligam com "porque", "então", "mas", "e". O texto tem que fluir, não pode parecer uma lista picada.
- Palavras do dia a dia. Explique em uma frase qualquer conceito que a resposta usou e que ele pode não conhecer. Nada de jargão sem explicação.
- Fale do que acontece, não de nomes. Não liste nomes de mods, arquivos, comandos ou opções entre parênteses. Cite um nome só se ele precisa digitar aquilo.
- Voz ativa, tempos simples, sujeito e verbo antes de qualquer detalhe.
- Ignore a linha "I can go deeper on" e qualquer oferta de aprofundar.

Exemplo do que NÃO fazer:
"Três mods usam toast: decision-log (decisão anotada, 15s), context-handoff (três avisos) e phone-ping (só erro). Os outros dois não usam. Nada, está tudo mapeado."

Exemplo do que fazer:
"O aviso que some sozinho aparece em três situações: quando eu anoto uma decisão sua, quando o contexto compacta, e quando o push pro celular falha. Já o resumo e a tradução de erro não usam aviso, porque ficam fixos na tela até você fechar."`;
const TLDR = t({ en: TLDR_EN, 'pt-BR': TLDR_PT });
const TLDR_MIN_WORDS = 300;

// pt-BR is verbatim from the error-translator mod; en is a faithful translation.
const ERROR = t({
  en: `You explain terminal errors to a developer who prefers short sentences.
Answer in English, at most 2 sentences, one idea per sentence, no unexplained jargon.
Sentence 1: what broke. Sentence 2: the most likely cause or what to check.
No introduction, no markdown, no repeating the command.`,
  'pt-BR': `Você explica erros de terminal para um dev que prefere frases curtas.
Responda em pt-BR, no máximo 2 frases, uma ideia por frase, sem jargão não explicado.
Frase 1: o que quebrou. Frase 2: a causa mais provável ou o que checar.
Sem introdução, sem markdown, sem repetir o comando.`,
});
const ERROR_INPUT = t({ en: { command: 'Command', output: 'Output' }, 'pt-BR': { command: 'Comando', output: 'Saída' } });
const MAX_OUTPUT_CHARS = 3000;
// Exit 1 from these means "no match", not a failure worth explaining.
const QUIET_ON_EXIT_1 = /^\s*(grep|rg|egrep|fgrep|test|\[|diff|cmp|which|pgrep)\b/;

const CLAIMS = `You compare what a coding assistant says in its final reply with what its tool calls actually did, and point at claims that look weak. You never judge whether a claim is true: the user may ask read-only checkers to settle the ones you point at.

You get, in order: the latest messages (context only), reports from helper agents that finished recently, the tool calls of the last few turns with an excerpt of each result, and then the final reply. A claim that the assistant read, ran or saw something is weak when no tool call shows it doing that.

Flag a claim when it is one of these and nothing in the reports or tool calls supports it:
- A quantitative or comparative claim: "small", "most", "rarely", "faster", "cheaper", "the gain is", a number or a percentage.
- A claim about how code, a tool or a system behaves when that code was not read or run.
- An external fact (docs, an API, a library, a version, a price, research) with no source fetched.
- A cause or an explanation ("this happens because…", "it comes from…") that no evidence shows.
- A conclusion or recommendation that rests on something the reply itself calls inferred, likely, unverified or not checked, even when that admission sits in a side note.

Do not flag:
- A claim that a tool result or an agent report supports, even when the reply rounds or rewords it.
- Questions, greetings, plans, or what the assistant is about to do.
- Restatements of what the user said.

Check every factual sentence of the reply against the evidence; an assistant that sounds sure is not evidence. If you cannot find support, flag it.

Answer with a JSON array of at most 4 objects and nothing else: no prose, no code fence. Put the claims that drive a decision first. Each object has two strings: "claim" quotes or closely paraphrases the assistant's statement, and "why" says plainly why it lacks evidence. Use at most 25 words per object. Answer [] only when every claim has support.`;
// The notice is read by the user, so it follows the app's language, never the reply's.
const CLAIMS_LANGUAGE = () => t({
  en: '\n\nWrite every string in plain English, with everyday words.',
  'pt-BR': '\n\nWrite every string in simple Brazilian Portuguese, with everyday words, quotes included: translate any English you would use. Never mix languages.',
});
const EXTRACT_CLAIMS = `Extract only factual claims the assistant actually makes in the selected reply. A claim must be specific enough for someone to confirm or refute using evidence. Skip opinions, analysis, conjecture, plans, recommendations, questions, and restatements of what the user said. Do not add facts or judge which claims are true.

Answer with only a JSON array of at most 4 objects, highest-impact claims first. Each object has a "claim" string that quotes or closely paraphrases the factual statement in at most 25 words. Return [] if there are no checkable claims.`;
const MAX_CLAIMS = 4;
const MAX_CLAIM_CHARS = 200;
const MAX_REPLY_CHARS = 12_000;

// The mods capped output at 300/200 tokens and waited 20/15 s; through the CLI, Haiku's hidden reasoning counts too and each call boots a process.
const MAX_TOKENS = 2000;
const asking = new Set<Asking>();
const track = (prev: { q: Asking | null }) => (q: Asking | null) => {
  if (prev.q) asking.delete(prev.q);
  prev.q = q;
  if (q) asking.add(q);
};

const exitCodeOf = (text: string) => {
  const m = /exit code[:\s]+(\d+)/i.exec(text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
};

export function resultText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
}

// Haiku's short summary of a long answer; null when the answer is short or the call failed.
export async function tldr(answer: string, provider: Provider): Promise<{ text: string; words: number } | null> {
  if (!tuning().sideNotes) return null;
  const words = proseWords(answer);
  if (words < TLDR_MIN_WORDS) return null;
  const reply = await ask(answer, track({ q: null }), TLDR, { effort: 'low', maxTokens: MAX_TOKENS, timeoutMs: 30_000, provider });
  const text = (reply ?? '').replace(/\s+/g, ' ').trim();
  return text ? { text, words } : null;
}

// Two plain sentences on why a Bash command failed; null when it is not worth explaining.
export async function explainError(command: string, output: string, provider: Provider): Promise<string | null> {
  if (!tuning().sideNotes) return null;
  if (exitCodeOf(output) === 1 && QUIET_ON_EXIT_1.test(command)) return null;
  const tail = output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output;
  const reply = await ask(`${ERROR_INPUT.command}:\n${command.slice(0, 500)}\n\n${ERROR_INPUT.output}:\n${tail}`, track({ q: null }), ERROR, { effort: 'low', maxTokens: MAX_TOKENS, timeoutMs: 25_000, provider });
  return reply?.trim() || null;
}

export async function findClaims(reply: string, evidence?: { conversation: string; reports: string[]; tools: string[] }, signal?: AbortSignal): Promise<{ claim: string; why: string }[] | null> {
  const input = evidence ? [
    `Latest messages (context only):\n${evidence.conversation}`,
    `Agent reports:\n${evidence.reports.length ? evidence.reports.join('\n\n') : '(none)'}`,
    `Tool calls in the last turns:\n${evidence.tools.length ? evidence.tools.join('\n') : '(none)'}`,
    `Final reply:\n${reply.slice(-MAX_REPLY_CHARS)}`,
  ].join('\n\n') : `Selected reply:\n${reply}`;
  const usage = (u: { input: number; cached: number; output: number }) => console.error(`claim check usage: ${u.input} in (${u.cached} cached), ${u.output} out`);
  signal?.throwIfAborted();
  const active = { q: null as Asking | null };
  const stop = () => active.q?.close();
  signal?.addEventListener('abort', stop, { once: true });
  const text = await ask(input, track(active), (evidence ? CLAIMS : EXTRACT_CLAIMS) + CLAIMS_LANGUAGE(), {
    model: CLAIMS_MODEL, effort: 'medium', maxTokens: MAX_TOKENS, timeoutMs: 60_000, provider: 'claude', usage,
  }).finally(() => signal?.removeEventListener('abort', stop));
  const start = text?.indexOf('[') ?? -1;
  const end = text?.lastIndexOf(']') ?? -1;
  if (!text || start < 0 || end <= start) {
    console.error('claim check: no usable answer');
    return null;
  }
  let arr: unknown;
  // The model's answer is outside data: a malformed array means no notice.
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    console.error('claim check: answer was not a JSON array');
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const { claim, why } = item as Record<string, unknown>;
    if (typeof claim !== 'string' || !claim.trim() || (evidence && (typeof why !== 'string' || !why.trim()))) return [];
    return [{ claim: oneLine(claim, MAX_CLAIM_CHARS), why: evidence && typeof why === 'string' ? oneLine(why, MAX_CLAIM_CHARS) : '' }];
  }).slice(0, MAX_CLAIMS);
}

export function closeNotes() {
  for (const q of asking) q.close();
}
