import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Mode, ServerEvent } from '../protocol.ts';
import { summarizeFor, verbOf } from '../tools.ts';
import { oneLine } from '../text.ts';
import { after, before } from './gate.ts';
import { GUEST_API, runScript } from './sandbox.ts';
import { basename } from 'node:path';
import { execute, normalize, SHELL } from './tools.ts';
import type { GateContext, InnerCall, InnerData, InnerTool, RunLimits } from './types.ts';
import { INNER_TOOLS } from './types.ts';

export const CODE_TOOL_NAME = 'code';

// Fixed for the process, so the tool schema stays the same on every request.
const PLATFORM = (() => {
  if (!SHELL) return '$ is unavailable here (no Git Bash found), so every $ call fails; use read(), grep() and glob(), and the Bash tool for commands.';
  const shell = basename(SHELL).replace(/\.exe$/i, '');
  const os = process.platform === 'darwin' ? 'macOS, BSD tools (stat -f %z, sed -i \'\', date -r; no GNU-only flags)'
    : process.platform === 'win32' ? 'Windows through Git Bash (GNU tools, paths like /c/Users; no PowerShell or cmd)'
    : 'Linux, GNU tools';
  return `$ runs in ${shell} on ${os}.${shell === 'zsh' ? ' In zsh an unmatched glob is an error, so quote globs or use find.' : ''}`;
})();

export const CODE_DESCRIPTION = `Run a JavaScript program that calls shell, file and search tools, and get back only what it returns.
Use it instead of one tool call per step: chain commands, read several files, search and filter in one call, run independent calls with Promise.all, and return just the facts you need.
Each call inside the program goes through the user's hooks and permission rules like a normal tool call and may show the user a permission card; a denied or failed call throws, so catch it when the rest can go on.
The program is the body of an async function: use await and return. There is no require, import, fs, network or timers, and nothing persists between runs.
Limits: 30 s of the program's own CPU time, 10 min overall (permission waits included), 30k chars of returned value and logs together, 200 calls per program with 8 running at once.
Every call is a round trip and a row the user sees: do per-file or per-item work in one command (find … -exec cmd {} +, one git or rg call) or one grep()/glob(), never a loop of $ calls.
read() sees a file's first 5 MB, returns at most 2000 lines and cuts longer lines at 2000 chars, and a command keeps 30k chars of output; a cut adds a note to Logs. Filter big files in the shell (grep, head, jq) instead of parsing them whole.
${PLATFORM}
Grep and Glob are off. In Bypass mode, Bash only runs background processes (run_in_background), so shell work goes here. In other modes, a shell command that would need the user's approval is refused inside the program with a message; run those with Bash, and use this tool to batch reads, searches and commands that need no approval. Edit files with Edit and Write, never from the shell (no sed -i, redirects or heredocs into files). Read images and PDFs with Read.

API:
${GUEST_API}`;

export type CodeArgs = { code: string; description?: string; timeout?: number };
export type CodeReply = { text: string; isError: boolean };
export type CodeBroker = (args: CodeArgs, callId: string | undefined, signal: AbortSignal | undefined) => Promise<CodeReply>;

export type CodeHost = {
  cwd: () => string;
  mode: () => Mode;
  hookRewrites: () => boolean;
  sessionId: () => string;
  transcriptPath: () => Promise<string>;
  push: (e: ServerEvent) => void;
  askTool: (tool: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]) => Promise<PermissionResult>;
};

const CPU_MS = 30_000;
const WALL_MS = 600_000;
const MEMORY = 256 * 1024 * 1024;
const OUTPUT_CHARS = 30_000;
// A runaway loop of calls would flood the conversation with rows and permission cards.
const CALLS_MAX = 200;

const isInner = (t: string): t is InnerTool => (INNER_TOOLS as string[]).includes(t);

function failure(tool: InnerTool, data: InnerData) {
  if ('stderr' in data) return data.stderr || `${tool} failed`;
  if ('output' in data) return data.output || `${tool} failed`;
  if ('text' in data) return data.text || `${tool} failed`;
  if ('files' in data) return data.files[0] || `${tool} failed`;
  return `${tool} failed`;
}

