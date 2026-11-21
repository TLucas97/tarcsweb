import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { query, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { config, t } from './config.ts';
import { codexAccount } from './codex/account.ts';
import { answerWithoutTools, cachedHelperModel } from './codex/helper.ts';
import { CLAIMS_MODEL, claimAgent, type ClaimAgent, type ClaimChecker, type ClaimClosingVerdict, type ClaimVerdict } from './protocol.ts';

const SECRET_PATHS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker/config.json', '.config/gcloud', '.netrc', '.git-credentials'];
const SECRET_NAME = /credential|secret|password|token|id_rsa|id_ed25519|(?:\.pem|\.key)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)/i;
const READ_ONLY = `Only read local evidence relevant to the claims. You may read outside the project when relevant, such as Claude memories, decisions.md or CLAUDE.md. Never change files or use the network. Never read ${SECRET_PATHS.map((p) => `~/${p}`).join(', ')}, any .env or .env.* file, or paths matching /credential|secret|password|token|id_rsa|id_ed25519|\\.pem$|\\.key$/i, including symlink targets. Do not run broad content searches that could read those paths.`;

const VERIFY = `Check only the numbered claims from the selected reply. You also get the reply and the tool calls from its turn.

For each claim, read the relevant files or git history before judging, then pick one verdict:
- confirmed: the evidence supports the whole claim. Name it as path:line or the git command and what it showed.
- partial: the evidence supports part of the claim, while another part is wrong or lacks support. Say which parts, with evidence.
- wrong: the evidence says otherwise. Say what is true, with path:line.
- external: it depends on evidence unavailable locally, such as a web page, cloud account or remote server. Say what would prove it.
- unclear: you looked and could not settle it. Say where you looked.
Also say in the note whether the assistant's own tool calls show it checked the claim.

${READ_ONLY}

Answer with only a JSON array, no prose and no code fence: [{"claim": 1, "verdict": "confirmed", "note": "..."}], one object per claim. Each note has at most 40 words.`;

const CLOSE = `You close a round of claim checks. You get the numbered original claims sent for correction, the checkers' previous verdicts and notes, the assistant's reply to the corrections, and its tool calls in that turn.

Judge only those original claims. Do not raise or judge any new claims. Re-read the relevant files or git history if needed to decide:
- resolved: the assistant corrected the claim accurately or showed evidence that settles it.
- open: the assistant did not settle the claim or the evidence is insufficient.
Cite path:line in your note when you rely on code.

${READ_ONLY}

Answer with only a JSON array, no prose and no code fence: [{"claim": 1, "verdict": "resolved", "note": "..."}], exactly one object per original claim. Each note has at most 40 words.`;

const LANGUAGE = () => t({
  en: '\n\nWrite every note in plain English, with everyday words.',
  'pt-BR': '\n\nWrite every note in simple Brazilian Portuguese, with everyday words. Keep paths, code and commands as they are. Never mix languages.',
});

const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 30;
const HOME_SECRETS = SECRET_PATHS.map((p) => resolve(homedir(), p));
const SYSTEM_PATHS = ['/dev', '/proc', '/sys'];
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 12;
const MAX_FILE_CHARS = 40_000;
const MAX_EVIDENCE_CHARS = 160_000;
const MAX_CANDIDATES = 80;
const NO_TOOLS = `\n\nThis overrides the reading rules above: you have no tools. The app already read the files named in the claims, reply and tool calls, with the same secret rules, and they follow the prompt under "Files read by the app". Judge only from that text and the tool results. If the evidence you need is not there, such as git history or a file that was not read, answer unclear (or open) and say what is missing.`;

