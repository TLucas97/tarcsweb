import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { actsSection, CallSummaries, EARLIER, earlierCall } from './callMemory.ts';
import { CallTiming } from './callTiming.ts'; // [DEBUG-calltime]
import { CodexClient, CodexError } from './codex/client.ts';
import { codexAccount } from './codex/account.ts';
import { shell } from './codex/history.ts';
import { NATIVE_AGENTS_OFF, toItem, TurnAnswer } from './codex/threads.ts';
import type {
  Method, RateLimitSnapshot, RateLimitWindow, RealtimeInitialItem, ThreadItem, ThreadRealtimeClosedNotification, ThreadRealtimeErrorNotification, ThreadRealtimeSdpNotification,
  ThreadRealtimeStartParams, ThreadRealtimeTranscriptDoneNotification, ThreadTokenUsage, Turn,
} from './codex/types.ts';
import { CACHE_DIR, config, t } from './config.ts';
import type { ToolGrant } from './mcpHost.ts';
import { tuning } from './profile.ts';
import type { CallActivity, CallLine, CallMessage, CallReport, CallState, CallUsage, ServerMessage } from './protocol.ts';
import type { Session } from './session.ts';
import { savedIdOf } from './sessions.ts';
import { oneLine } from './text.ts';
import { ask, type AskUsage, type Asking } from './titles.ts';

