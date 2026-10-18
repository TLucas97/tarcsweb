import { ask, type Asking } from './titles.ts';
import { proseWords } from './voice.ts';
import { t } from './config.ts';
import type { Provider } from './protocol.ts';
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

export function closeNotes() {
  for (const q of asking) q.close();
}
