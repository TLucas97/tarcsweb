import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { CLAIMS_MODEL, claimAgent, isClaimCorrection, type ClaimAgent, type ClaimChecker, type ClaimCheck, type ClaimClosing, type ExplainEvent, type Provider, type ServerEvent } from '../protocol.ts';
import { explainError, findClaims, resultText, tldr } from '../notes.ts';
import { closeClaims, loadClaimCheckers, verifyClaims, type ClaimRoundItem } from '../claimVerify.ts';
import { answerLight, explain, type ExplainRequest, type Fork } from '../explain.ts';
import { fullText } from '../stretch.ts';
import { oneLine } from '../text.ts';
import { config } from '../config.ts';
import { tuning } from '../profile.ts';
import type { EventLog } from './eventLog.ts';

// Main-thread tool calls kept per turn for the claim check; the newest win.
const TURN_TOOLS_MAX = 60;
// Earlier turns whose tool calls and agent reports still count as evidence for a reply.
const EVIDENCE_TURNS = 2;
const REPLY_TURNS_MAX = 20;
// Only the latest messages go to the detector: it compares the reply's claims with the tool calls, not the whole talk.
const RECENT_CHARS = 2500;

type ReplySnapshots = ReturnType<EventLog['turnReplies']> | null;
type ClaimsCard = { id: string; replyId?: string; extracting?: boolean; items: string[]; why: string[]; checks: ClaimCheck[]; checkers: ClaimChecker[]; reply: string; tools: string[] };

export type SideHost = {
  id: string;
  provider: () => Provider;
  persisted: () => boolean;
  resumeId: () => string | null;
  // The live CLI's options, with no brokers, for a throwaway fork.
  baseOptions: () => Options;
  recentText: (budget?: number) => string;
  cwd: () => string;
  // Results of subagents that finished after a time, for the claim check's evidence.
  agentReports: (since: number) => string[];
  push: (e: ServerEvent) => void;
  wasDenied: (id: string) => boolean;
  mapChanged: () => void;
};

// Model calls beside the conversation: tldr summaries, error notes, and the explain panel's forks.
export class SideCalls {
  private host: SideHost;
  // Main-thread Bash commands by tool_use id, for the error notes.
  private bashCalls = new Map<string, string>();
  private forks = new Set<AbortController>();
  // This turn's calls as one line each (input, then a result excerpt), by tool_use id; at most TURN_TOOLS_MAX.
  private turnTools = new Map<string, string>();
  // Keep only the last 20 Claude turns so checking a past reply has a bounded memory cost.
  private pastTurns: { end: number; tools: string[]; replies: ReplySnapshots }[] = [];
  claims: ClaimsCard | null = null;
  claimClosing: ({ id: string } & ClaimClosing) | null = null;
  private claimRun = 0;
  // Even an empty challenge suppresses detection until the next normal prompt.
  private challenge: { text?: string; round?: { items: ClaimRoundItem[]; checkers: ClaimChecker[] }; queuedId?: string } | null = null;
  private verifying: AbortController | null = null;

  constructor(host: SideHost) {
    this.host = host;
  }

  toolCalled(id: string, name: string, input: unknown) {
    if (this.host.provider() !== 'claude') return;
    this.turnTools.set(id, `${name} ${oneLine(JSON.stringify(input) ?? '', 200)}`);
    if (this.turnTools.size > TURN_TOOLS_MAX) this.turnTools.delete(this.turnTools.keys().next().value!);
  }

  toolDone(id: string, content: unknown, isError: boolean) {
    const call = this.turnTools.get(id);
    if (call !== undefined) this.turnTools.set(id, `${call}\n  -> ${isError ? 'error: ' : ''}${oneLine(resultText(content), 1200)}`);
  }

