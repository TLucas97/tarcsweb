import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ASK_UPLOAD_MAX, type AskReply, type Mode, type Question, type RoundPick, type ServerEvent, type UiPromptAnswer, type UiPromptOp, type Upload } from '../protocol.ts';
import type { UiAsk } from '../surface.ts';
import type { CodexAsk } from '../codex/agents.ts';
import type { ApprovalDecision } from '../codex/threads.ts';
import type { ProtoBroker, ProtoSent, RoundBroker, RoundSent, UploadBroker } from '../appTools.ts';
import type { Phone } from '../phone.ts';
import { APP_TOOLS, cardCommand, diffDetail, protoKey, roundKey, summarizeFor, toolName, toolName as displayTool } from '../tools.ts';
import { t } from '../config.ts';
import { oneLine } from '../text.ts';
import { capAdd, guard } from './util.ts';

// Phone push titles for a wait on the user.
const WAIT = t({
  en: { question: 'Claude has a question', plan: 'Claude has a plan', other: 'Claude needs you' },
  'pt-BR': { question: 'Claude tem uma pergunta', plan: 'Claude tem um plano', other: 'Claude precisa de você' },
});
// The CLI gives a composer question 5 s; answer before it gives up.
const UI_ASK_MS = 4000;
// An unanswered Codex approval is cancelled after this.
const CODEX_ASK_MS = 10 * 60_000;
// What the allow card's "Deny…" box accepts.
const DENY_REASON_MAX = 2000;
// ```ui blocks that fell back to raw JSON, held for the next prompt.
const UI_FAIL_MAX = 5;
function uiFailNote(fails: { type: string; why: string }[]) {
  if (fails.length === 1) return `Your last reply had a ui block that did not draw (${fails[0].type}: ${fails[0].why}). It showed as raw JSON. Use the documented shape.`;
  return `Your last reply had ${fails.length} ui blocks that did not draw:\n${fails.map((f) => `- ${f.type}: ${f.why}`).join('\n')}\nThey showed as raw JSON. Use the documented shapes.`;
}

export type Ask = { tool: string; summary: string };

// An AskUserQuestion input in the card's shape; a malformed one falls back to the plain permission card.
function questionsOf(input: Record<string, unknown>): Question[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const out = input.questions.flatMap((q: Record<string, unknown>) =>
    q && typeof q.question === 'string' && Array.isArray(q.options)
      ? [{
          question: q.question, header: str(q.header), multiSelect: q.multiSelect === true,
          options: q.options.map((o: Record<string, unknown>) => ({ label: str(o?.label), description: str(o?.description), ...(typeof o?.preview === 'string' ? { preview: o.preview } : {}) })),
        }]
      : [],
  );
  return out.length ? out : undefined;
}
export type UiPromptAsk = { type: 'ui-prompt'; sessionId: string; id: string; op: UiPromptOp; text?: string; mode?: string };
// One pick per question (ask_round), the files sent to ask_upload (none to cancel), or what an ask_prototype card sent.
export type AskPick = RoundSent | { files: Upload[] } | ProtoSent;
// An ask_round, ask_upload or ask_prototype handler waiting for the user; id stays null until its tool_use is seen.
// question is what matches it to that tool_use; fits rejects a pick out of range.
type ChoiceWait = { id: string | null; tool: string; question: string; summary: string; fits: (pick: AskPick) => boolean; resolve: (pick: AskPick | null) => void };

// "Waiting for you to run pnpm test": the live line for a pending permission.
export function waitingText(a: Ask) {
  if (a.tool === APP_TOOLS.round) return 'Waiting for your answers';
  if (a.tool === APP_TOOLS.upload) return 'Waiting for your files';
  if (a.tool === APP_TOOLS.prototype) return 'Waiting for you to try the prototype';
  if (a.tool === 'Bash') return `Waiting for you to run ${oneLine(a.summary, 60)}`;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(a.tool)) return `Waiting for you to allow editing ${a.summary.split('/').pop()}`;
  return `Waiting for you to allow ${toolName(a.tool)}`;
}

export type AsksHost = {
  id: string;
  cwd: string;
  phone: Phone;
  mode: () => Mode;
  // An approved plan's mode, set in the same reply.
  setMode: (m: Mode) => void;
  beforePlan: () => Mode;
  remoteWanted: () => boolean;
  stopRequested: () => boolean;
  clearActivity: () => void;
  // A pending permission shows on its agent's row.
  permission: (id: string, agentID: string | undefined, on: boolean, row?: string) => void;
  toast: (text: string) => void;
  push: (e: ServerEvent) => void;
  mapChanged: () => void;
  onChange: () => void;
  touch: () => void;
};

