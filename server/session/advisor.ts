import type { ModelUsage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AdvisorBilling, AdvisorState, AdvisorUsage, ServerEvent } from '../protocol.ts';

type Call = { id: string; since: number; state: AdvisorState; model?: string; error?: string; text?: string; usage?: AdvisorUsage; billing?: AdvisorBilling; weight?: number };
type Iteration = { type?: string; model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Result = { type?: string; error_code?: string; text?: string; stop_reason?: string | null };

// Calls kept for their late usage and cost; older ones are final.
const KEEP = 50;

// The main thread's advisor calls: a server_tool_use block starts one, its advisor_tool_result ends it,
// the message's usage iterations give its tokens and the turn's per-model cost prices them.
export class AdvisorCalls {
  private calls = new Map<string, Call>();
  // Calls waiting for tokens, in call order: a message lists its advisor_message iterations in that order.
  private untallied: string[] = [];
  private unpriced: string[] = [];
  private billing: AdvisorBilling | undefined;
  private push: (e: ServerEvent) => void;
  // Since this process started; the Usage card shows them next to the session's cost.
  readonly totals = { calls: 0, tokens: 0, cost: 0 };

  constructor(push: (e: ServerEvent) => void) {
    this.push = push;
  }

  start(id: string) {
    if (this.calls.has(id)) return;
    this.totals.calls++;
    this.untallied.push(id);
    this.put({ id, since: Date.now(), state: 'consulting' });
  }

  result(id: string, content: unknown) {
    this.start(id);
    const call = this.calls.get(id)!;
    const r = (content ?? {}) as Result;
    if (r.type === 'advisor_tool_result_error') this.put({ ...call, state: 'unavailable', error: r.error_code ?? 'unknown' });
    else this.put({ ...call, state: r.stop_reason === 'refusal' ? 'declined' : 'reviewed', ...(r.type === 'advisor_result' && r.text ? { text: r.text } : {}) });
  }

  usage(iterations: Iteration[]) {
    for (const it of iterations) {
      if (it.type !== 'advisor_message') continue;
      const call = this.calls.get(this.untallied.shift() ?? '');
      if (!call) continue;
      const read = it.cache_read_input_tokens ?? 0;
      const wrote = it.cache_creation_input_tokens ?? 0;
      const input = (it.input_tokens ?? 0) + read + wrote;
      const output = it.output_tokens ?? 0;
      this.totals.tokens += input + output;
      this.unpriced.push(call.id);
      this.put({ ...call, model: it.model, usage: { input, output, costUsd: null }, weight: weightOf(it.input_tokens ?? 0, output, read, wrote) });
    }
  }

  rateLimit(info: SDKRateLimitInfo) {
    this.billing = info.isUsingOverage ? 'credits' : 'plan';
  }

  // modelUsage is cumulative, so its cost per weighted token holds for every call of that model.
  turnEnd(modelUsage: Record<string, ModelUsage> | undefined) {
    for (const id of this.unpriced) {
      const call = this.calls.get(id);
      const mu = call?.model ? modelUsage?.[call.model] : undefined;
      if (!call?.usage || !mu || !call.weight) continue;
      const all = weightOf(mu.inputTokens, mu.outputTokens, mu.cacheReadInputTokens, mu.cacheCreationInputTokens);
      if (all <= 0) continue;
      const costUsd = (mu.costUSD / all) * call.weight;
      this.totals.cost += costUsd;
      this.put({ ...call, usage: { ...call.usage, costUsd } });
    }
    // A call the turn left open was stopped with it.
    for (const id of this.untallied) {
      const call = this.calls.get(id);
      if (call?.state === 'consulting') this.put({ ...call, state: 'unavailable', error: 'stopped' });
    }
    this.unpriced = [];
    this.untallied = [];
  }

  private put(call: Call) {
    const c = { ...call, ...(!call.billing && this.billing ? { billing: this.billing } : {}) };
    this.calls.delete(c.id);
    this.calls.set(c.id, c);
    if (this.calls.size > KEEP) this.calls.delete(this.calls.keys().next().value!);
    const { weight: _w, ...shown } = c;
    this.push({ type: 'advisor', ...shown });
  }
}

// Anthropic list prices: output 5x input, cache reads 0.1x, cache writes 1.25x.
const weightOf = (input: number, output: number, read: number, wrote: number) => input + 5 * output + 0.1 * read + 1.25 * wrote;