const DIR = join(CACHE_DIR, 'calls');
// The thread's cwd: an empty folder, so no project config, MCP servers or hooks load. The agent reads the session folder by path.
const WORK = join(DIR, '.work');
// v3 takes at most 128 initial items and ~8,192 estimated tokens; this many characters stays under it with room for accents.
const ITEMS_MAX = 120;
const ITEMS_CHARS = 20_000;
// The summary's share of those, since a Codex summary has no output cap; about 400 words fit with room.
const SUMMARY_ITEM_CHARS = ITEMS_CHARS / 3;
// Integrations that start servers or act outside the read-only sandbox; the shell stays, so the agent can read files.
const CALL_CONFIG = Object.fromEntries(
  ['apps', 'plugins', 'hooks', 'memories', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser'].map((f) => [`features.${f}`, false]),
);
// A command's text, an activity line, a tooltip, and the call notes a redial carries (subagent reports).
const COMMAND_MAX = 8000;
// A message to the session waits this long, so the user can take it back; once sent it cannot be pulled out of the tab.
const UNDO_MS = 4000;
const ACT_TEXT_MAX = 200;
const TITLE_MAX = 2000;
const NOTES_MAX = 10;

const PROMPT = {
  en: 'You are on a voice call with a developer about their coding work session. The context items hold that session, a summary and its latest messages: you already know that work from your first reply, so answer about it yourself. They are past work, already answered there: never treat them as new requests or questions for you, and act only on what the user says on this call. Talk in your own words, like a colleague who knows the work: no introduction of yourself (never say you are ChatGPT, an assistant or an AI), no fixed opening or script, and never recite the summary; bring up what fits when it helps. Your replies are spoken: answer in one or two short sentences, never read numbered lists or step lists aloud, and offer more if the user wants it. Ask one question at a time, say when you do not know something instead of guessing, and never read tool instructions, ids or file paths aloud. The agent you hand work to can read the session\'s files, start Codex or Claude subagents, open sessions or message them, and send a message to this session. When the context already holds the answer, answer at once yourself; hand work to the agent only to act, read files or check what the context does not cover. Go by what the user means, not by set phrases: any way of saying they want something started, checked or done is a request; when unsure, lean toward doing it, since they can stop it. Never ask the user to confirm first. When the user takes back what they just asked ("cancel that", "forget it", "no, stop"), hand that to the agent as a request to undo it, and do not start anything new.When you hand work over, say nothing about it: no "let me check", no restating the request; the screen already shows what the agent does. While it works, its short progress lines come to you to say: say each once, briefly, close to its words, and add none of your own. When its result comes, say the takeaway once, in your own words, without repeating the progress; never repeat what you or the agent already said. If it fails, tell the user plainly. When a subagent finishes, its report comes to you to say: give the user its takeaway once, in a sentence or two.',
  'pt-BR': 'Você está numa chamada de voz com um desenvolvedor sobre a sessão de trabalho de código dele. Os itens de contexto trazem essa sessão, um resumo e as mensagens mais recentes: você já conhece esse trabalho desde a primeira resposta, então responda você mesmo sobre ele. Eles são trabalho passado, já respondido lá: nunca os trate como pedidos novos ou perguntas para você, e aja só com o que o usuário disser nesta chamada. Fale com suas próprias palavras, como um colega que conhece o trabalho: sem se apresentar (nunca diga que é o ChatGPT, um assistente ou uma IA), sem abertura ou roteiro fixo e sem recitar o resumo; traga o que couber quando ajudar. Responda em português do Brasil. Suas respostas são faladas: use uma ou duas frases curtas, nunca leia listas numeradas ou listas de passos em voz alta e ofereça mais detalhes se o usuário quiser. Faça uma pergunta por vez, diga quando não souber algo em vez de chutar e nunca leia em voz alta instruções de ferramentas, ids ou caminhos de arquivo. O agente para quem você passa trabalho pode ler os arquivos da sessão, iniciar subagentes Codex ou Claude, abrir sessões ou mandar mensagem para elas e enviar uma mensagem para esta sessão. Quando o contexto já tiver a resposta, responda na hora você mesmo; passe trabalho para o agente só para agir, ler arquivos ou verificar o que o contexto não cobre. Entenda o que o usuário quer dizer, não frases prontas: qualquer jeito de dizer que quer algo iniciado, verificado ou feito é um pedido; na dúvida, prefira fazer, porque ele pode parar depois. Nunca peça confirmação ao usuário antes. Quando o usuário desfizer o que acabou de pedir ("cancela isso", "esquece", "não, para"), passe isso ao agente como um pedido para desfazer, e não comece nada novo.Ao passar trabalho para o agente, não fale nada sobre isso: nada de "vou conferir" nem repetir o pedido; a tela já mostra o que o agente faz. Enquanto ele trabalha, as frases curtas de andamento dele chegam para você dizer: diga cada uma uma vez, breve, perto das palavras dele, sem acrescentar as suas. Quando o resultado chegar, diga a conclusão uma vez, com suas palavras, sem repetir o andamento; nunca repita o que você ou o agente já disseram. Se falhar, diga isso ao usuário com clareza. Quando um subagente termina, o relatório dele chega a você para ser dito: conte ao usuário a conclusão uma vez, em uma ou duas frases.',
};
const AGENT = {
  en: (cwd: string, context: string) => `You back a voice call about a coding work session. Your replies are read aloud: one or two short sentences, with no lists, ids or file paths. The session's files are in ${cwd}; read them there by absolute path when the call needs it. ${context} holds what was said in that session (a summary and the latest messages) and a "This call so far" section rewritten at each request: read it before answering anything about the session. You do not change files yourself; you act only through your app tools. Go by what the user means, in any wording; when unsure whether they want an action, do it, since they can stop it. When asked to try, run, check or test something, do it with your tools (read the files, start a subagent, open or message a session, send a message to this session); never answer that you cannot act when one of them fits. Act right away, without asking the user to confirm. When the user takes back what they just asked, undo the newest thing you started for it and start nothing new: stop that subagent with its stop tool (use the id its start returned), or cancel a message still waiting to go out with cancel_command. A message already sent cannot be pulled back, so say so.Your short messages between tool calls are spoken as progress while you work: before a lookup, and when you move to another relevant step, write one brief line on the action or a real finding ("I'll look at the test script", then "Read the script, now checking the open items"). Never narrate each tool call, share your reasoning, repeat a line, claim progress you have not made or say it is almost done without evidence; skip progress for a quick answer. End with one final answer that has the result and nothing the progress lines or the call already said. Subagents run in the session's agents panel under its permission mode and their reports go straight to the voice, so never wait for them. For questions about this call's token use or the Codex usage limit, call call_usage.`,
  'pt-BR': (cwd: string, context: string) => `Você dá apoio a uma chamada de voz sobre uma sessão de trabalho de código. Suas respostas são lidas em voz alta: uma ou duas frases curtas, sem listas, ids ou caminhos de arquivo. Os arquivos da sessão estão em ${cwd}; leia-os por esse caminho absoluto quando a chamada precisar. ${context} traz o que foi dito nessa sessão (um resumo e as mensagens mais recentes) e uma seção "Esta chamada até agora" reescrita a cada pedido: leia esse arquivo antes de responder qualquer coisa sobre a sessão. Você não altera arquivos por conta própria; você age só pelas suas ferramentas do app. Entenda o que o usuário quer dizer, com qualquer palavra; na dúvida se ele quer uma ação, faça, porque ele pode parar depois. Quando pedirem para tentar, rodar, verificar ou testar algo, faça com suas ferramentas (ler os arquivos, iniciar um subagente, abrir ou mandar mensagem para uma sessão, enviar uma mensagem para esta sessão); nunca responda que não pode agir quando uma delas servir. Aja na hora, sem pedir confirmação ao usuário. Quando o usuário desfizer o que acabou de pedir, desfaça a coisa mais recente que você iniciou por esse pedido e não inicie nada novo: pare esse subagente com a ferramenta de parar (use o id que o início dele devolveu) ou cancele com cancel_command uma mensagem que ainda espera para sair. Uma mensagem já enviada não pode ser desfeita, então diga isso.Suas mensagens curtas entre chamadas de ferramenta são faladas como andamento enquanto você trabalha: antes de uma consulta, e quando passar para outra etapa relevante, escreva uma frase breve sobre a ação ou um achado real ("Vou consultar o roteiro de testes", depois "Li o roteiro, agora vou conferir as pendências"). Nunca narre cada chamada de ferramenta, não exponha seu raciocínio, não repita uma frase, não invente progresso nem diga que está quase pronto sem evidência; para uma resposta rápida, não mande andamento. Termine com uma resposta final, com o resultado e nada que o andamento ou a chamada já disseram. Os subagentes rodam no painel de agentes da sessão com o modo de permissão dela e os relatórios deles vão direto para a voz, então nunca espere por eles. Para perguntas sobre o consumo de tokens desta chamada ou o limite de uso do Codex, chame call_usage.`,
};
// Spoken when a delegated request fails, before its error.
const FAILED = { en: "Couldn't finish", 'pt-BR': 'Não consegui terminar' };
const PROGRESS_MAX = 200;
// Silence in a running turn after which the voice says the newest real step from the feed; it still waits for the user's pause.
const QUIET_STEP_MS = 6000;
const STEP_NOTE = {
  en: "The agent's current step, from its activity. Say it in a few words in the call's language, adding nothing:",
  'pt-BR': 'A etapa atual do agente, tirada da atividade dele. Diga em poucas palavras, no idioma da chamada, sem acrescentar nada:',
};
// What the voice is given to say when a subagent reports; a redial carries it as context.
const REPORT_NOTE = {
  en: 'A subagent started on this call finished. Tell the user its takeaway in a sentence or two; its report:',
  'pt-BR': 'Um subagente iniciado nesta chamada terminou. Conte ao usuário a conclusão em uma ou duas frases; o relatório dele:',
};
const HEAD = {
  en: (name: string, cwd: string) => `Context for this call: the work session "${name}", whose files are in ${cwd}. The next items are from that session, oldest first, then anything already said on this call before a reconnect.`,
  'pt-BR': (name: string, cwd: string) => `Contexto desta chamada: a sessão de trabalho "${name}", com os arquivos em ${cwd}. Os próximos itens vêm dessa sessão, do mais antigo ao mais novo, e depois o que já foi dito nesta chamada antes de uma reconexão.`,
};
const SUMMARY_LEAD = { en: 'Summary of the work session, for context:', 'pt-BR': 'Resumo da sessão de trabalho, como contexto:' };
const SUMMARY = {
  en: 'You summarize a coding work session so a voice assistant can talk with the developer about it. Write Markdown: the goal, what was done, where it stands now, open problems and the latest decisions. Keep it under about 400 words. Do not invent anything that is not in the material.',
  'pt-BR': 'Você resume uma sessão de trabalho de código para um assistente de voz conversar com o desenvolvedor sobre ela. Escreva em Markdown, em português do Brasil: o objetivo, o que foi feito, onde está agora, problemas em aberto e as decisões mais recentes. Use no máximo umas 400 palavras. Não invente nada que não esteja no material.',
};
const REPORT = {
  en: 'A voice call about a coding work session just ended; you get its transcript. Write a short Markdown report another AI session can continue from: the goal, what was decided, open questions and next steps. Do not invent anything that is not in the conversation.',
  'pt-BR': 'Uma chamada de voz sobre uma sessão de trabalho de código acabou; você recebe a transcrição. Escreva um relatório curto em Markdown, em português do Brasil, para outra sessão de IA continuar o trabalho: objetivo, o que ficou decidido, dúvidas em aberto e próximos passos. Não invente nada que não esteja na conversa.',
};

const CONTEXT = {
  en: {
    summary: 'Summary', latest: 'Latest messages', none: 'No summary could be made; the latest messages below are the context.',
    call: 'This call so far', callNote: 'The summary above describes the session before this call; this is what was said on the call.', quiet: 'Nothing said yet.',
  },
  'pt-BR': {
    summary: 'Resumo', latest: 'Mensagens mais recentes', none: 'Não deu para fazer o resumo; as mensagens mais recentes abaixo são o contexto.',
    call: 'Esta chamada até agora', callNote: 'O resumo acima descreve a sessão antes desta chamada; isto é o que foi dito na chamada.', quiet: 'Nada dito ainda.',
  },
};
const USAGE = {
  en: {
    title: 'Usage (measured by the app)', length: 'Call length', voice: 'Voice (Codex realtime): it reports audio time only, no tokens',
    agent: 'Codex behind the voice', summary: 'Session summary', report: 'This report', none: 'not measured', idle: 'did no work',
    cached: 'taken from the cache, no tokens spent on this call',
    estimate: 'Codex estimate for the agent', credits: (c: string, usd: string | null) => `${c} credits${usd === null ? '' : `, about US$ ${usd}`}`,
    requests: 'Each request (tokens and time)', running: 'still running',
    tokens: (i: string, c: string, o: string) => `${i} tokens in (${c} cached), ${o} out`, cost: (usd: string) => `about US$ ${usd} at API prices`,
    limit: (window: string, start: string, end: string) => `Codex usage limit (${window}): ${start}% used at the start, ${end}% at the end`,
    limitNow: (window: string, start: string, now: string) => `Codex usage limit (${window}): ${start}% used at the start, ${now}% now`,
    window: (mins: number | null) => (mins === null ? 'current window' : mins >= 10_080 ? 'weekly' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`),
    note: 'Codex runs on the ChatGPT plan and Claude on its subscription, so no call is billed per token; the dollar figures are estimates from Codex and the Claude CLI.',
  },
  'pt-BR': {
    title: 'Uso (medido pelo app)', length: 'Duração da chamada', voice: 'Voz (Codex realtime): informa só o tempo de áudio, sem tokens',
    agent: 'Codex por trás da voz', summary: 'Resumo da sessão', report: 'Este relatório', none: 'não medido', idle: 'não trabalhou',
    cached: 'tirado do cache, sem tokens gastos nesta chamada',
    estimate: 'Estimativa do Codex para o agente', credits: (c: string, usd: string | null) => `${c} créditos${usd === null ? '' : `, cerca de US$ ${usd}`}`,
    requests: 'Cada pedido (tokens e tempo)', running: 'ainda rodando',
    tokens: (i: string, c: string, o: string) => `${i} tokens de entrada (${c} em cache), ${o} de saída`, cost: (usd: string) => `cerca de US$ ${usd} pelo preço da API`,
    limit: (window: string, start: string, end: string) => `Limite de uso do Codex (${window}): ${start}% usado no início, ${end}% no fim`,
    limitNow: (window: string, start: string, now: string) => `Limite de uso do Codex (${window}): ${start}% usado no início, ${now}% agora`,
    window: (mins: number | null) => (mins === null ? 'janela atual' : mins >= 10_080 ? 'semanal' : mins >= 1440 ? `${Math.round(mins / 1440)} dias` : `${Math.round(mins / 60)} horas`),
    note: 'O Codex roda no plano do ChatGPT e o Claude na assinatura, então nada é cobrado por token; os valores em dólar são estimativas do Codex e do CLI do Claude.',
  },
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The backing thread's events the activity feed reads, besides thread/realtime/*; rate limits are account-wide.
const THREAD_EVENTS = new Set(['thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'item/started', 'item/completed']);
const LIMITS_UPDATED = 'account/rateLimits/updated';
// The call's own transcript in the context file (newest kept), and the gap between usage messages to the client.
const CALL_SO_FAR_CHARS = 12_000;
const USAGE_MS = 5000;

// What the voice delegated, without the tags and metadata Codex wraps around it.
function delegated(raw: string) {
  const input = /<input>([\s\S]*?)<\/input>/.exec(raw)?.[1] ?? raw;
  return input.replace(/<(source|source_thread_id)>[\s\S]*?<\/\1>/g, ' ').replace(/<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>/gi, ' ');
}

// The longest window of the Codex usage limit (weekly on ChatGPT plans), the one a call's share shows in.
function longest(s: RateLimitSnapshot | null) {
  return [s?.primary, s?.secondary].filter((w): w is RateLimitWindow => !!w).sort((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0))[0] ?? null;
}

// Feed text never shows an absolute path: the call's context file gets a name, the session folder goes, other paths keep their base name.
function tidy(call: Call, text: string, max = ACT_TEXT_MAX) {
  const cwd = call.session.cwd;
  const named = text.split(contextFile(call)).join('the session context').split(`${cwd}/`).join('').split(cwd).join(basename(cwd));
  return oneLine(named.replace(/(?<![\w:/.])~?\/(?:[^\s/'"`]+\/)*([^\s/'"`]+)/g, '$1'), max);
}

// The feed's step line for one item of the backing thread, in plain words; null for items it does not show.
// Requests head their turn's steps (see note()), and a run's line lives on until its report.
function activityOf(call: Call, item: ThreadItem, done: boolean): CallActivity | null {
  const at = Date.now();
  // One wording per moment: running, done, failed.
  const step = (ok: boolean, [now, past, failed]: [string, string, string], title?: string): CallActivity => ({
    id: `item:${item.id}`, kind: 'step', text: !done ? now : ok ? past : failed, state: !done ? 'running' : ok ? 'done' : 'failed', at, ...(title ? { title } : {}),
  });
  switch (item.type) {
    case 'commandExecution': {
      const ok = item.status === 'completed' && !item.exitCode;
      const title = tidy(call, shell(item.command), 400);
      const acts: unknown[] = Array.isArray(item.commandActions) ? item.commandActions : [];
      const field = (a: unknown, key: string) => {
        const v = (a as Record<string, unknown> | null)?.[key];
        return typeof v === 'string' && v ? v : null;
      };
      const fileName = (a: unknown) => {
        const path = field(a, 'path');
        if (path && resolve(item.cwd, path) === contextFile(call)) return 'the session context';
        return path ? basename(path) : field(a, 'name');
      };
      const reads = acts.map((a) => (field(a, 'type') === 'read' ? fileName(a) : null));
      if (reads.length && reads.every((r) => r !== null)) {
        const what = reads.length > 2 ? `${reads.slice(0, 2).join(', ')} and ${reads.length - 2} more` : reads.join(' and ');
        return step(ok, [`Reading ${what}`, `Read ${what}`, `Couldn't read ${what}`], title);
      }
      const first = acts[0];
      if (field(first, 'type') === 'listFiles') {
        const path = field(first, 'path');
        const where = path && path !== '.' ? basename(path) : 'a folder';
        return step(ok, [`Looking at ${where}`, `Looked at ${where}`, `Couldn't look at ${where}`], title);
      }
      const query = field(first, 'type') === 'search' ? field(first, 'query') : null;
      if (query) {
        const q = `"${tidy(call, query, 60)}"`;
        return step(ok, [`Searching for ${q}`, `Searched for ${q}`, `Couldn't search for ${q}`], title);
      }
      return step(ok, ['Running a command', 'Ran a command', 'A command failed'], title);
    }
    case 'fileChange': {
      const files = item.changes.map((c) => basename(c.path)).join(', ') || 'files';
      return step(item.status === 'completed', [`Editing ${files}`, `Edited ${files}`, `Couldn't edit ${files}`]);
    }
    case 'webSearch': {
      const q = item.query ? ` for "${tidy(call, item.query, 60)}"` : '';
      return step(true, [`Searching the web${q}`, `Searched the web${q}`, '']);
    }
    case 'mcpToolCall': {
      const ok = item.status !== 'failed' && !item.error;
      if (item.server !== 'app') return step(ok, [`Using ${item.tool}`, `Used ${item.tool}`, `Couldn't use ${item.tool}`]);
      if (item.tool === 'codex_agent' || item.tool === 'claude_agent') {
        const who = `${item.tool === 'codex_agent' ? 'Codex' : 'Claude'} agent`;
        const desc = tidy(call, String((item.arguments as { description?: unknown } | null)?.description ?? ''), 60);
        return { id: `run:cx:${item.id}`, kind: 'agent', text: ok ? `Started a ${who}: ${desc}` : `Couldn't start a ${who}: ${desc}`, state: ok ? 'running' : 'failed', at };
      }
      // sendText's own row shows the text that went.
      if (item.tool === 'send_command' || item.tool === 'cancel_command') return null;
      if (item.tool === 'call_usage') return step(ok, ["Checking the call's usage", "Checked the call's usage", "Couldn't read the call's usage"]);
      if (item.tool === 'open_session') return step(ok, ['Opening a session', 'Opened a session', "Couldn't open the session"]);
      if (item.tool === 'session_message') return step(ok, ['Messaging a session', 'Messaged a session', "Couldn't reach the session"]);
      if (item.tool.endsWith('_stop')) return step(ok, ['Stopping an agent', 'Stopped an agent', "Couldn't stop the agent"]);
      return step(ok, ['Sending a follow-up to an agent', 'Sent a follow-up to an agent', "Couldn't reach the agent"]);
    }
    // Its thinking and its answer show as the request's state, not as rows.
    default:
      return null;
  }
}

// The realtime session closed under a dial, so there is nothing left to stop. Dropped is the close a fresh call recovers from.
class Closed extends CodexError {}
class Dropped extends Closed {}

// Its own app-server, so the experimental realtime flag never reaches the shared one; it boots on a call.
// The flag is a no-op from 0.166 (realtime is always on) and stays for 0.155.
export const callCodex = new CodexClient({ label: 'call', args: ['--enable', 'realtime_conversation'], idleMs: () => tuning().callCodexIdleMs });
// The call's Codex only reads: approvals are declined and any other server request is refused.
callCodex.setRequestHandler(async (req) => {
  if (req.method === 'item/commandExecution/requestApproval' || req.method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  throw new CodexError(`A voice call does not handle ${req.method}`, -32601);
});

type Client = object;
type Out = CallMessage | Extract<ServerMessage, { type: 'notice' }>;
type Listener = (m: Out, to: Client) => void;
type Call = {
  c: Client;
  // The client's id for this call; messages for any other call are dropped.
  id: string;
  sessionId: string;
  session: Session;
  dir: string;
  // Shared by the call's files: <stamp>-context.md, -conversation.md and -report.md.
  stamp: string;
  startedAt: number;
  endedAt: number | null;
  // Token use per part; the backing thread's is its running total, cost Codex's estimate for it (credits, USD).
  usage: {
    agent: ThreadTokenUsage['total'] | null; summary: AskUsage | 'cached' | null; report: AskUsage | null; cost: { credits: number; usd: number | null } | null;
  };
  // The newest turn and the thread's total when it began, so its request row gets its own tokens; kept past its end for a late update.
  turn: { id: string; base: ThreadTokenUsage['total'] | null } | null;
  state: CallState;
  threadId: string | null;
  // Capped at tuning().callLinesMax; past it the oldest go.
  lines: CallLine[];
  summary: string | null;
  // The newest earlier call of this session, read from its saved files before the voice starts.
  earlier: string | null;
  // The feed rows, newest state per id, for the saved conversation; capped at ACTS_KEPT.
  acts: Map<string, CallActivity>;
  // Redials in a row without a line heard in between.
  tries: number;
  redialAt: number;
  dialing: boolean;
  // The client's number for the offer in use; a reconnecting message names the one that is gone.
  offer: number;
  // A browser redial stopped the old realtime session, whose close is still on its way.
  closing: boolean;
  answer: { ok: (sdp: string) => void; fail: (e: Error) => void } | null;
  // A failed attempt whose session may still run: stopped before the next one waits for an SDP, so its late answer is never taken.
  stale: Promise<unknown> | null;
  release: (() => void) | null;
  asking: Set<Asking>;
  file: string | null;
  reporting: boolean;
  // Set once the call ends; every later finish waits on it.
  ending: Promise<void> | null;
  // The backing thread's app tools on the tab, revoked when the call finishes.
  grant: ToolGrant | null;
  // The Codex usage limit's longest window: its length and percent used at call start and now.
  limit: { mins: number | null; start: number | null; now: number | null };
  // usage messages go out at most every USAGE_MS; the timer sends the newest one.
  usageAt: number;
  usageTimer: ReturnType<typeof setTimeout> | undefined;
  // The feed's header for the turn the backing thread runs now; it settles when the turn ends.
  request: CallActivity | null;
  // Context file writes run one at a time; this is the newest.
  contextWrite: Promise<void>;
  // Aborted when the call ends, so an action still on its way (a session message waking its target) does nothing.
  abort: AbortController;
  // What the voice was told mid-call, so a redial carries it; capped at NOTES_MAX, oldest first. seq numbers them.
  // now: said at once (a failure, or a run that needs the user); otherwise at the user's next pause.
  notes: { seq: number; text: string; now: boolean }[];
  noteSeq: number;
  // The newest note the running realtime session has, from its items or appended since.
  noted: number;
  // Notes waiting for the next pause, which the client reports from the mic level; capped at NOTES_MAX.
  held: string[];
  // The backing agent's answer in the running turn; only its final answer is spoken (clientManagedHandoffs).
  reply: TurnAnswer | null;
  // The running turn's newest progress line waiting for a pause (older ones are stale), and the last one said, to skip repeats.
  progress: string | null;
  said: string;
  // Fires after QUIET_STEP_MS with nothing said in a running turn; step is the feed row it last queued, so it never repeats.
  quiet: ReturnType<typeof setTimeout> | undefined;
  step: string;
  // Messages to the session still inside their undo window, by feed row id; each lives UNDO_MS.
  pending: Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>;
  // [DEBUG-calltime]
  timing?: CallTiming;
};

const active = (call: Call) => call.state === 'connecting' || call.state === 'live' || call.state === 'reconnecting';
const conversation = (call: Call) => call.lines.map((l) => `**${l.role === 'user' ? 'User' : 'Codex'}:** ${l.text}`).join('\n\n');
const contextFile = (call: Call) => join(call.dir, `${call.stamp}-context.md`);
// A session's call folder: its saved files, the summary cache and earlier calls.
const dirOf = (s: Session) => join(DIR, savedIdOf(s) ?? s.id);
// Feed rows a saved conversation lists; the previous call's item gets a sixth of the item budget.
const ACTS_KEPT = 60;
const EARLIER_ITEM_CHARS = ITEMS_CHARS / 6;

// What the backing agent reads about the session: written at start, again with the summary before the voice starts, and at each request.
function contextText(call: Call) {
  const s = call.session;
  const L = t(CONTEXT);
  const messages = s.recentMessages(tuning().callSummaryChars).map((m) => `**${m.who}:** ${m.text}`).join('\n\n');
  const said: string[] = [];
  let room = CALL_SO_FAR_CHARS;
  for (let i = call.lines.length - 1; i >= 0 && room > 0; i--) {
    const l = call.lines[i];
    said.unshift(`**${l.role === 'user' ? 'User' : 'Voice'}:** ${l.text}`);
    room -= l.text.length;
  }
  return `# ${s.name}\n\n${s.cwd}\n\n## ${L.summary}\n\n${call.summary ?? L.none}\n\n## ${L.latest}\n\n${messages}\n\n`
    + (call.earlier ? `## ${t(EARLIER).head}\n\n${call.earlier}\n\n` : '')
    + `## ${L.call}\n\n${L.callNote}\n\n${said.join('\n\n') || L.quiet}\n`;
}

const usageOf = (call: Call): CallUsage => ({
  agentInput: call.usage.agent?.inputTokens ?? 0, agentCached: call.usage.agent?.cachedInputTokens ?? 0, agentOutput: call.usage.agent?.outputTokens ?? 0,
  limitAtStart: call.limit.start, limitNow: call.limit.now, credits: call.usage.cost?.credits ?? null, usd: call.usage.cost?.usd ?? null,
});

// The running turn's tokens since it began, from the thread's totals.
function spentOf(call: Call, ms: number | null): NonNullable<CallActivity['usage']> {
  const a = call.usage.agent;
  const b = call.turn?.base;
  const d = (k: 'inputTokens' | 'cachedInputTokens' | 'outputTokens') => (a?.[k] ?? 0) - (b?.[k] ?? 0);
  return { input: d('inputTokens'), cached: d('cachedInputTokens'), output: d('outputTokens'), ms };
}

// The usage section of the saved files; midCall words the limit as "now" for call_usage.
function usageText(call: Call, withReport: boolean, midCall = false) {
  const L = t(USAGE);
  const n = (x: number) => x.toLocaleString('en-US');
  // Codex asks report tokens only, no cost.
  const ask = (u: AskUsage | 'cached' | null) => (u === 'cached' ? L.cached : u ? `${L.tokens(n(u.input), n(u.cached), n(u.output))}${u.costUsd === null ? '' : `, ${L.cost(u.costUsd.toFixed(4))}`}` : L.none);
  const a = call.usage.agent;
  const c = call.usage.cost;
  const secs = Math.round(((call.endedAt ?? Date.now()) - call.startedAt) / 1000);
  const asked = [...call.acts.values()].flatMap((r) => (r.kind === 'request' && r.usage ? [{ text: r.text, u: r.usage }] : []));
  return [
    `## ${L.title}`, '',
    `- ${L.length}: ${Math.floor(secs / 60)} min ${secs % 60} s`,
    `- ${L.voice}`,
    `- ${L.agent}: ${a ? L.tokens(n(a.inputTokens), n(a.cachedInputTokens), n(a.outputTokens)) : L.idle}`,
    ...(a ? [`- ${L.estimate}: ${c ? L.credits(String(+c.credits.toFixed(4)), c.usd === null ? null : c.usd.toFixed(4)) : L.none}`] : []),
    ...(asked.length ? [`- ${L.requests}:`, ...asked.map(({ text, u }) => (
      `  - "${text}": ${L.tokens(n(u.input), n(u.cached), n(u.output))}, ${u.ms === null ? L.running : `${Math.round(u.ms / 1000)} s`}`
    ))] : []),
    `- ${L.summary}: ${ask(call.usage.summary)}`,
    ...(withReport ? [`- ${L.report}: ${ask(call.usage.report)}`] : []),
    ...(call.limit.start === null ? [] : [`- ${(midCall ? L.limitNow : L.limit)(L.window(call.limit.mins), String(Math.round(call.limit.start)), String(Math.round(call.limit.now ?? call.limit.start)))}`]),
    '', L.note,
  ].join('\n');
}

// Voice calls with Codex realtime, one per socket. The browser holds the WebRTC link; this side starts, redials and saves.
class Calls {
  private calls = new Map<Client, Call>();
  // A start waiting for its session to wake; stop, drop or a newer start replaces or clears it.
  private waking = new Map<Client, { sessionId: string; callId: string }>();
  // Every call still stopping and saving, dropped ones included, so a shutdown can wait for them.
  private finishing = new Set<Promise<void>>();
  private listeners = new Set<Listener>();
  private summaries = new CallSummaries(DIR);

  constructor() {
    callCodex.onNotification((method, params) => this.note(method, params));
    callCodex.onExit((reason) => {
      for (const call of this.calls.values()) void this.finish(call, 'error', reason);
    });
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private send(c: Client, m: Out) {
    for (const fn of this.listeners) fn(m, c);
  }

  private emit(call: Call, extra: Omit<CallMessage, 'type' | 'sessionId' | 'callId' | 'state'> = {}) {
    const a = extra.activity;
    // Requests, messages and subagents, not their steps; a row with no text is removed on screen, so it leaves the list too.
    if (a && a.kind !== 'step') {
      if (a.text) call.acts.set(a.id, a);
      else call.acts.delete(a.id);
      if (call.acts.size > ACTS_KEPT) call.acts.delete(call.acts.keys().next().value!);
    }
    this.send(call.c, { type: 'call', sessionId: call.sessionId, callId: call.id, state: call.state, ...extra });
  }

  // Also the redial path: a newer offer for the running call, after a drop or because the browser's own link failed.
  async start(c: Client, sessionId: string, callId: string, sdp: string, offer: number, find: () => Session | undefined | Promise<Session | undefined>) {
    const cur = this.calls.get(c);
    if (cur && active(cur)) {
      if (cur.id !== callId) return this.send(c, { type: 'notice', message: 'A call is already running in this window. End it first.' });
      if (cur.state !== 'connecting' && !cur.dialing && offer > cur.offer) await this.redial(cur, sdp, offer);
      return;
    }
    // A late offer for a call that already ended never starts it again.
    if (cur?.id === callId) return;
    this.drop(c);
    const ticket = { sessionId, callId };
    this.waking.set(c, ticket);
    const s = await find();
    if (this.waking.get(c) !== ticket) return;
    this.waking.delete(c);
    if (!s) return this.send(c, { type: 'call', sessionId, callId, state: 'error', error: 'The session is closed.' });
    const startedAt = Date.now();
    const call: Call = {
      c, id: callId, sessionId, session: s, dir: dirOf(s), startedAt,
      stamp: `${new Date(startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomUUID().slice(0, 6)}`,
      endedAt: null, usage: { agent: null, summary: null, report: null, cost: null }, turn: null, state: 'connecting', threadId: null, lines: [], summary: null, earlier: null, acts: new Map(), tries: 0, redialAt: 0, dialing: false, offer, closing: false,
      answer: null, stale: null, release: callCodex.hold(), asking: new Set(), file: null, reporting: false, ending: null, grant: null, limit: { mins: null, start: null, now: null }, usageAt: 0, usageTimer: undefined,
      request: null, contextWrite: Promise.resolve(), abort: new AbortController(), notes: [], noteSeq: 0, noted: 0, held: [], reply: null, progress: null, said: '', quiet: undefined, step: '', pending: new Map(),
    };
    // [DEBUG-calltime]
    call.timing = new CallTiming(join(call.dir, `${call.stamp}-timing.jsonl`), startedAt);
    this.calls.set(c, call);
    this.emit(call);
    try {
      const status = codexAccount.status ?? (await codexAccount.check());
      if (!status.signedIn) throw new Error('Sign in to Codex to start a call.');
      if (call.state !== 'connecting') return;
      await mkdir(call.dir, { recursive: true });
      // Ended meanwhile: finish() may already have removed the context file, so it is not written again.
      if (call.state !== 'connecting') return;
      await this.writeContext(call);
      await mkdir(WORK, { recursive: true });
      // Ended while the files were written: no summary and no app-server work for a call that is gone.
      if (call.state !== 'connecting') return;
      // Made while the thread is set up; the voice waits for it, so its first reply already knows the work. A failed one leaves the latest messages.
      const summarized = Promise.all([
        this.summarize(call).catch((e) => console.warn(`[call] context summary failed: ${errText(e)}`)),
        earlierCall(call.dir, EARLIER_ITEM_CHARS).then((x) => void (call.earlier = x), (e) => console.warn(`[call] earlier call not read: ${errText(e)}`)),
      ]);
      // Every MCP server Codex would load, by the names it parsed, so a call never starts one; the grant's own servers stay.
      const { config } = await callCodex.request('config/read', { cwd: WORK });
      if (call.state !== 'connecting') return;
      call.grant = s.callTools({
        // A subagent this call started reports here: a feed line, and its report for the voice.
        report: (text) => {
          if (!active(call)) return;
          const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';
          // The summary reads 'Codex agent "name" (model) completed'; the feed keeps who and how.
          const m = /^(Codex|Claude) agent "(.*)" \(/.exec(tag('summary'));
          const who = m ? `${m[1]} agent "${tidy(call, m[2], 60)}"` : 'A subagent';
          const status = tag('status');
          const line = status === 'completed' ? `${who} finished` : status === 'killed' ? `${who} was stopped` : `${who} failed`;
          this.emit(call, { activity: { id: `run:${tag('tool-use-id')}`, kind: 'agent', text: line, state: status === 'failed' ? 'failed' : 'done', at: Date.now() }, chime: true });
          // A result that ends on a question needs the user, so it is said at once like a failure or a stop.
          const asks = tag('result').trimEnd().endsWith('?');
          this.inform(call, `${t(REPORT_NOTE)}\n\n${text}`, status !== 'completed' || asks);
        },
        // A stop sends no report, so the run's row ends here.
        stopped: (id, name) => {
          const text = `Stopped ${name ? `"${tidy(call, name, 60)}"` : 'the agent'}`;
          if (active(call)) this.emit(call, { activity: { id: `run:${id}`, kind: 'agent', text, state: 'done', at: Date.now() } });
        },
        signal: call.abort.signal,
      }, this.ownTools(call));
      // The usage limit as the call starts, to compare with later; a failed read leaves the call without it.
      void this.readLimit(call, true).catch((e) => console.warn(`[call] usage limit not read: ${errText(e)}`));
      const granted = call.grant.config;
      const mcpOff = Object.fromEntries(Object.keys(config.mcp_servers ?? {}).filter((name) => !(`mcp_servers.${name}` in granted)).map((name) => [`mcp_servers.${name}.enabled`, false]));
      const { thread, model, reasoningEffort } = await callCodex.request('thread/start', {
        cwd: WORK, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: t(AGENT)(s.cwd, contextFile(call)),
        // Codex's own child agents would run outside the agents panel, and their reports would never reach the call.
        config: { ...CALL_CONFIG, ...NATIVE_AGENTS_OFF, ...mcpOff, ...granted },
      }, tuning().callThreadMs);
      if (call.state !== 'connecting') return;
      call.threadId = thread.id;
      // [DEBUG-calltime] The settings each measured call ran with, to compare runs.
      call.timing?.mark('config', { model, reasoningEffort, ackFiller: 'default', quietStepMs: QUIET_STEP_MS });
      await summarized;
      if (call.state !== 'connecting') return;
      await this.writeContext(call).catch(() => {});
      await this.connect(call, sdp);
    } catch (e) {
      if (e instanceof Dropped) this.lost(call, e.message);
      else void this.finish(call, 'error', errText(e));
    }
  }

  async stop(c: Client, callId: string) {
    const w = this.waking.get(c);
    if (w?.callId === callId) {
      this.waking.delete(c);
      return this.send(c, { type: 'call', sessionId: w.sessionId, callId, state: 'ended' });
    }
    const call = this.calls.get(c);
    if (call?.id === callId) await this.finish(call, 'ended');
  }

  // call-dismiss, a new call or the socket closing (no callId: whatever this socket had). A running call still saves.
  drop(c: Client, callId?: string) {
    if (!callId || this.waking.get(c)?.callId === callId) this.waking.delete(c);
    const call = this.calls.get(c);
    if (!call || (callId && call.id !== callId)) return;
    this.calls.delete(c);
    for (const q of call.asking) q.close();
    void this.finish(call, 'ended');
  }

  // Server shutdown: every call stops its realtime session and saves its conversation, dropped ones included.
  async close() {
    this.summaries.close();
    for (const call of this.calls.values()) void this.finish(call, 'ended');
    await Promise.all(this.finishing);
  }

  async report(c: Client, callId: string) {
    const call = this.calls.get(c);
    if (!call || call.id !== callId || active(call) || call.reporting || !call.lines.length) return;
    call.reporting = true;
    this.emit(call, { report: { state: 'working' } });
    let report: CallReport;
    try {
      const body = (await ask(`Session: ${call.session.name}\n\n${conversation(call)}`, this.track(call, () => this.calls.get(c) === call), t(REPORT), {
        provider: call.session.provider, timeoutMs: tuning().callReportMs, maxTokens: 4000, usage: (u) => (call.usage.report = u),
      }))?.trim();
      if (!body) throw new Error('The report could not be written.');
      const text = `${body}\n\n${usageText(call, true)}`;
      const file = join(call.dir, `${call.stamp}-report.md`);
      await mkdir(call.dir, { recursive: true });
      await writeFile(file, `${text}\n`);
      report = { state: 'ready', text, file };
    } catch (e) {
      report = { state: 'failed', error: errText(e) };
    }
    call.reporting = false;
    if (this.calls.get(c) === call) this.emit(call, { report });
  }

  // The text waits UNDO_MS in the feed (with an Undo button), then goes to this session as the user's own message, marked as coming from the call.
  private holdText(call: Call, text: string) {
    if (!active(call)) throw new Error('The call has ended.');
    if (call.session.isClosed) throw new Error('The session tab was closed.');
    const id = `cmd:${randomUUID().slice(0, 8)}`;
    const at = Date.now();
    call.pending.set(id, { text, timer: setTimeout(() => this.release(call, id), UNDO_MS) });
    this.emit(call, { activity: { id, kind: 'command', text: `Sending to the session: ${tidy(call, text)}`, state: 'running', at, until: at + UNDO_MS } });
    return `Held for ${UNDO_MS / 1000} seconds, then sent to the session. cancel_command takes it back until then.`;
  }

  // Sends a held message now (its window ran out, or the call ended: the user asked for it).
  private release(call: Call, id: string) {
    const held = call.pending.get(id);
    if (!held) return;
    call.pending.delete(id);
    clearTimeout(held.timer);
    let text = `Sent to the session: ${tidy(call, held.text)}`;
    let state: CallActivity['state'] = 'done';
    // A timer callback must not throw; a tab closed during the window shows as a failed row.
    try {
      if (call.session.isClosed) throw new Error('The session tab was closed.');
      call.session.send(held.text, [], [], [], false, undefined, undefined, [], { sessionId: call.sessionId, role: 'call', actor: 'user' });
    } catch (e) {
      text = `Not sent (${oneLine(errText(e), 60)}): ${tidy(call, held.text)}`;
      state = 'failed';
    }
    this.emit(call, { activity: { id, kind: 'command', text, state, at: Date.now() } });
  }

  // Takes a held message back before it goes out; false when its window already closed.
  private cancel(call: Call, id: string) {
    const held = call.pending.get(id);
    if (!held) return false;
    call.pending.delete(id);
    clearTimeout(held.timer);
    this.emit(call, { activity: { id, kind: 'command', text: `Cancelled, not sent: ${tidy(call, held.text)}`, state: 'done', at: Date.now() } });
    return true;
  }

  // The Undo button in the feed.
  undo(c: Client, callId: string, id: string) {
    const call = this.calls.get(c);
    if (call?.id === callId) this.cancel(call, id);
  }

  // The usage limit's longest window, read fresh from Codex (the cached one when a first read fails); the first read is the start.
  private async readLimit(call: Call, first = false) {
    const limits = await callCodex.request('account/rateLimits/read', undefined, tuning().callStopMs).then((r) => r.rateLimits, () => (first ? codexAccount.limits : null));
    const w = longest(limits);
    if (!w) return;
    if (first) call.limit = { mins: w.windowDurationMins, start: w.usedPercent, now: w.usedPercent };
    else if (call.limit.start !== null && w.windowDurationMins === call.limit.mins) call.limit.now = w.usedPercent;
    this.pushUsage(call);
  }

  // Codex's estimate for the backing thread, which it fetches from the ChatGPT backend; a missing one keeps the last.
  private async readCost(call: Call) {
    if (!call.threadId) return;
    const { threadUsage: u } = await callCodex.request('account/usage/read', { threadId: call.threadId }, tuning().callStopMs);
    if (u) call.usage.cost = { credits: u.estimatedUsageCreditsMicros / 1e6, usd: u.estimatedUsageUsdMicros === null ? null : u.estimatedUsageUsdMicros / 1e6 };
    this.pushUsage(call);
  }

  // At most one usage message per USAGE_MS, always ending on the newest numbers.
  private pushUsage(call: Call) {
    if (call.usageTimer || !active(call)) return;
    call.usageTimer = setTimeout(() => {
      call.usageTimer = undefined;
      call.usageAt = Date.now();
      if (active(call)) this.emit(call, { usage: usageOf(call) });
    }, Math.max(0, call.usageAt + USAGE_MS - Date.now()));
  }

  // One write at a time, each to a temp file renamed over the old one, so the agent never reads a half-written file.
  // The text is taken when the write runs, so a queued write carries the newest state.
  private writeContext(call: Call) {
    const file = contextFile(call);
    const next = call.contextWrite.then(async () => {
      await writeFile(`${file}.tmp`, contextText(call));
      await rename(`${file}.tmp`, file);
    });
    call.contextWrite = next.catch((e) => console.warn(`[call] context not written: ${errText(e)}`));
    return next;
  }

  // A note for the voice to say: spoken once a realtime session is live, and carried into a redial's items as context.
  private inform(call: Call, text: string, now: boolean) {
    call.notes.push({ seq: ++call.noteSeq, text, now });
    if (call.notes.length > NOTES_MAX) call.notes.shift();
    this.flushNotes(call);
  }

  // Says or holds the notes the running realtime session has not had yet, in its items or since.
  private flushNotes(call: Call) {
    if (call.state !== 'live') return;
    let held = false;
    for (const n of call.notes) {
      if (n.seq <= call.noted) continue;
      if (n.now) this.speak(call, n.text, 'report-now');
      else {
        call.held.push(n.text);
        if (call.held.length > NOTES_MAX) call.held.shift();
        held = true;
      }
    }
    call.noted = call.noteSeq;
    if (held) this.emit(call, { held: true });
  }

  // Speakable text for the voice; appendText would only add context it never says.
  private speak(call: Call, text: string, kind = 'note') {
    const sent = Date.now(); // [DEBUG-calltime]
    call.timing?.mark('speak', { kind, len: text.length }); // [DEBUG-calltime]
    // server/codex/types.ts has no entry for it yet: params { threadId, text }, result {}.
    void callCodex.request('thread/realtime/appendSpeech' as Method, { threadId: call.threadId!, text } as never)
      .then(() => call.timing?.mark('speak-ack', { kind, ackMs: Date.now() - sent })) // [DEBUG-calltime]
      .catch((e) => console.warn(`[call] speech not appended: ${errText(e)}`));
    this.armQuiet(call);
  }

  // Restarts the silence timer while a delegated turn runs; anything said or queued restarts it.
  private armQuiet(call: Call) {
    clearTimeout(call.quiet);
    call.quiet = call.request ? setTimeout(() => this.quietStep(call), QUIET_STEP_MS) : undefined;
  }

  // The turn's newest real step goes to the pause queue like a progress line; with no new step, nothing is said.
  private quietStep(call: Call) {
    const turn = call.request;
    if (!turn || call.state !== 'live') return;
    let row: CallActivity | null = null;
    for (const a of call.acts.values()) if (a.kind === 'step' && a.id.startsWith('item:') && a.at >= turn.at && (!row || a.at >= row.at)) row = a;
    if (row && row.text !== call.step) {
      call.step = row.text;
      call.progress = `${t(STEP_NOTE)} ${row.text}`;
      call.timing?.mark('progress-held', { len: row.text.length, fallback: true }); // [DEBUG-calltime]
      this.emit(call, { held: true });
    }
    this.armQuiet(call);
  }

  // The client heard the user's mic go quiet: held notes are said now. Before a redial is live they wait for the next pause.
  pause(c: Client, callId: string) {
    const call = this.calls.get(c);
    if (!call || call.id !== callId || call.state !== 'live' || (!call.held.length && !call.progress)) return;
    call.timing?.mark('pause', { progress: !!call.progress, held: call.held.length }); // [DEBUG-calltime]
    if (call.progress) this.speak(call, (call.said = call.progress), 'progress');
    call.progress = null;
    for (const text of call.held.splice(0)) this.speak(call, text, 'report');
    this.emit(call, { held: false });
  }

  // [DEBUG-calltime] The browser's oai-events metadata into the timing log; only identifier-like values pass, so no text can.
  rt(c: Client, callId: string, events: unknown[]) {
    const call = this.calls.get(c);
    if (!call?.timing || call.id !== callId) return;
    const word = (v: unknown) => (typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v) ? v : undefined);
    const now = Date.now();
    for (const raw of events) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const type = word(e.type);
      if (!type || typeof e.age !== 'number' || !(e.age >= 0 && e.age < 60_000)) continue;
      const items = Array.isArray(e.items) ? e.items.slice(0, 20).map(word).filter(Boolean) : undefined;
      const deltas = Number.isSafeInteger(e.deltas) ? e.deltas : undefined;
      call.timing.mark('rt', {
        type, deltas, items, response: word(e.response), status: word(e.status), reason: word(e.reason), item: word(e.item), role: word(e.role), name: word(e.name), code: word(e.code),
      }, now - e.age);
    }
  }

  // The call's own tools for the backing thread: the send to this session, and usage on demand.
  private ownTools(call: Call) {
    const said = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const failed = (text: string) => ({ ...said(text), isError: true });
    return [
      tool(
        'send_command',
        'Send a message to this session, as the user\'s own message: what they asked to tell it or have it do. A busy session queues it; an idle one starts a turn with it. It goes out after a few seconds, during which cancel_command takes it back.',
        { text: z.string().trim().min(1).max(COMMAND_MAX).describe('The exact text to send, sent as is') },
        async ({ text }) => {
          try {
            return said(this.holdText(call, text));
          } catch (e) {
            const row = `Not sent (${oneLine(errText(e), 60)}): ${tidy(call, text)}`;
            if (active(call)) this.emit(call, { activity: { id: `cmd:${randomUUID().slice(0, 8)}`, kind: 'command', text: row, state: 'failed', at: Date.now() } });
            return failed(errText(e));
          }
        },
      ),
      tool(
        'cancel_command',
        'Take back the newest message sent with send_command that has not gone out yet. Once it is sent it cannot be pulled back.',
        {},
        async () => {
          const id = [...call.pending.keys()].pop();
          if (!id || !this.cancel(call, id)) return said('Nothing is waiting: the message was already sent and cannot be pulled back.');
          return said(call.pending.size ? `Cancelled. ${call.pending.size} more still waiting.` : 'Cancelled; it was not sent.');
        },
      ),
      tool(
        'call_usage',
        'This call so far: its length, the tokens used by you and by the session summary, and the Codex usage limit at the start of the call and now.',
        {},
        async () => {
          await this.readLimit(call);
          return said(usageText(call, false, true));
        },
      ),
    ];
  }

  // One realtime session on the call's thread; a redial starts a fresh one with what was said so far in its items.
  private async connect(call: Call, sdp: string) {
    const threadId = call.threadId!;
    const stop = () => callCodex.request('thread/realtime/stop', { threadId }, tuning().callStopMs);
    if (call.stale) {
      const stale = call.stale;
      call.stale = null;
      if (!(await stale.then(() => true, () => false))) return void this.finish(call, 'error', 'The previous call attempt could not be stopped.');
      if (!active(call)) return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<string>((ok, fail) => {
      call.answer = { ok, fail };
      timer = setTimeout(() => fail(new CodexError('Codex did not answer the call.')), tuning().callSdpMs);
    });
    // server/codex/types.ts lacks the 0.166 fields used here, so the params are typed in place.
    const params: ThreadRealtimeStartParams & { clientManagedHandoffs: boolean; includeStartupContext: boolean } = {
      threadId, outputModality: 'audio', transport: { type: 'webrtc', sdp }, version: 'v3', prompt: t(PROMPT), initialItems: this.items(call),
      // delegationAckFiller is left at Codex's default, as the TUI does; it was false until 2026-11-05 (see notes/voice-call/PAUSES.md).
      // As the Codex TUI does: Codex forwards nothing itself, the app speaks each final answer once, and the voice starts from our items.
      // Codex skips backendReasoningStatus under clientManagedHandoffs, so it is not passed.
      clientManagedHandoffs: true,
      includeStartupContext: false,
      // Read here, so a Settings change applies to the next call (and a redial).
      ...(config.callVoice ? { voice: config.callVoice } : {}),
    };
    const started = callCodex.request('thread/realtime/start', params);
    let remote: string;
    try {
      [, remote] = await Promise.all([started, answer]);
    } catch (e) {
      // A session that did not close itself may still start: stop it once its start settles. A redial waits for that stop.
      if (!(e instanceof Closed)) {
        const drained = started.then(() => stop(), () => undefined);
        drained.catch(() => {});
        if (active(call)) call.stale = drained;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      call.answer = null;
    }
    if (!active(call)) return void stop().catch(() => {});
    call.state = 'live';
    this.emit(call, { sdp: remote, offer: call.offer });
    // Notes that came while this session was being set up missed its items.
    this.flushNotes(call);
  }

  private async redial(call: Call, sdp: string, offer: number) {
    call.dialing = true;
    call.offer = offer;
    try {
      // The browser lost a link Codex still holds: that realtime session goes first, and its close is expected.
      if (call.state === 'live') {
        if (!this.retry(call, 'The browser lost the call link.')) return;
        call.closing = true;
        await callCodex.request('thread/realtime/stop', { threadId: call.threadId! }, tuning().callStopMs).catch(() => {});
      }
      await new Promise((done) => setTimeout(done, Math.max(0, call.redialAt - Date.now())));
      if (call.state === 'reconnecting') await this.connect(call, sdp);
    } catch (e) {
      this.lost(call, errText(e));
    } finally {
      call.dialing = false;
    }
  }

  // Counts one redial and sets its backoff; false once the redials ran out and the call ended.
  private retry(call: Call, why: string) {
    console.warn(`[call] ${why}`);
    const { callRedials, callRedialMs } = tuning();
    if (call.tries >= callRedials) {
      void this.finish(call, 'error', why);
      return false;
    }
    call.redialAt = Date.now() + callRedialMs * 2 ** call.tries;
    call.tries++;
    call.state = 'reconnecting';
    return true;
  }

  // Codex dropped the link or a redial failed: the client answers with an offer newer than the one named here.
  private lost(call: Call, why: string) {
    if (active(call) && this.retry(call, why)) this.emit(call, { offer: call.offer });
  }

  private finish(call: Call, state: 'ended' | 'error', error?: string): Promise<void> {
    if (call.ending) return call.ending;
    if (!active(call)) return Promise.resolve();
    // The user asked for these, so a message still in its undo window goes out now.
    for (const id of [...call.pending.keys()]) this.release(call, id);
    call.state = state;
    call.endedAt = Date.now();
    call.answer?.fail(new CodexError('The call ended.'));
    for (const q of call.asking) q.close();
    // At once, so nothing reaches the tab after End. Subagents it started keep running; their reports stay in the agents panel.
    call.grant?.revoke();
    call.grant = null;
    call.abort.abort();
    clearTimeout(call.usageTimer);
    call.usageTimer = undefined;
    clearTimeout(call.quiet);
    const ending = (async () => {
      // The save never waits on the stop, which fails anyway when the realtime session already closed.
      const stopped = call.threadId && callCodex.running
        ? callCodex.request('thread/realtime/stop', { threadId: call.threadId }, tuning().callStopMs).catch(() => {})
        : undefined;
      // A delegated turn still running would keep working and spending tokens for a call that is gone.
      const turnId = call.request?.id.replace(/^turn:/, '');
      if (turnId && call.threadId && callCodex.running) {
        void callCodex.request('turn/interrupt', { threadId: call.threadId, turnId }, tuning().callStopMs).catch(() => {});
      }
      call.file = await this.save(call).catch((e) => {
        console.error(`[call] could not save the conversation: ${errText(e)}`);
        return null;
      });
      // A dropped or replaced call ends quietly, so a new call on this socket never hears it.
      if (this.calls.get(call.c) === call) this.emit(call, { ...(error ? { error } : {}), ...(call.file ? { file: call.file } : {}) });
      // The limit and the cost at the end, read after the save so a slow read never holds it (or a shutdown), then saved again if they moved.
      if (call.file && callCodex.running) {
        const before = `${call.limit.now} ${call.usage.cost?.credits}`;
        await Promise.all([
          call.limit.start !== null && this.readLimit(call),
          this.readCost(call).catch((e) => console.warn(`[call] cost not read: ${errText(e)}`)),
        ]);
        if (`${call.limit.now} ${call.usage.cost?.credits}` !== before) await this.save(call).catch(() => {});
      }
      // pushUsage stops with the call, so the screen always gets the final numbers here.
      if (this.calls.get(call.c) === call) this.emit(call, { usage: usageOf(call) });
      // The context file is a working copy of session text for the agent; the conversation and report files keep the call.
      await call.contextWrite;
      await Promise.all([rm(contextFile(call), { force: true }), rm(`${contextFile(call)}.tmp`, { force: true })]).catch(() => {});
      await stopped;
      call.release?.();
      call.release = null;
    })();
    call.ending = ending;
    this.finishing.add(ending);
    void ending.then(() => this.finishing.delete(ending));
    return ending;
  }

  private note(method: string, params: unknown) {
    // Sparse updates for the whole account: a window this call tracks moves its "now".
    if (method === LIMITS_UPDATED) {
      const u = (params as { rateLimits: RateLimitSnapshot }).rateLimits;
      for (const call of this.calls.values()) {
        const w = [u.primary, u.secondary].find((x) => x && x.windowDurationMins === call.limit.mins);
        if (!w || call.limit.start === null || !active(call)) continue;
        call.limit.now = w.usedPercent;
        this.pushUsage(call);
      }
      return;
    }
    if (!method.startsWith('thread/realtime/') && !THREAD_EVENTS.has(method)) return;
    const threadId = (params as { threadId?: unknown }).threadId;
    const call = [...this.calls.values()].find((x) => x.threadId === threadId);
    if (!call) return;
    call.timing?.event(method, params); // [DEBUG-calltime]
    // After End, an interrupted turn's last events would still add rows to the ended call; its token count still counts.
    if (!active(call) && THREAD_EVENTS.has(method) && method !== 'thread/tokenUsage/updated') return;
    switch (method) {
      case 'thread/tokenUsage/updated': {
        const p = params as { turnId: string; tokenUsage: ThreadTokenUsage };
        call.usage.agent = p.tokenUsage.total;
        // The request row shows its own tokens as they grow; one updated after End is only kept for the saved files.
        const row = call.turn?.id === p.turnId ? call.acts.get(`turn:${p.turnId}`) : undefined;
        if (row) {
          const next = { ...row, usage: spentOf(call, row.usage?.ms ?? null) };
          if (call.request?.id === row.id) call.request = next;
          if (active(call)) this.emit(call, { activity: next });
          else call.acts.set(row.id, next);
        }
        return this.pushUsage(call);
      }
      case 'turn/started': {
        const { turn } = params as { turn: Turn };
        call.turn = { id: turn.id, base: call.usage.agent };
        // Shown once the delegated text arrives (its userMessage item), so a header always names its request.
        call.request = { id: `turn:${turn.id}`, kind: 'request', text: '', state: 'running', at: Date.now() };
        call.reply = new TurnAnswer();
        call.progress = null;
        call.said = '';
        call.step = '';
        this.armQuiet(call);
        // The agent may read the context now: it gets what this call already said and did.
        void this.writeContext(call).catch(() => {});
        return this.emit(call, { busy: true });
      }
      case 'turn/completed': {
        const { turn } = params as { turn: Turn };
        const r = call.request?.id === `turn:${turn.id}` && call.request.text ? call.request : null;
        call.request = null;
        clearTimeout(call.quiet);
        // Like the TUI: a completed turn's final answer is said once, without Codex's [FINAL] tag; an interrupted one says nothing.
        const answer = turn.status === 'completed' ? call.reply?.text?.trim().replace(/^\[FINAL\]\s*/, '') : null;
        call.reply = null;
        // A progress line not said yet is stale once the result is here; with nothing else held the client stops watching.
        if (call.progress) {
          call.progress = null;
          if (!call.held.length) this.emit(call, { held: false });
        }
        if (answer) this.speak(call, answer, 'answer');
        const failed = turn.status === 'failed';
        // r.at is the turn's start.
        if (r) this.emit(call, { activity: { ...r, state: failed ? 'failed' : 'done', usage: spentOf(call, Date.now() - r.at) } });
        void this.readCost(call).catch((e) => console.warn(`[call] cost not read: ${errText(e)}`));
        if (!failed) return this.emit(call, { busy: false });
        const text = `${t(FAILED)}: ${tidy(call, turn.error?.message ?? 'the request failed')}`;
        // Nothing else would tell the voice, which handed the request over and waits.
        this.speak(call, text, 'failure');
        return this.emit(call, { busy: false, activity: { id: `fail:${turn.id}`, kind: 'step', text, state: 'failed', at: Date.now() } });
      }
      case 'item/started':
      case 'item/completed': {
        const item = toItem((params as { item: unknown }).item);
        // What the voice delegated names the request; the raw text stays in the tooltip.
        if (item.type === 'userMessage') {
          const full = (item.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
          const text = tidy(call, delegated(full), 80);
          if (!text || !call.request) return;
          call.request = { ...call.request, text, title: full.slice(0, TITLE_MAX) };
          return this.emit(call, { activity: call.request });
        }
        // Commentary and untagged [ANALYSIS]/[COMMENTARY] text stay private, as in the TUI's is_private_realtime_agent_item.
        if (item.type === 'agentMessage' && method === 'item/completed' && call.reply
          && (item.phase === 'final_answer' || !/^\s*\[(ANALYSIS|COMMENTARY)\]/.test(item.text))) call.reply.add(item);
        // A commentary line between tool calls is the agent's progress: the newest waits for the user's next pause.
        if (item.type === 'agentMessage' && method === 'item/completed' && call.reply && item.phase === 'commentary') {
          const line = oneLine(item.text.replace(/^\s*\[COMMENTARY\]\s*/, ''), PROGRESS_MAX);
          if (line && !/^\s*\[ANALYSIS\]/.test(item.text) && line !== call.said && line !== call.progress) {
            call.progress = line;
            call.timing?.mark('progress-held', { len: line.length }); // [DEBUG-calltime]
            this.armQuiet(call);
            this.emit(call, { held: true });
          }
        }
        const activity = activityOf(call, item, method === 'item/completed');
        return activity ? this.emit(call, { activity }) : undefined;
      }
      case 'thread/realtime/sdp':
        return call.answer?.ok((params as ThreadRealtimeSdpNotification).sdp);
      case 'thread/realtime/transcript/done': {
        const p = params as ThreadRealtimeTranscriptDoneNotification;
        const text = p.text.trim();
        if (!text) return;
        const line: CallLine = { role: p.role === 'user' ? 'user' : 'assistant', text, at: Date.now() };
        call.lines.push(line);
        if (call.lines.length > tuning().callLinesMax) call.lines.shift();
        call.tries = 0;
        return this.emit(call, { line });
      }
      case 'thread/realtime/error': {
        const { message } = params as ThreadRealtimeErrorNotification;
        if (call.answer) return call.answer.fail(new CodexError(message));
        return this.emit(call, { error: message });
      }
      case 'thread/realtime/closed': {
        const { reason } = params as ThreadRealtimeClosedNotification;
        // Our own stops close with 'requested', and a browser redial waits for the old session's close.
        if (reason === 'requested' || call.closing) {
          call.closing = false;
          return;
        }
        const why = `The call closed (${reason ?? 'no reason'}).`;
        // transport_closed: Codex's own reattach got 404/410, so only a fresh call on the same thread recovers.
        const err = reason === 'transport_closed' ? new Dropped(why) : new Closed(why);
        if (call.answer) return call.answer.fail(err);
        if (call.state !== 'live') return;
        if (err instanceof Dropped) return this.lost(call, why);
        return void this.finish(call, 'error', why);
      }
    }
  }

  // Made while the call's thread starts, or taken from the cache; the voice starts with it in its items.
  // It is shared with hover warms and cached, so a hang-up lets it finish for the next call.
  private async summarize(call: Call) {
    const got = await this.summaries.get(call.dir, call.session, t(SUMMARY));
    if (!got || !active(call)) return;
    call.summary = got.text;
    call.usage.summary = got.usage;
  }

  // The pointer is on the call button: summarize the session now, so the click finds the summary ready.
  warm(s: Session | undefined) {
    if (s && tuning().callSummaryWarm) this.summaries.warm(dirOf(s), s, t(SUMMARY));
  }

  // Header, summary, the earlier call (a sixth), the session's newest messages and, on a redial, the call's notes (up to a quarter) and what was said (up to half).
  // Session messages go in as developer items, so the call never takes the coding agent's words as its own.
  private items(call: Call): RealtimeInitialItem[] {
    const s = call.session;
    const head: RealtimeInitialItem[] = [{ role: 'developer', text: t(HEAD)(s.name, s.cwd) }];
    const summary = call.summary && (call.summary.length > SUMMARY_ITEM_CHARS ? `${call.summary.slice(0, SUMMARY_ITEM_CHARS - 1)}…` : call.summary);
    if (summary) head.push({ role: 'developer', text: `${t(SUMMARY_LEAD)}\n\n${summary}` });
    if (call.earlier) head.push({ role: 'developer', text: call.earlier });
    // Newest first; the first note past the room is cut to fit and older ones stay out.
    const notes: RealtimeInitialItem[] = [];
    let room = ITEMS_CHARS / 4;
    for (let i = call.notes.length - 1; i >= 0 && room > 0; i--) {
      const { text } = call.notes[i];
      notes.unshift({ role: 'developer', text: text.length <= room ? text : `${text.slice(0, room - 1)}…` });
      room = text.length <= room ? room - text.length : 0;
    }
    call.noted = call.noteSeq;
    const budget = ITEMS_CHARS - [...head, ...notes].reduce((n, i) => n + i.text.length, 0);
    const said: RealtimeInitialItem[] = [];
    let used = 0;
    for (let i = call.lines.length - 1; i >= 0 && said.length < ITEMS_MAX / 2; i--) {
      const l = call.lines[i];
      if (used + l.text.length > budget / 2) break;
      said.unshift({ role: l.role, text: l.text });
      used += l.text.length;
    }
    const history = s.recentMessages(budget - used).slice(-(ITEMS_MAX - head.length - notes.length - said.length));
    return [...head, ...history.map((m) => ({ role: 'developer' as const, text: `${m.who}: ${m.text}` })), ...notes, ...said];
  }

  // Hands ask()'s running call to the record, so a hang-up or dismiss can close it. One that starts after live() turned false
  // (the call ended for a summary, the call was dismissed for a report) closes at once, since nothing would close it later.
  private track(call: Call, live: () => boolean) {
    let q: Asking | null = null;
    return (next: Asking | null) => {
      if (q) call.asking.delete(q);
      q = next;
      if (!q) return;
      if (live()) call.asking.add(q);
      else q.close();
    };
  }

  private async save(call: Call) {
    if (!call.lines.length) return null;
    const file = join(call.dir, `${call.stamp}-conversation.md`);
    await mkdir(call.dir, { recursive: true });
    await writeFile(file, `# Voice call: ${call.session.name}\n\n${new Date(call.startedAt).toLocaleString()} · ${call.session.cwd}\n\n${conversation(call)}\n\n${actsSection(call.acts.values())}${usageText(call, false)}\n`);
    return file;
  }
}

export const calls = new Calls();