  async finishClaimTurn(replies: ReplySnapshots, reply: string | null) {
    if (this.host.provider() !== 'claude') return;
    const earlier = this.pastTurns.slice(-EVIDENCE_TURNS);
    const since = this.pastTurns.at(-EVIDENCE_TURNS - 1)?.end ?? 0;
    const turnTools = [...this.turnTools.values()];
    if (replies || turnTools.length) {
      this.pastTurns.push({ end: Date.now(), tools: turnTools, replies });
      if (this.pastTurns.length > REPLY_TURNS_MAX) this.pastTurns.shift();
    }
    this.turnTools.clear();
    if (this.challenge) {
      if (this.challenge.queuedId) return;
      const round = this.challenge.round;
      this.challenge = {};
      if (!round || !reply) return;

      this.dropClaims();
      const id = `claims:${this.claimRun}:closing`;
      this.claimClosing = { id, items: round.items.map((item) => item.text), checks: [] };
      const text = fullText(reply);
      await this.runClaimChecks(round.checkers, (checker, signal) => closeClaims(checker, round.items, text, turnTools, this.host.cwd(), signal), (check) => {
        if (this.claimClosing?.id !== id) return;
        this.claimClosing = { ...this.claimClosing, checks: [...this.claimClosing.checks.filter((k) => k.agent !== check.agent), check] };
        this.host.mapChanged();
      });
      return;
    }

    if (!reply || !config.claimAutoCheck || !tuning().claimCheck || this.verifying || this.claims?.replyId) return;
    this.dropClaims();
    const run = this.claimRun;
    try {
      const started = Date.now();
      const text = fullText(reply);
      const tools = [...earlier.flatMap((t) => t.tools), ...turnTools];
      const items = await findClaims(text, { conversation: this.host.recentText(RECENT_CHARS), reports: this.host.agentReports(since), tools });
      if (items) console.error(`claim check: ${items.length} claim(s) in ${Date.now() - started} ms`);
      // A prompt sent while the check ran makes its answer stale.
      if (run !== this.claimRun || !config.claimAutoCheck || !items?.length) return;
      const checkers = await loadClaimCheckers();
      if (run !== this.claimRun || !config.claimAutoCheck) return;
      this.claims = { id: `claims:${run}`, items: items.map((c) => c.claim), why: items.map((c) => c.why), checks: [], checkers, reply: text, tools };
      this.host.mapChanged();
    } catch (err) {
      console.error(`claim check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async checkReply(replyId: string, notice: (text: string) => void) {
    const run = this.claimRun;
    const turns = await Promise.all(this.pastTurns.map(async ({ replies, tools }) => ({
      snapshot: (await replies)?.find((r) => r.replyId === replyId), tools,
    })));
    const turn = turns.findLast((t) => t.snapshot);
    if (this.host.provider() !== 'claude' || !turn?.snapshot) return notice('This reply is not available to check.');
    if (this.verifying) return notice('A reply check is already running.');
    if (run !== this.claimRun) return notice('The conversation moved on. Check this reply again.');
    this.dropClaims();
    const id = `claims:${this.claimRun}`;
    const reply = fullText(turn.snapshot.reply);
    const ctl = this.verifying = new AbortController();
    this.claims = { id, replyId, extracting: true, items: [], why: [], checks: [], checkers: [], reply, tools: turn.tools };
    this.host.mapChanged();
    try {
      const items = await findClaims(reply, undefined, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!items) throw new Error('Claim extraction returned no usable answer');
      if (!items.length) {
        this.dropClaims();
        return notice('No checkable claims in this reply.');
      }
      const checkers = await loadClaimCheckers();
      if (ctl.signal.aborted) return;
      this.claims = { ...this.claims, extracting: false, items: items.map((c) => c.claim), checkers };
      this.verifying = null;
      await this.verifyClaims(checkers.map(claimAgent), id);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(`claim extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      this.dropClaims();
      notice('Could not extract claims from this reply.');
    }
  }

  dropClaims(challengeText?: string | null, queuedId?: string) {
    if (challengeText) {
      const c = this.claims;
      const checks = c?.checks.filter((check) => check.status === 'done') ?? [];
      const items = c?.items.map((text, i) => ({
        text,
        verdicts: checks.flatMap(({ agent, verdicts }) =>
          verdicts.filter((v) => v.claim === i + 1).map(({ verdict, note }) => ({ agent, verdict, note }))),
      })).filter(({ verdicts }) => isClaimCorrection(verdicts)) ?? [];
      // Requeuing the same prompt must keep its snapshot after the original card is gone.
      const round = items.length ? { items, checkers: c!.checkers.filter((checker) => checks.some((check) => check.agent === claimAgent(checker))) }
        : this.challenge?.text === challengeText ? this.challenge.round : undefined;
      this.challenge = { text: challengeText, queuedId, round };
    } else if (challengeText === null) {
      this.challenge = null;
    }
    this.verifying?.abort();
    this.verifying = null;
    this.claimRun++;
    if (!this.claims && !this.claimClosing) return;
    this.claims = null;
    this.claimClosing = null;
    this.host.mapChanged();
  }

  pickUpChallenge(id: string) {
    if (this.challenge?.queuedId === id) this.challenge.queuedId = undefined;
  }

  async verifyClaims(agents: ClaimAgent[], id?: string) {
    const c = this.claims;
    if (!c || this.verifying || (id && c.id !== id)) return;
    const checkers = c.checkers.filter((checker) => agents.includes(claimAgent(checker))
      || (agents.includes('haiku') && checker.provider === 'claude' && checker.model === CLAIMS_MODEL)
      || (agents.includes('codex') && checker.provider === 'codex'));
    await this.runClaimChecks(checkers, (checker, signal) => verifyClaims(checker, c.items, c.reply, c.tools, this.host.cwd(), signal), (check) => {
      if (this.claims?.id !== c.id) return;
      this.claims = { ...this.claims, checks: [...this.claims.checks.filter((k) => k.agent !== check.agent), check] };
      this.host.mapChanged();
    });
  }

  private async runClaimChecks<V>(checkers: ClaimChecker[], check: (checker: ClaimChecker, signal: AbortSignal) => Promise<V[]>, put: (check: ClaimCheck<V>) => void) {
    const ctl = this.verifying = new AbortController();
    await Promise.all(checkers.map(async (checker) => {
      const agent = claimAgent(checker);
      put({ agent, status: 'running', verdicts: [] });
      try {
        const verdicts = await check(checker, ctl.signal);
        if (!ctl.signal.aborted) put({ agent, status: 'done', verdicts });
      } catch (err) {
        if (ctl.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        console.error(`claim check (${agent}) failed: ${error}`);
        put({ agent, status: 'failed', verdicts: [], error });
      }
    }));
    if (this.verifying === ctl) this.verifying = null;
  }

  // tldr mod: a long answer gets a short summary on top; never awaited.
  async summarize(textId: string, answer: string) {
    try {
      const r = await tldr(fullText(answer), this.host.provider());
      if (r) this.host.push({ type: 'tldr', id: textId, ...r });
    } catch (err) {
      console.error(`tldr failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bashStarted(id: string, command: string) {
    this.bashCalls.set(id, command);
  }

  // error-translator mod: a failed Bash call the user did not deny or interrupt gets a plain explanation.
  bashFinished(id: string, content: unknown, isError: boolean) {
    const command = this.bashCalls.get(id);
    this.bashCalls.delete(id);
    const denied = this.host.wasDenied(id);
    if (command === undefined || !isError || denied) return;
    const output = resultText(content);
    if (/interrupted by user/i.test(output)) return;
    this.errorNote(id, command, output, this.host.provider());
  }

  errorNote(id: string, command: string, output: string, provider: Provider) {
    explainError(command, output, provider)
      .then((text) => text && this.host.push({ type: 'tool-note', id, text }))
      .catch((err) => console.error(`error note failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // explica mod: a throwaway fork of the transcript answers one side question, with tools denied.
  async explain(req: ExplainRequest, deep: boolean, reply: (e: ExplainEvent) => void) {
    const abort = new AbortController();
    this.forks.add(abort);
    try {
      const answer: Fork = deep && this.host.provider() === 'claude' ? (prompt, a) => this.forkAnswer(prompt, a) : (prompt, a) => answerLight(this.host.recentText(), prompt, a);
      await explain(this.host.id, req, answer, abort, reply);
    } finally {
      this.forks.delete(abort);
    }
  }

  private async forkAnswer(prompt: string, abort: AbortController) {
    const resumeId = this.host.resumeId();
    if (!this.host.persisted() || !resumeId) throw new Error('Nothing to explain yet: the conversation has not started');
    const fork = query({
      prompt,
      options: {
        ...this.host.baseOptions(),
        // A fork inherits rules that may open with a tool call (e.g. a progress report); the denial plus a spare turn lets it answer.
        resume: resumeId, forkSession: true, persistSession: false, maxTurns: 3, abortController: abort, permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools in the explain panel. Answer in text only.' }),
      },
    });
    const tried: string[] = [];
    let said = '';
    for await (const m of fork) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') tried.push(b.name);
          else if (b.type === 'text' && b.text.trim()) said = b.text;
        }
      }
      if (m.type !== 'result') continue;
      // The fork shares the live prompt, stretch guide included; the explain panel shows plain text.
      const text = fullText(m.subtype === 'success' && !m.is_error ? m.result.trim() || said : said);
      if (text.trim()) return text;
      console.error(`explain fork gave no text (${m.subtype}${tried.length ? `; tried ${tried.join(', ')}` : ''})`);
      throw new Error(m.subtype === 'success' ? 'The answer came back empty' : m.subtype);
    }
    throw new Error(abort.signal.aborted ? 'Stopped' : 'No answer');
  }

  close() {
    this.claimRun++;
    this.verifying?.abort();
    for (const a of this.forks) a.abort();
  }
}
