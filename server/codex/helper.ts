import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { browserOf } from '../mcp.ts';
import { CODEX_MODEL, type CodexModel } from '../protocol.ts';
import { codexAccount } from './account.ts';
import { startThread, type CodexPolicy, type CodexThread } from './threads.ts';

// The Codex side of titles.ts `ask`: one ephemeral thread, one turn, text only.

// What a helper call can be cancelled with: the SDK's Query or a Codex call.
export type Asking = { close(): void };

const POLICY: CodexPolicy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
// An empty folder as cwd, so no project config or AGENTS.md comes along.
const SCRATCH = resolve(CACHE_DIR, 'codex-helper');
// Replaces Codex's long agent prompt; the caller's system prompt goes in as developer instructions.
const BASE = 'You are a small text helper inside a coding app. Answer the request in one reply, with text only. You have no tools.';
// Every tool and integration off, so the turn can only write text. Board jobs reuse it.
export const TEXT_ONLY_CONFIG = {
  web_search: 'disabled',
  'tools.update_plan.enabled': false,
  ...Object.fromEntries([
    'shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'image_generation', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use',
    'in_app_browser', 'goals', 'hooks', 'skill_search', 'sleep_tool', 'tool_suggest', 'memories',
  ].map((f) => [`features.${f}`, false])),
};
const CODEX_CONFIG = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const MCP_TABLE = /^\[mcp_servers\.(?:"([^"]+)"|([\w-]+))\]/gm;

// The user's own MCP servers, switched off so a helper call never starts them.
export async function mcpOff() {
  const toml = await readFile(CODEX_CONFIG, 'utf8').catch(() => '');
  return Object.fromEntries([...toml.matchAll(MCP_TABLE)].map((m) => [`mcp_servers.${m[1] ?? m[2]}.enabled`, false]));
}

const TOML_STRING = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g;
const stringsIn = (text = '') => [...text.matchAll(TOML_STRING)].map((s) => s[1] ?? s[2]);

// The user's servers that run Playwright's or Chrome DevTools' MCP package, switched off so they open no Chrome window of
// their own; the session's tool config brings the panel's packs instead. Only the command and args keys of a
// [mcp_servers.<name>] table are read: inline tables, dotted keys and url servers stay on, whatever they run.
export async function browserMcpOff() {
  const toml = await readFile(CODEX_CONFIG, 'utf8').catch(() => '');
  return Object.fromEntries([...toml.matchAll(MCP_TABLE)].flatMap((m) => {
    const rest = toml.slice(m.index! + m[0].length);
    const end = rest.search(/^\s*\[/m);
    const body = end < 0 ? rest : rest.slice(0, end);
    const command = stringsIn(/^\s*command\s*=\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*')/m.exec(body)?.[1])[0];
    const args = stringsIn(/^\s*args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1]);
    return browserOf({ command, args }) ? [[`mcp_servers.${m[1] ?? m[2]}.enabled`, false]] : [];
  }));
}

// Words Codex's catalog uses for its cheaper models; the catalog lists newest first.
const SMALL = /\b(mini|nano|small|lite|light|cheap|affordable|efficient)\b/i;

let picked: { from: CodexModel[]; model: string | null; effort: string } | null = null;

// The cheapest-sounding model, else the catalog default; kept until the catalog changes (a sign-in drops it).
async function helperModel() {
  const list = await codexAccount.models().catch(() => null);
  if (list && picked?.from === list) return picked;
  const usable = (list ?? []).filter((m) => CODEX_MODEL.test(m.id));
  const m = usable.find((x) => SMALL.test(`${x.name} ${x.description}`)) ?? usable.find((x) => x.isDefault) ?? usable[0];
  const pick = { from: list ?? [], model: m?.id ?? null, effort: !m || m.efforts.includes('low') ? 'low' : m.efforts[0] };
  if (list) {
    picked = pick;
    console.log(`[codex] helper model: ${pick.model ?? 'Codex default'} (${pick.effort})`);
  }
  return pick;
}

// The turn's last message; rejects when stopped, timed out or the thread goes away.
function reply(thread: CodexThread, prompt: string, signal: AbortSignal) {
  return new Promise<string | null>((done, fail) => {
    let said: string | null = null;
    const stop = () => {
      end();
      void thread.interrupt().catch(() => {});
      fail(new Error('The Codex helper call was stopped'));
    };
    const unsub = thread.subscribe((e) => {
      if (e.type === 'item-completed' && e.item.type === 'agentMessage') said = e.item.text;
      else if (e.type === 'turn-completed') {
        end();
        done(e.turn.status === 'completed' ? said : null);
      } else if (e.type === 'closed') {
        end();
        fail(new Error(e.reason));
      }
    });
    function end() {
      signal.removeEventListener('abort', stop);
      unsub();
    }
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    thread.startTurn(prompt).catch((e: unknown) => {
      end();
      fail(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

// null when Codex is missing or signed out; track gets a handle that cancels the call.
export async function askCodex(prompt: string, track: (a: Asking | null) => void, system: string, timeoutMs: number): Promise<string | null> {
  const status = codexAccount.status ?? (await codexAccount.check().catch(() => null));
  if (!status?.signedIn) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  track({ close: () => ctl.abort() });
  let thread: CodexThread | null = null;
  try {
    const { model, effort } = await helperModel();
    await mkdir(SCRATCH, { recursive: true });
    if (ctl.signal.aborted) return null;
    thread = await startThread({
      cwd: SCRATCH, mode: 'default', policy: POLICY, ephemeral: true, model: model ?? undefined, effort, baseInstructions: BASE, developerInstructions: system, config: { ...TEXT_ONLY_CONFIG, ...(await mcpOff()) },
    });
    return await reply(thread, prompt, ctl.signal);
  } finally {
    clearTimeout(timer);
    track(null);
    await thread?.close();
  }
}
