import { deleteThread, startThread, type CodexPolicy, type CodexThread } from '../codex/threads.ts';
import type { ThreadTokenUsage, Turn, UserInput } from '../codex/types.ts';
import { BOARD_DEFAULT, FAST_TIER } from './api.ts';
import { BOARD_CWD, boardCodex, boardModels, boardSignedIn } from './codexServer.ts';
import { generating, type BoardAdapter, type JobInput, type Progress } from './jobs.ts';
import { boardImages, boardInstructions, boardMessage } from './prompt.ts';

// Defaults when a job names no model or effort; env vars override them for a try without an edit.
export const BOARD_CODEX = {
  model: process.env.CW_BOARD_MODEL || BOARD_DEFAULT.model,
  effort: process.env.CW_BOARD_EFFORT || BOARD_DEFAULT.effort,
};

// The model only looks at a picture and answers: no approvals, no writes, no network. Tools and context blocks
// are off in the board app-server's own config.toml (codexServer.ts).
const POLICY: CodexPolicy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
const STEPS = 4;
// Bound on each step of stopping a turn (interrupt, its end, the delete); past it the app-server is recycled.
const STOP_MS = 5_000;
const TIMEOUT = Symbol('timeout');

const cancelled = () => new Error('Cancelled');
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms).unref())]);

// The job's pick when the account offers it, else the board default, else the catalog default; effort clamped to the model.
// Without a catalog nothing is sent: unchecked names from the page never reach Codex.
async function pick(input: JobInput) {
  const models = await boardModels().catch(() => []);
  const id = input.model || BOARD_CODEX.model, want = input.effort || BOARD_CODEX.effort;
  const m = models.find((x) => x.id === id) ?? models.find((x) => x.id === BOARD_CODEX.model) ?? models.find((x) => x.isDefault) ?? models[0];
  if (!m) throw new Error('Could not load the Codex model list; try again');
  const tier = input.fast && m.tiers.includes(FAST_TIER) ? FAST_TIER : '';
  return { model: m.id, effort: m.efforts.includes(want) ? want : m.defaultEffort, tier };
}

type Turning = {
  // The final answer text; rejects on abort, failure or the thread going away.
  answer: Promise<string>;
  // turn/start's own reply, so a cancel that lands before it can still interrupt the turn.
  started: Promise<Turn | null>;
  // Settles once the turn is over or the thread is gone.
  ended: Promise<void>;
};

// One turn. Progress follows it: started, first reasoning, first answer token.
function runTurn(thread: CodexThread, input: JobInput, emit: (p: Progress) => void, signal: AbortSignal, mark: (k: string) => void, usage: { last: ThreadTokenUsage | null }): Turning {
  let over!: () => void;
  const ended = new Promise<void>((r) => (over = r));
  const off = thread.subscribe((e) => {
    if (e.type === 'turn-completed' || e.type === 'closed') {
      over();
      off();
    }
  });
  const fresh = generating(input);
  const items: UserInput[] = [{ type: 'text', text: boardMessage(input), text_elements: [] }, ...boardImages(input).map((path) => ({ type: 'localImage' as const, path }))];
  const started = thread.startTurn(items, { summary: 'none' });
  const answer = new Promise<string>((done, fail) => {
    let text = '', final = '', error: string | null = null, thinking = false, writing = false;
    const stop = (e: Error) => {
      end();
      fail(e);
    };
    const onAbort = () => stop(cancelled());
    const unsub = thread.subscribe((e) => {
      if (e.type === 'turn-started') {
        mark('turn');
        emit({ step: 2, of: STEPS, text: fresh ? 'Reading the request' : 'Reading the sketch' });
      } else if ((e.type === 'reasoning-delta' || (e.type === 'item-started' && e.item.type === 'reasoning')) && !thinking && !writing) {
        thinking = true;
        mark('reasoning');
        emit({ step: 3, of: STEPS, text: fresh ? 'Planning the layout' : 'Working out the shapes' });
      } else if (e.type === 'message-delta' && !writing) {
        writing = true;
        mark('answer');
        emit({ step: 4, of: STEPS, text: 'Writing the elements' });
      } else if (e.type === 'item-completed' && e.item.type === 'agentMessage') {
        text = e.item.text;
        if (e.item.phase === 'final_answer') final = e.item.text;
      } else if (e.type === 'tokens') usage.last = e.usage;
      else if (e.type === 'error' && !e.willRetry) error = e.error.message;
      else if (e.type === 'turn-completed') {
        end();
        const out = final || text;
        if (e.turn.status === 'completed' && out.trim()) done(out);
        else fail(new Error(`Codex gave no answer${e.turn.status !== 'completed' ? ` (turn ${e.turn.status})` : ''}${error || e.turn.error ? `: ${error ?? e.turn.error?.message}` : ''}`));
      } else if (e.type === 'closed') stop(new Error(e.reason));
    });
    function end() {
      signal.removeEventListener('abort', onAbort);
      unsub();
    }
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    started.catch((e: unknown) => stop(e instanceof Error ? e : new Error(String(e))));
  });
  return { answer, started: started.catch(() => null), ended };
}