// One mcp__app__code call: the program runs in the sandbox; each inner call is gated, run and shown as its own row.
export function codeBroker(host: CodeHost): CodeBroker {
  return async ({ code, timeout }, callId, outer) => {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    if (outer?.aborted) return { text: 'The program was stopped before it started.', isError: true };
    outer?.addEventListener('abort', stop, { once: true });
    const base = callId ?? `code-${Date.now().toString(36)}`;
    const notes: string[] = [];
    let n = 0;
    const transcript = await host.transcriptPath();
    // Open cards, so a run that times out says it was waiting on the user, not on the program.
    const waiting = new Map<string, string>();
    const ctx: GateContext = {
      cwd: host.cwd(), mode: host.mode(), sessionId: host.sessionId(), transcriptPath: transcript, signal: ctl.signal, hookRewrites: host.hookRewrites(),
      ask: async (call, why) => {
        // Outside Bypass, a shell command that needs approval goes to Bash, where the CLI's own checks decide.
        const mode = host.mode();
        if (call.tool === 'Bash' && mode !== 'bypassPermissions') {
          return { allow: false, message: `In ${mode} mode this command needs approval; run it with the Bash tool instead of inside the code tool.` };
        }
        waiting.set(call.id, `${call.tool} ${summarizeFor(ctx.cwd, call.tool, call.input)}`);
        try {
          const r = await host.askTool(call.tool, call.input, { signal: ctl.signal, toolUseID: call.id, title: why ? `Code · ${why}` : 'Code' } as Parameters<CanUseTool>[2]);
          return r.behavior === 'allow' ? { allow: true, input: (r.updatedInput as Record<string, unknown> | undefined) ?? call.input } : { allow: false, message: r.message };
        } finally {
          waiting.delete(call.id);
        }
      },
    };
    const call = async (tool: InnerTool, args: Record<string, unknown>): Promise<InnerData> => {
      if (!isInner(tool)) throw new Error(`Unknown tool ${String(tool)}`);
      if (++n > CALLS_MAX) {
        throw new Error(`A program may make at most ${CALLS_MAX} tool calls, so it stopped and returned nothing. Do per-item work in one command (find … -exec cmd {} +, xargs) or one grep()/glob() call.`);
      }
      const first = normalize({ id: `${base}:${n}`, tool, input: args }, ctx.cwd);
      const row = (c: InnerCall) => ({ type: 'tool' as const, id: c.id, name: c.tool, verb: verbOf(c.tool), summary: summarizeFor(ctx.cwd, c.tool, c.input), parent: base });
      // The row waits for the decision so it shows the input that runs (a hook may rewrite it); a card holds its place meanwhile.
      // A mode switch during the decision decides again under the new mode.
      let decision;
      for (let tries = 0; ; tries++) {
        const mode = host.mode();
        decision = await before(first, { ...ctx, mode });
        if (host.mode() === mode || tries >= 2) break;
      }
      if (ctl.signal.aborted) throw new Error('The program was stopped.');
      notes.push(...decision.context);
      if (!decision.allow) {
        host.push(row(first));
        host.push({ type: 'tool-result', id: first.id, error: oneLine(decision.message, 300), parent: base });
        throw new Error(decision.message);
      }
      const ran = normalize({ ...first, input: decision.input }, ctx.cwd);
      host.push(row(ran));
      const out = await execute(ran, ctx.cwd, ctl.signal);
      const post = await after(ran, ran.input, out, ctx);
      notes.push(...post.context);
      // A plain non-zero exit goes back as data, so the guest's $ decides (it throws unless .nothrow()).
      const exited = 'exitCode' in out.data && out.data.exitCode > 0 && !out.data.interrupted;
      const why = exited && 'exitCode' in out.data ? `exit ${out.data.exitCode}${out.data.stderr ? `: ${out.data.stderr}` : ''}` : out.isError ? failure(tool, out.data) : null;
      if (ctl.signal.aborted) {
        host.push({ type: 'tool-result', id: ran.id, error: 'Stopped', parent: base });
        throw new Error('The program was stopped.');
      }
      host.push({ type: 'tool-result', id: ran.id, error: why ? oneLine(why, 300) : null, parent: base });
      if (out.isError && !exited) throw new Error(failure(tool, out.data));
      return out.data;
    };
    const limits: RunLimits = { cpuMs: CPU_MS, wallMs: Math.min(timeout ?? WALL_MS, WALL_MS), memoryBytes: MEMORY, maxOutputChars: OUTPUT_CHARS };
    try {
      const r = await runScript(code, call, limits, ctl.signal);
      const open = [...waiting.values()];
      const stuck = !r.ok && open.length ? `\nIt was still waiting for the user's permission on: ${open.join('; ')}. The user may not have seen the card; say so instead of retrying the same call.` : '';
      const parts = [r.ok ? `Result:\n${r.value || '(no value returned)'}` : `Error: ${r.error}${stuck}`];
      if (r.logs.length) parts.push(`Logs:\n${r.logs.join('\n')}`);
      if (notes.length) parts.push(`Hook notes:\n${[...new Set(notes)].join('\n')}`);
      if (r.truncated) parts.push(`(Output cut at ${OUTPUT_CHARS} chars; return less.)`);
      return { text: parts.join('\n\n'), isError: !r.ok };
    } finally {
      outer?.removeEventListener('abort', stop);
      ctl.abort();
    }
  };
}
