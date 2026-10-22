import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ExplainEvent, Provider, ServerEvent } from '../protocol.ts';
import { explainError, resultText, tldr } from '../notes.ts';
import { answerLight, explain, type ExplainRequest, type Fork } from '../explain.ts';
import { fullText } from '../stretch.ts';

export type SideHost = {
  id: string;
  provider: () => Provider;
  persisted: () => boolean;
  resumeId: () => string | null;
  // The live CLI's options, with no brokers, for a throwaway fork.
  baseOptions: () => Options;
  recentText: () => string;
  push: (e: ServerEvent) => void;
  wasDenied: (id: string) => boolean;
};

// Model calls beside the conversation: tldr summaries, error notes, and the explain panel's forks.
export class SideCalls {
  private host: SideHost;
  // Main-thread Bash commands by tool_use id, for the error notes.
  private bashCalls = new Map<string, string>();
  private forks = new Set<AbortController>();

  constructor(host: SideHost) {
    this.host = host;
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
    for (const a of this.forks) a.abort();
  }
}