// Git commands that return file contents must name one literal, approved path.
async function safeGit(input: unknown, approveFile: (path: string) => Promise<string | null>) {
  if (typeof input !== 'string') return null;
  const command = input.trim();
  if (!/^git [a-z0-9_./:^~ -]+$/i.test(command)) return null;
  const [, sub, ...args] = command.split(/ +/);
  const rest = args.join(' ');
  const metadata = (sub === 'log' && /^(?:(?:--oneline ?)?(?:-\d{1,3})?)$/.test(rest))
    || (sub === 'ls-files' && !rest) || (sub === 'status' && /^(?:--short|--porcelain|-s)?$/.test(rest));
  const read = sub === 'show' ? /^([\w][\w./^~-]*):([\w./-]+)$/.exec(rest)
    : sub === 'diff' ? /^((?:--cached )?)-- ([\w./-]+)$/.exec(rest)
    : sub === 'blame' ? /^()-- ([\w./-]+)$/.exec(rest)
    : sub === 'grep' ? /^([\w.][\w.-]*) -- ([\w./-]+)$/.exec(rest) : null;
  const path = read?.[2];
  if (!metadata && (!path || isAbsolute(path) || path.split('/').includes('..') || !await approveFile(path))) return null;
  // A file today could be a directory in the Git index.
  const scoped = read && path && (sub === 'diff' || sub === 'grep')
    ? `${read[1].trim()} -- ':(literal)${path}' ':(exclude,glob)${path}/**'`.trim() : rest;
  const options = sub === 'diff' || sub === 'show' || sub === 'log' ? '--no-ext-diff --no-textconv' : '';
  return `GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 git --no-pager -c core.fsmonitor=false ${sub} ${options} ${scoped}`.trim();
}

const isBlocked = (denied: string[], path: string) => SECRET_NAME.test(path.replaceAll('\\', '/')) || denied.some((p) => path === p || path.startsWith(p + sep));

// The real path of an allowed file or folder, or null when it is missing or a secret.
async function allowedPath(cwd: string, denied: string[], path: unknown, directory = false) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null;
  const candidate = resolve(cwd, path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
  if (isBlocked(denied, candidate)) return null;
  try {
    const full = await realpath(candidate);
    if (isBlocked(denied, full)) return null;
    const info = await stat(full);
    return (directory ? info.isDirectory() : info.isFile()) ? full : null;
  } catch {
    return null;
  }
}

async function deniedPaths() {
  const real = await Promise.all(HOME_SECRETS.map((p) => realpath(p).catch(() => p)));
  return { sandbox: [...HOME_SECRETS, ...real], hook: [...HOME_SECRETS, ...real, ...SYSTEM_PATHS] };
}

function readOnly(cwd: string, denied: string[]): HookCallback {
  const blocked = (path: string) => isBlocked(denied, path);
  const safePath = (path: unknown, directory = false) => allowedPath(cwd, denied, path, directory);
  return async (input) => {
    const { tool_name: tool, tool_input } = input as PreToolUseHookInput;
    const args = (tool_input ?? {}) as Record<string, unknown>;
    const command = tool === 'Bash' && args.dangerouslyDisableSandbox !== true ? await safeGit(args.command, safePath) : null;
    const file = tool === 'Read' ? await safePath(args.file_path) : tool === 'Grep' ? await safePath(args.path) : null;
    const folder = tool === 'Glob' && typeof args.pattern === 'string' && !isAbsolute(args.pattern)
      && !args.pattern.includes('..') && !args.pattern.includes('\\') && !blocked(args.pattern)
      ? await safePath(args.path ?? '.', true) : null;
    const updatedInput = command ? { ...args, command }
      : file ? { ...args, [tool === 'Read' ? 'file_path' : 'path']: file }
      : folder ? { ...args, path: folder } : undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: updatedInput ? 'allow' : 'deny', updatedInput,
        ...(updatedInput ? {} : { permissionDecisionReason: 'Read-only check: secret paths are blocked. Use Read or Grep on a specific file, Glob to find paths, or read-only git. For git diff, blame and grep, pass one literal file after --. For git show, use revision:path.' }),
      },
    };
  };
}