// Interrupts a turn that may still be starting; true once Codex confirms it over (or it never started).
async function stopTurn(thread: CodexThread, t: Turning) {
  const turn = await within(t.started, STOP_MS);
  if (turn === TIMEOUT) return false;
  if (!turn) return true;
  if ((await within(t.ended, 0)) !== TIMEOUT) return true;
  await thread.interrupt(STOP_MS).catch(() => {});
  return (await within(t.ended, STOP_MS)) !== TIMEOUT;
}

// Persisted threads, because deleting is the only call that unloads one: unsubscribed threads stay loaded for ~30 min,
// and ephemeral ones can be neither deleted nor archived. Delete also removes the rollout under the board's CODEX_HOME.
async function teardown(thread: CodexThread, stopped: boolean) {
  const deleted = stopped && (await within(deleteThread(thread.id, boardCodex).then(() => true, (e: unknown) => {
    console.warn(`[board] could not delete Codex thread ${thread.id}: ${(e as Error).message}`);
    return false;
  }), STOP_MS)) === true;
  // A turn or thread Codex did not confirm gone may still be spending allowance: the slot frees only once its process is.
  if (!deleted) {
    console.warn(`[board] Codex thread ${thread.id} not confirmed stopped; restarting the board app-server`);
    await boardCodex.stop(STOP_MS);
  }
  await thread.close(STOP_MS);
  return deleted;
}

// A Codex thread per job: region PNG plus elements JSON in, elements JSON text out.
export const codexAdapter: BoardAdapter = {
  id: 'codex',
  label: 'Codex',
  capabilities: { elements: true },
  models: boardModels,
  defaults: { model: BOARD_CODEX.model, effort: BOARD_CODEX.effort },
  async submit(input, emit, signal) {
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    const mark = (k: string) => void (marks[k] ??= Date.now() - t0);
    const usage: { last: ThreadTokenUsage | null } = { last: null };
    emit({ step: 1, of: STEPS, text: 'Starting Codex' });
    if (!(await boardCodex.checkBinary()).path) throw new Error('The codex CLI is not installed on this machine');
    if (!(await boardSignedIn())) throw new Error('Codex is not signed in; sign in from Settings > Account');
    const { model, effort, tier } = await pick(input);
    if (signal.aborted) throw cancelled();
    const thread = await startThread({
      client: boardCodex, cwd: BOARD_CWD, mode: 'default', policy: POLICY, ephemeral: false, model, effort, baseInstructions: boardInstructions(input.schema),
      ...(tier && { serviceTier: tier }),
    });
    mark('thread');
    let outcome = 'done';
    let turn: Turning | null = null;
    try {
      if (signal.aborted) throw cancelled();
      turn = runTurn(thread, input, emit, signal, mark, usage);
      return { json: await turn.answer };
    } catch (e) {
      outcome = signal.aborted ? 'cancelled' : `failed (${e instanceof Error ? e.message : String(e)})`;
      throw e;
    } finally {
      const stopped = turn ? await stopTurn(thread, turn) : true;
      if (!(await teardown(thread, stopped))) outcome += ', app-server restarted';
      const u = usage.last?.total;
      const at = ['thread', 'turn', 'reasoning', 'answer'].filter((k) => k in marks).map((k) => `${k} ${marks[k]}`).join(' · ');
      const tok = u ? ` · in ${u.inputTokens} (cached ${u.cachedInputTokens}) out ${u.outputTokens} (reasoning ${u.reasoningOutputTokens}) tok` : '';
      console.log(`[board] codex ${model}/${effort}${tier ? `/${tier}` : ''} ${generating(input) ? 'generate' : 'refine'} ${input.target.w}x${input.target.h} ${input.elements.elements.length} els, context ${input.context.length}${input.overview ? `, overview ${input.overview.w}x${input.overview.h}` : ''}: ${at} · ${outcome} ${Date.now() - t0} ms${tok}`);
    }
  },
};