// Everything that waits on the user: permission cards, ask_round/ask_upload, plugin composer questions, ui block failures.
export class Asks {
  private host: AsksHost;
  private pending = new Map<string, (allow: boolean, reply?: AskReply) => void>();
  readonly cards = new Map<string, Ask>();
  private choices: ChoiceWait[] = [];
  // ask_round and ask_upload tool_use ids seen before their handler ran, and clicks that came before it; cleared at turn end.
  private unclaimed: { id: string; tool: string; question: string }[] = [];
  private early = new Map<string, AskPick>();
  // Calls the user denied, for the error notes; cleared at turn end, since their results come within the turn.
  private denied = new Set<string>();
  private uiPromptListeners = new Set<(m: UiPromptAsk) => void>();
  private uiAsks = new Map<string, (a: UiPromptAnswer | null) => void>();
  // ```ui blocks the client could not draw, told to the model on the next prompt; capped at UI_FAIL_MAX and ID_CAP.
  private uiFails: { type: string; why: string }[] = [];
  private uiFailSeen = new Set<string>();

  constructor(host: AsksHost) {
    this.host = host;
  }

  // A permission card or question is waiting on the user.
  get waiting() {
    return this.pending.size > 0 || this.choices.length > 0;
  }

  // Whether the user denied this call; forgets it either way.
  wasDenied(id: string) {
    return this.denied.delete(id);
  }

  subscribeUiPrompt(fn: (m: UiPromptAsk) => void) {
    this.uiPromptListeners.add(fn);
    return () => this.uiPromptListeners.delete(fn);
  }

  answerUiPrompt(id: string, answer: UiPromptAnswer) {
    this.uiAsks.get(id)?.(answer);
  }