async function claude(prompt: string, system: string, cwd: string, signal: AbortSignal, model: string) {
  const denied = await deniedPaths();
  signal.throwIfAborted();
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  try {
    const q = query({
      prompt,
      options: {
        model, systemPrompt: system, cwd, env, abortController, maxTurns: MAX_TURNS, settingSources: [], persistSession: false,
        tools: ['Read', 'Grep', 'Glob', 'Bash'], skills: [], strictMcpConfig: true, mcpServers: {}, permissionMode: 'default',
        settings: { autoMemoryEnabled: false, sandbox: {
          enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
          network: { allowedDomains: [], allowManagedDomainsOnly: true },
          filesystem: { denyRead: denied.sandbox, denyWrite: ['/'] },
        } },
        hooks: { PreToolUse: [{ hooks: [readOnly(cwd, denied.hook)] }] },
        canUseTool: async () => ({ behavior: 'deny', message: 'Read-only check.' }),
      },
    });
    for await (const m of q) {
      if (m.type === 'result') return m.subtype === 'success' && !m.is_error ? m.result : null;
    }
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

function parse<V extends string>(text: string | null, count: number, kinds: readonly V[]) {
  const start = text?.indexOf('[') ?? -1;
  const end = text?.lastIndexOf(']') ?? -1;
  if (!text || start < 0 || end <= start) throw new Error('The checker gave no verdicts');
  const arr: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('The checker gave no verdicts');
  return arr.flatMap((v): { claim: number; verdict: V; note: string }[] => {
    const o = v as Record<string, unknown>;
    return Number.isInteger(o?.claim) && (o.claim as number) >= 1 && (o.claim as number) <= count && kinds.includes(o.verdict as V) && typeof o.note === 'string'
      ? [{ claim: o.claim as number, verdict: o.verdict as V, note: o.note.slice(0, 400) }] : [];
  });
}

export function configuredClaimCheckers(): ClaimChecker[] {
  if (config.claimCheckers) return config.claimCheckers;
  const model = codexAccount.status?.signedIn ? cachedHelperModel() : undefined;
  return [{ provider: 'claude', model: CLAIMS_MODEL }, ...(model ? [{ provider: 'codex' as const, model }] : [])];
}

export async function loadClaimCheckers() {
  if (!config.claimCheckers) {
    const status = codexAccount.status ?? await codexAccount.check().catch(() => null);
    if (status?.signedIn && !codexAccount.cachedModels) await codexAccount.models().catch(() => null);
  }
  return configuredClaimCheckers();
}

const PATH_TOKENS = [
  /"(?:file_path|path|notebook_path)":"((?:[^"\\]|\\.)+)"/g,
  /`([^`\n]{1,300})`/g,
  /((?:~|\.{1,2})?\/?[\p{L}\p{N}_@+.-]+(?:\/[\p{L}\p{N}_@+.-]+)+|[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[a-z][a-z0-9]{0,7}\b)/giu,
];

// The files named in the texts, read by the server under the same secret rules as the Claude checker, with line numbers.
async function readEvidence(sources: string[], cwd: string) {
  // Path → the line numbers cited with it (path:12 or path:12-30).
  const candidates = new Map<string, number[]>();
  for (const text of sources) for (const re of PATH_TOKENS) for (const m of text.matchAll(re)) {
    const raw = m[1].replace(/\\(.)/g, '$1').trim().replace(/[.,;)]+$/, '');
    const at = /:(\d+)(?:[-:]\d+)*$/.exec(raw);
    const path = at ? raw.slice(0, at.index) : raw;
    candidates.set(path, [...candidates.get(path) ?? [], ...at ? [Number(at[1])] : []]);
  }
  const { hook } = await deniedPaths();
  const cited = new Map<string, number[]>();
  for (const [path, lines] of [...candidates].slice(0, MAX_CANDIDATES)) {
    const full = await allowedPath(cwd, hook, path);
    if (full) cited.set(full, [...cited.get(full) ?? [], ...lines]);
  }
  const files: string[] = [];
  let total = 0;
  for (const [full, lines] of cited) {
    if (files.length >= MAX_FILES || total >= MAX_EVIDENCE_CHARS) break;
    if (((await stat(full).catch(() => null))?.size ?? Infinity) > MAX_FILE_BYTES) continue;
    const text = await readFile(full, 'utf8').catch(() => null);
    if (text === null || text.includes('\0')) continue;
    const body = excerpt(text.split('\n'), lines, Math.min(MAX_FILE_CHARS, MAX_EVIDENCE_CHARS - total));
    const shown = relative(cwd, full);
    const name = shown.startsWith('..') || isAbsolute(shown) ? full : shown;
    files.push(`--- ${name}${body.cut ? ' (cut)' : ''} ---\n${body.text}`);
    total += body.text.length;
  }
  return files.length ? files.join('\n\n') : '(none)';
}

const AROUND = 60;

// Numbered lines within budget: the whole file when it fits, else the cited lines' surroundings first, then the head.
function excerpt(all: string[], cited: number[], budget: number) {
  const line = (i: number) => `${i + 1}: ${all[i]}`;
  const whole = all.map((_, i) => line(i)).join('\n');
  if (whole.length <= budget) return { text: whole, cut: false };
  const keep = new Set<number>();
  let used = 0;
  const take = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(all.length, to); i++) {
      if (keep.has(i)) continue;
      const cost = line(i).length + 1;
      if (used + cost > budget) return;
      keep.add(i);
      used += cost;
    }
  };
  for (const n of [...new Set(cited)].sort((a, b) => a - b)) take(n - 1 - AROUND, n - 1 + AROUND);
  take(0, all.length);
  const out: string[] = [];
  [...keep].sort((a, b) => a - b).forEach((i, k, arr) => {
    if (k > 0 && arr[k - 1] !== i - 1) out.push('…');
    out.push(line(i));
  });
  return { text: out.join('\n'), cut: true };
}

async function runChecker(checker: ClaimChecker, prompt: string, instructions: string, sources: string[], cwd: string, signal: AbortSignal) {
  const { provider, model } = checker;
  if (provider === 'opencode') throw new Error('OpenCode checkers are not supported yet');
  const system = instructions + LANGUAGE();
  // Codex gets no shell: its sandbox cannot block secret paths, so the server reads the files for it.
  const text = provider === 'claude' ? await claude(prompt, system, cwd, signal, model)
    : await answerWithoutTools(`${prompt}\n\nFiles read by the app:\n${await readEvidence(sources, cwd)}`, system + NO_TOOLS,
      AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), model);
  if (signal.aborted) throw new Error('Stopped');
  return text;
}

// One checker's verdicts on the flagged claims, read from the project in cwd.
export async function verifyClaims(checker: ClaimChecker, claims: string[], reply: string, tools: string[], cwd: string, signal: AbortSignal): Promise<ClaimVerdict[]> {
  const prompt = [
    `Claims to check:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `The assistant's reply:\n${reply.slice(-8000)}`,
    `The assistant's tool calls:\n${tools.length ? tools.join('\n') : '(none)'}`,
  ].join('\n\n');
  const started = Date.now();
  const text = await runChecker(checker, prompt, VERIFY, [...claims, reply.slice(-8000), ...tools], cwd, signal);
  const verdicts = parse(text, claims.length, ['confirmed', 'partial', 'wrong', 'external', 'unclear']);
  if (verdicts.length !== claims.length || new Set(verdicts.map((v) => v.claim)).size !== claims.length) {
    throw new Error('The checker did not give one verdict per claim');
  }
  console.error(`claim verify (${claimAgent(checker)}): ${verdicts.length} verdict(s) in ${Date.now() - started} ms`);
  return verdicts;
}

export type ClaimRoundItem = { text: string; verdicts: (Omit<ClaimVerdict, 'claim'> & { agent: ClaimAgent })[] };

export async function closeClaims(checker: ClaimChecker, items: ClaimRoundItem[], reply: string, tools: string[], cwd: string, signal: AbortSignal): Promise<ClaimClosingVerdict[]> {
  const prompt = [
    `Original claims with previous verdicts and notes:\n${JSON.stringify(items.map((item, i) => ({ claim: i + 1, ...item })))}`,
    `The assistant's reply to the corrections:\n${reply}`,
    `The assistant's tool calls in that turn:\n${tools.length ? tools.join('\n') : '(none)'}`,
  ].join('\n\n');
  const text = await runChecker(checker, prompt, CLOSE, [...items.map((item) => item.text), reply, ...tools], cwd, signal);
  const verdicts = parse(text, items.length, ['resolved', 'open']);
  if (verdicts.length !== items.length || new Set(verdicts.map((v) => v.claim)).size !== items.length) {
    throw new Error('The checker did not give one verdict per claim');
  }
  return verdicts;
}