  // The first client showing this session answers; none in time reads as an empty, unavailable composer.
  composer(a: UiAsk): Promise<UiPromptAnswer | null> {
    if (!this.uiPromptListeners.size) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise((resolve) => {
      const done = (answer: UiPromptAnswer | null) => {
        clearTimeout(timer);
        this.uiAsks.delete(id);
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), UI_ASK_MS);
      this.uiAsks.set(id, done);
      for (const fn of this.uiPromptListeners) fn({ type: 'ui-prompt', sessionId: this.host.id, id, ...a });
    });
  }

  // A Codex approval as a permission card; it stays until answered, Codex or a stop settles it, or CODEX_ASK_MS passes.
  codexAsk(a: CodexAsk) {
    return new Promise<ApprovalDecision>((resolve) => {
      const id = `codex:${randomUUID()}`;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const finish = (allow: boolean, reply?: AskReply, cancelled = false) => {
        if (!this.pending.has(id)) return;
        clearTimeout(expiry);
        this.pending.delete(id);
        this.cards.delete(id);
        a.signal.removeEventListener('abort', onAbort);
        this.waitEnded();
        this.host.mapChanged();
        this.host.push({ type: 'permission-resolved', id, allow, ...(reply ? { reply } : {}), ...(cancelled ? { cancelled: true as const } : {}) });
        this.host.onChange();
        this.host.touch();
        resolve(cancelled ? 'cancel' : !allow ? 'decline' : reply?.always ? 'acceptForSession' : 'accept');
      };
      const onAbort = () => finish(false, undefined, true);
      if (a.signal.aborted) return resolve('cancel');
      a.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, finish);
      // Codex never times an approval out itself, so an unanswered one would hold its turn forever.
      expiry = setTimeout(() => guard('codex approval expiry', () => {
        if (!this.pending.has(id)) return;
        finish(false, undefined, true);
        this.host.toast(`${toolName(a.tool)} approval expired`);
        this.host.push({ type: 'error', message: `The ${toolName(a.tool)} approval (${oneLine(a.summary, 80)}) went unanswered for ${CODEX_ASK_MS / 60_000} minutes, so it was cancelled.` });
      }), CODEX_ASK_MS);
      this.waitStarted(WAIT.other);
      this.cards.set(id, { tool: a.tool, summary: a.summary });
      this.host.mapChanged();
      this.host.push({ type: 'permission', id, tool: a.tool, summary: a.summary, ...(a.command ? { command: a.command } : {}), title: a.title, always: true, ...(a.detail ? { detail: a.detail } : {}) });
      this.host.onChange();
    });
  }

  // ask_round handler: waits for the round's submit in the UI, the abort signal, or an interrupt.
  askRound: RoundBroker = (round, signal, toolUseId) => {
    const counts = round.questions.map((q) => q.options.length);
    const fits = (p: AskPick) => 'picks' in p && p.picks.length === counts.length && p.picks.every((a, i) => a.option === null || a.option < counts[i]);
    const summary = oneLine(round.title || round.questions.map((q) => q.title).join(' · '), 120);
    return this.waitFor(APP_TOOLS.round, roundKey(round), summary, fits, signal, toolUseId) as Promise<RoundSent | null>;
  };

  // ask_upload handler: same wait, settled by the card's send or cancel.
  askUpload: UploadBroker = async (ask, signal, toolUseId) => {
    const fits = (p: AskPick) => !Array.isArray(p) && 'files' in p && p.files.length <= ASK_UPLOAD_MAX;
    const pick = await this.waitFor(APP_TOOLS.upload, ask.prompt, oneLine(ask.prompt, 120), fits, signal, toolUseId);
    return pick && !Array.isArray(pick) && 'files' in pick ? pick.files : null;
  };

  // ask_prototype handler: same wait, settled by the card's Send or "Reply in chat".
  askPrototype: ProtoBroker = async (ask, signal, toolUseId) => {
    const fits = (p: AskPick) => !Array.isArray(p) && 'values' in p;
    const summary = oneLine(ask.title || ask.question || 'Prototype', 120);
    const pick = await this.waitFor(APP_TOOLS.prototype, protoKey(ask), summary, fits, signal, toolUseId);
    return pick && !Array.isArray(pick) && 'values' in pick ? pick : null;
  };

  private waitFor = (tool: string, question: string, summary: string, fits: (p: AskPick) => boolean, signal: AbortSignal | undefined, toolUseId: string | undefined) =>
    new Promise<AskPick | null>((resolve) => {
      let id = toolUseId ?? null;
      if (id) this.unclaimed = this.unclaimed.filter((u) => u.id !== id);
      else {
        const k = this.unclaimed.findIndex((u) => u.tool === tool && u.question === question);
        if (k >= 0) id = this.unclaimed.splice(k, 1)[0].id;
      }
      const w: ChoiceWait = {
        id, tool, question, summary, fits,
        resolve: (pick) => {
          signal?.removeEventListener('abort', onAbort);
          this.choices = this.choices.filter((c) => c !== w);
          if (w.id) this.cards.delete(w.id);
          // "Asking you a question" would read as still waiting once answered.
          this.host.clearActivity();
          this.waitEnded();
          this.host.mapChanged();
          this.host.onChange();
          resolve(pick);
        },
      };
      const onAbort = () => w.resolve(null);
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.choices.push(w);
      this.waitStarted(WAIT.question);
      this.host.onChange();
      if (id) this.claim(w, id);
    });

  private claim(w: ChoiceWait, id: string) {
    w.id = id;
    this.cards.set(id, { tool: w.tool, summary: w.summary });
    this.host.mapChanged();
    const early = this.early.get(id);
    if (early !== undefined) {
      this.early.delete(id);
      if (w.fits(early)) w.resolve(early);
    }
  }

  choiceSeen(id: string, tool: string, question: string) {
    // A Codex call can reach the handler, with its id, before its item event.
    if (this.choices.some((c) => c.id === id)) return;
    const w = this.choices.find((c) => c.id === null && c.tool === tool && c.question === question);
    if (w) this.claim(w, id);
    else this.unclaimed.push({ id, tool, question });
  }

  // pick is a round's answers, an upload's files or a prototype's values.
  answerChoice(id: string, pick: AskPick) {
    const w = this.choices.find((c) => c.id === id);
    if (!w) {
      if (this.unclaimed.some((u) => u.id === id)) this.early.set(id, pick);
      return;
    }
    if (w.fits(pick)) w.resolve(pick);
  }

  cancelChoices() {
    for (const w of [...this.choices]) w.resolve(null);
    this.unclaimed = [];
    this.early.clear();
  }

  // A tool_use whose handler never ran, or a denied call with no error note, is left over by now.
  turnEnded() {
    this.denied.clear();
    if (this.choices.length) return;
    this.unclaimed = [];
    this.early.clear();
  }

  // phone-ping: a permission or question still unanswered after the delay pushes to the phone.
  private waitStarted(title: string) {
    this.host.phone.schedule(this.host.id, title, (t) => this.host.toast(t));
  }

  private waitEnded() {
    if (!this.pending.size && !this.choices.length) this.host.phone.cancel(this.host.id);
  }

  answerPermission(id: string, allow: boolean, reply?: AskReply) {
    this.pending.get(id)?.(allow, reply);
  }

  // Every open client and the turn-end check (uiCheck.ts) report the same block, so it is kept once.
  uiBlockFailed(itemId: string, index: number, type: string, why: string) {
    const key = `${itemId}#${index}`;
    if (this.uiFailSeen.has(key)) return;
    capAdd(this.uiFailSeen, key);
    this.uiFails.push({ type: oneLine(type, 40), why: oneLine(why, 300) });
    if (this.uiFails.length > UI_FAIL_MAX) this.uiFails.shift();
  }

  // Consumed by the next prompt, on either provider.
  takeUiFailNote() {
    if (!this.uiFails.length) return null;
    const note = uiFailNote(this.uiFails);
    this.uiFails = [];
    return note;
  }

  canUseTool: CanUseTool = (toolName, input, opts) => this.askTool(toolName, input, opts, null);

  // sub: a claude_agent run asking; its card names it and its row shows the wait.
  askTool(
    toolName: string, input: Record<string, unknown>, { signal, title: asked, defaultToNo, toolUseID, agentID }: Parameters<CanUseTool>[2], sub: { row: string; name: string } | null,
  ) {
    const title = sub ? `Claude · ${sub.name}${asked ? ` — ${asked}` : ''}` : asked;
    return new Promise<PermissionResult>((resolve) => {
      const id = toolUseID || randomUUID();
      const finish = (allow: boolean, reply?: AskReply, elsewhere = false) => {
        this.pending.delete(id);
        this.cards.delete(id);
        // An allowed command keeps its "Running …" line; an answered question does not.
        if (!sub && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode')) this.host.clearActivity();
        if (!allow && !elsewhere) this.denied.add(id);
        this.waitEnded();
        this.host.mapChanged();
        this.host.permission(id, agentID, false, sub?.row);
        signal.removeEventListener('abort', onAbort);
        const result = this.decide(toolName, input, allow, reply);
        this.host.push({ type: 'permission-resolved', id, allow, ...(reply ? { reply } : {}), ...(elsewhere ? { elsewhere } : {}) });
        this.host.onChange();
        this.host.touch();
        resolve(result);
      };
      // With Remote Control on, the CLI cancels this ask when the phone answers it first.
      const onAbort = () => finish(false, undefined, this.host.remoteWanted() && !this.host.stopRequested());
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, finish);
      this.waitStarted(toolName === 'AskUserQuestion' ? WAIT.question : toolName === 'ExitPlanMode' ? WAIT.plan : WAIT.other);
      const summary = summarizeFor(this.host.cwd, toolName, input);
      this.cards.set(id, { tool: toolName, summary });
      this.host.mapChanged();
      this.host.permission(id, agentID, true, sub?.row);
      const detail = diffDetail(this.host.cwd, toolName, input);
      const questions = toolName === 'AskUserQuestion' ? questionsOf(input) : undefined;
      // The CLI puts the plan file's text into the input before asking.
      const plan = toolName === 'ExitPlanMode' ? (typeof input.plan === 'string' ? input.plan : '') : undefined;
      const mode = this.host.mode();
      const command = cardCommand(this.host.cwd, toolName, input);
      this.host.push({
        type: 'permission', id, tool: displayTool(toolName), summary, ...(command && command !== summary ? { command } : {}),
        ...(title ? { title } : {}), ...(defaultToNo ? { defaultToNo } : {}), ...(detail ? { detail } : {}),
        ...(questions ? { questions } : {}), ...(plan !== undefined ? { plan, back: mode === 'plan' ? this.host.beforePlan() : mode } : {}),
      });
      this.host.onChange();
    });
  }

  // Answers go back inside the input; an approved plan switches the mode in the same reply.
  private decide(tool: string, input: Record<string, unknown>, allow: boolean, reply?: AskReply): PermissionResult {
    if (!allow) {
      if (tool === 'ExitPlanMode' && reply?.feedback) return { behavior: 'deny', message: `The user wants to keep planning. Revise the plan with this feedback: ${reply.feedback}` };
      // The deny box is one line; index.ts allows plan-sized feedback, so a reason is cut to DENY_REASON_MAX here.
      if (tool !== 'AskUserQuestion' && reply?.feedback) return { behavior: 'deny', message: `The user denied this action and said: ${reply.feedback.slice(0, DENY_REASON_MAX)}` };
      return { behavior: 'deny', message: tool === 'AskUserQuestion' ? 'The user chose not to answer.' : 'The user denied this action.' };
    }
    if (tool === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...input, answers: reply?.answers ?? {} } };
    if (tool === 'ExitPlanMode' && reply?.mode) {
      this.host.setMode(reply.mode);
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: reply.mode, destination: 'session' }] };
    }
    return { behavior: 'allow', updatedInput: input };
  }
}
