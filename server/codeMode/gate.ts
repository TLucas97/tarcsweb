import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readOnlyPaths } from './readOnly.ts';
import { inside, object, settingsFor } from './settingsFiles.ts';
import type { Hook, HookEvent, Rule, Settings } from './settingsFiles.ts';
import { approveRead, failure, normalize, readTarget, resolveToolPath, runProcess, SHELL } from './tools.ts';
import type { Decision, GateContext, InnerCall, ToolOutput } from './types.ts';

type Kind = 'allow' | 'deny' | 'ask';
type Match = 'yes' | 'no' | 'unknown' | 'exclude';
type Shell = { commands: string[]; complex: boolean };
type Target = { paths: string[]; directory: boolean; unresolved: boolean };
type Facts = { shell?: Shell; target?: Target; bashPaths: Target[]; uncertainBashPaths: boolean };
type HookResult = {
  decision?: 'allow' | 'deny' | 'ask' | 'defer';
  reason?: string;
  input?: Record<string, unknown>;
  context?: string;
  replacement?: { data: unknown };
  withhold?: boolean;
};

const CANCELLED = 'Tool call interrupted.';
// One fixed line, so a program's many rewritten commands add a single note.
const REWRITE_NOTE = 'A PreToolUse hook replaced some $ commands before they ran (see the rows the user sees), so their output may not be in the plain command\'s format. When exact output matters, use read(), grep() or glob(), or check the output before parsing it.';
const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function wildcard(pattern: string, value: string) {
  return new RegExp('^' + pattern.split('*').map(escapeRegex).join('[\\s\\S]*') + '$').test(value);
}

function splitShell(source: string, depth = 0): Shell {
  if (depth > 8) return { commands: [], complex: true };
  const commands: string[] = [];
  let quote = '';
  let chunk = '';
  let complex = false;
  let expectsCommand = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '\\' && quote !== "'") {
      complex = true;
      chunk += char + (next ?? '');
      index++;
    } else if (char === quote) {
      quote = '';
      chunk += char;
    } else if (quote !== "'" && (char === '$' || char.charCodeAt(0) === 96 || (!quote && /[(){}<>#]/.test(char)))) {
      complex = true;
      chunk += char;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      chunk += char;
    } else if (!quote && /[;&|\n]/.test(char)) {
      if (chunk.trim()) {
        commands.push(chunk.trim());
        expectsCommand = false;
      } else if (char !== '\n') {
        complex = true;
      }
      chunk = '';
      const paired = (char === '|' && (next === '|' || next === '&')) || (char === '&' && next === '&');
      if (paired) index++;
      if (paired || char === '|') expectsCommand = true;
      if (char === '&' && !paired) complex = true;
    } else {
      if (!quote && /[*?[\]]/.test(char)) complex = true;
      chunk += char;
    }
  }
  if (chunk.trim()) commands.push(chunk.trim());
  else if (expectsCommand) complex = true;
  if (quote || commands.length === 0) complex = true;
  if (complex) {
    // Nested commands are only candidates for restrictive rule matching.
    for (const match of source.matchAll(/\$\(([^()]*)\)|\(([^()]*)\)|\x60([^\x60]*?)\x60/g)) {
      commands.push(...splitShell(match[1] ?? match[2] ?? match[3], depth + 1).commands);
    }
  }
  if (commands.some((command) => /^(?:if|then|elif|else|for|while|until|do|case|function)\s/.test(command))) complex = true;
  return { commands, complex };
}

function shellVariants(command: string, kind: Kind) {
  const variants = [command];
  const assignments = kind === 'allow'
    ? /^(?:(?:LANG|LC_ALL|NODE_ENV|CI|TZ|TERM)=[\w./-]+\s+)+/
    : /^(?:[A-Za-z_]\w*=(?:[^ \t'"]|"[^"]*"|'[^']*')*\s+)+/;
  const wrappers = /^(?:(?:command|builtin|noglob|nohup|xargs)\s+(?!-)|time\s+(?:-p\s+)?|timeout\s+(?:--(?:foreground|preserve-status)\s+)*\d+(?:\.\d+)?[smhd]?\s+|nice\s+(?:-n\s+[+-]?\d+\s+)?(?!-)|stdbuf\s+(?:-[ioe]\S+\s+)+)/;
  for (let count = 0; count < 12; count++) {
    const stripped = command.replace(assignments, '').replace(wrappers, '').trimStart();
    if (!stripped || stripped === command) break;
    variants.push(stripped);
    command = stripped;
  }
  return variants;
}

function bashMatch(pattern: string, command: string, kind: Kind) {
  const normalized = pattern.replace(/:\*$/, ' *');
  if (kind === 'allow' && normalized.includes('*') && mentionsFind(command)) return false;
  return shellVariants(command, kind).some((variant) => {
    if (kind === 'allow' && normalized.includes('*')) {
      if (/^(?:watch|setsid|ionice|flock)(?:\s|$)/.test(variant)) return false;
    }
    return wildcard(normalized, variant) || (normalized.endsWith(' *') &&
      normalized.indexOf('*') === normalized.length - 1 && normalized.slice(0, -2) === variant);
  });
}

function mentionsFind(command: string): boolean {
  // Include quoted words and wrapper arguments whose command position is uncertain.
  return command.replace(/['"]/g, '').split(/\s+/).some((word) => basename(word) === 'find');
}

async function canonical(path: string, rejectDanglingLink = false): Promise<string | undefined> {
  let parent = path;
  while (true) {
    try {
      return resolve(await realpath(parent), relative(parent, path));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      if (rejectDanglingLink && (await lstat(parent).catch(() => undefined))?.isSymbolicLink()) return undefined;
      const next = dirname(parent);
      if (next === parent) return undefined;
      parent = next;
    }
  }
}

async function targetFor(path: string, search: boolean, rejectDanglingLink = false): Promise<Target> {
  if (/^[\\/]{2}[^\\/]/.test(path)) return { paths: [path], directory: search, unresolved: true };
  const [actual, info] = await Promise.all([canonical(path, rejectDanglingLink), search ? stat(path).catch(() => undefined) : undefined]);
  return {
    paths: actual && actual !== path ? [path, actual] : [path],
    directory: search && (info?.isDirectory() ?? true),
    unresolved: actual === undefined,
  };
}

async function factsFor(call: InnerCall, cwd: string, settings: Settings): Promise<Facts> {
  const facts: Facts = { bashPaths: [], uncertainBashPaths: false };
  if (call.tool !== 'Bash') {
    const path = call.input[call.tool === 'Read' ? 'file_path' : 'path'];
    if (typeof path === 'string' || call.tool !== 'Read') {
      facts.target = await targetFor(typeof path === 'string' && path ? path : cwd, call.tool !== 'Read');
    }
    return facts;
  }
  if (typeof call.input.command !== 'string') return facts;
  facts.shell = splitShell(call.input.command);
  const fileRules = [...settings.rules.deny, ...settings.rules.ask].some(({ text }) => /^(?:Read|Edit)\(/.test(text.trim()));
  if (!settings.blockOutside && !fileRules) return facts;
  const candidates = new Map<string, boolean>();
  for (const command of facts.shell.commands) {
    const inner = shellVariants(command, 'deny').at(-1) ?? command;
    const [program, ...args] = inner.match(/(?:[^\s'"]+|"[^"]*"|'[^']*')+/g) ?? [];
    if (!program) continue;
    if (/[<>]/.test(inner)) facts.uncertainBashPaths = true;
    const name = basename(program.replace(/^(['"])(.*)\1$/, '$2'));
    const executable = process.platform === 'win32' ? name.replace(/\.exe$/i, '') : name;
    const paths = args.map((arg) => arg.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
    if (!/^(?:cat|head|tail|sed|less|more|wc|stat|ls|cd|grep|rg|find|du|tee|cp|mv|rm|rmdir|touch|mkdir|diff|sort|cut|tr|awk|file|readlink|realpath)$/.test(executable)) {
      // An unknown program may open any argument as a file, so the file rules check each one as a path.
      if (fileRules) {
        let options = true;
        for (const arg of paths) {
          if (arg === '--' && options) {
            options = false;
            continue;
          }
          const path = !options || !arg.startsWith('-') ? arg
            : arg.startsWith('--') ? /^--[^=]+=(.*)$/s.exec(arg)?.[1] : arg.slice(2);
          if (!path) continue;
          const absolute = resolveToolPath(cwd, path);
          if (!candidates.has(absolute)) candidates.set(absolute, false);
        }
      }
      continue;
    }
    const search = /^(?:grep|rg|find)$/.test(executable);
    const operands = search ? readOnlyPaths(executable + inner.slice(program.length))?.paths : undefined;
    if (facts.shell.complex || (search && !operands) || /^(?:cd|tee|cp|mv|rm|rmdir|touch|mkdir)$/.test(executable)) facts.uncertainBashPaths = true;
    for (const arg of operands ?? paths) {
      // Parsed operands are already paths, including names starting with '-' after `--`.
      if (!arg || (!operands && arg.startsWith('-'))) continue;
      const absolute = resolveToolPath(cwd, arg);
      candidates.set(absolute, search || candidates.get(absolute) === true);
    }
  }
  facts.bashPaths = await Promise.all([...candidates].map(([path, search]) => targetFor(path, search)));
  return facts;
}

function pathExpression(pattern: string, kind: Kind): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      if (++i === pattern.length) throw new Error('Invalid path escape.');
      source += escapeRegex(pattern[i]);
    } else if (char === '*') {
      if (pattern.slice(i, i + 3) === '**/' && (i === 0 || pattern[i - 1] === '/')) {
        source += '(?:[^/]+/)*';
        i += 2;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1 || /[/[\\^]/.test(pattern.slice(i + 1, end))) throw new Error('Unsupported path character class.');
      source += '(?!/)[' + pattern.slice(i + 1, end).replace(/^!/, '^') + ']';
      i = end;
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp('^(?:' + source + ')$', process.platform === 'win32' && kind !== 'allow' ? 'i' : '');
}

async function matchPath(spec: string, root: string, cwd: string, target: Target, kind: Kind, shell = false): Promise<Match> {
  if (target.unresolved) return 'unknown';
  const negative = spec.startsWith('!');
  if (negative) spec = spec.slice(1);
  const anchored = /^(?:\/|~\/)/.test(spec);
  if (negative && (anchored || kind === 'allow')) return 'no';
  const drive = process.platform === 'win32' && /^\/\/([a-z]):?\//i.exec(spec);
  const anchor = drive ? drive[1] + ':/' : spec.startsWith('//') ? resolveToolPath(cwd, '/')
    : spec.startsWith('~/') ? homedir() : spec.startsWith('/') ? root : cwd;
  const raw = (drive ? spec.slice(drive[0].length) : spec.replace(/^(?:\/\/|~\/|\/|\.\/)/, '')).replace(/(?<!\\) +$/, '');
  const pattern = raw.replace(/(?:\/\*\*|\/)$/, '');
  if (!pattern || pattern.includes('\0') || pattern.split('/').some((part) => !part || part === '..' || part === '.')) return 'unknown';
  const atAnyDepth = !anchored && !pattern.includes('/') && (!raw.endsWith('/**') || kind !== 'allow');
  let exact: RegExp;
  try {
    exact = pathExpression(atAnyDepth ? '**/' + pattern : pattern, kind);
  } catch {
    return 'unknown';
  }
  const fixed = [];
  if (!atAnyDepth) {
    for (const part of pattern.split('/')) {
      if (/[*?[\]\\]/.test(part)) break;
      fixed.push(part);
    }
  }
  const fixedPath = resolve(anchor, ...fixed);
  const realAnchor = !negative && kind !== 'allow' ? await canonical(fixedPath) : undefined;
  const matches = (path: string) => {
    const named = realAnchor && fixedPath !== realAnchor && inside(realAnchor, path)
      ? resolve(fixedPath, relative(realAnchor, path)) : path;
    if (!inside(anchor, named)) return false;
    // Rule patterns use '/', so Windows separators are converted before matching.
    const rel = relative(anchor, named).split(sep).join('/');
    if ((!raw.endsWith('/') || target.directory) && exact.test(rel)) return true;
    if (negative) return false;
    const parts = rel.split('/');
    return parts.slice(1).some((_, index) => exact.test(parts.slice(0, index + 1).join('/')));
  };
  const matched = kind === 'allow' || negative ? target.paths.every(matches) : target.paths.some(matches);
  if (matched) return negative ? 'exclude' : 'yes';
  if (shell && kind === 'deny' && target.directory && !negative &&
      target.paths.some((path) => inside(path, fixedPath) || inside(fixedPath, path) ||
        (realAnchor !== undefined && (inside(path, realAnchor) || inside(realAnchor, path))))) {
    // Shell searches cannot filter denied descendants.
    return 'yes';
  }
  return 'no';
}

async function matchRule(rule: Rule, kind: Kind, call: InnerCall, facts: Facts, cwd: string): Promise<Match> {
  const text = rule.text.trim();
  const name = /^[\w*]+/.exec(text)?.[0];
  if (!name || (kind === 'allow' && name.includes('*'))) return 'no';
  const direct = wildcard(name, call.tool);
  const readSearch = kind !== 'allow' && wildcard(name, 'Read') && (call.tool === 'Glob' || call.tool === 'Grep');
  const bashFile = kind !== 'allow' && (name === 'Read' || name === 'Edit') && call.tool === 'Bash';
  if (!direct && !readSearch && !bashFile) return 'no';
  if (text === name || text === name + '(*)') {
    return (direct || (kind === 'deny' && readSearch)) && !(kind === 'allow' && facts.shell?.commands.some(mentionsFind)) ? 'yes' : 'no';
  }
  if (!text.startsWith(name + '(') || !text.endsWith(')')) return 'unknown';
  const spec = text.slice(name.length + 1, -1);
  if (!spec) return 'unknown';
  const parameter = /^([-\w]+)\s*:\s*(.+)$/.exec(spec);
  if (parameter && (call.tool !== 'Bash' || !spec.endsWith(':*') || ['command', 'timeout', 'description'].includes(parameter[1]))) {
    const [, key, pattern] = parameter;
    if (!direct || ['command', 'file_path', 'path'].includes(key)) return 'unknown';
    if (!['description', 'timeout', 'offset', 'limit', 'pattern', 'glob', 'type', 'output_mode', '-i', '-n', '-A', '-B', '-C', 'multiline', 'head_limit'].includes(key)) return 'unknown';
    return Object.hasOwn(call.input, key) && wildcard(pattern, String(call.input[key])) ? 'yes' : 'no';
  }
  if (call.tool === 'Bash' && direct && facts.shell) {
    const hit = kind === 'allow'
      ? !facts.shell.complex && facts.shell.commands.every((command) => bashMatch(spec, command, kind))
      : facts.shell.commands.some((command) => bashMatch(spec, command, kind));
    return hit ? 'yes' : 'no';
  }
  if (bashFile) {
    for (const target of facts.bashPaths) {
      const hit = await matchPath(spec, rule.root, cwd, target, kind, true);
      if (hit !== 'no') return hit;
    }
    return 'no';
  }
  if ((name === 'Read' || (kind === 'deny' && (call.tool === 'Read' || readSearch) && wildcard(name, 'Read'))) && facts.target) {
    return matchPath(spec, rule.root, cwd, facts.target, kind);
  }
  return direct && call.tool !== 'Glob' && call.tool !== 'Grep' ? 'unknown' : 'no';
}

async function rulesFor(settings: Settings, kind: Kind, call: InnerCall, facts: Facts, cwd: string): Promise<{ match?: Rule; unknown?: Rule }> {
  if (kind === 'allow' && facts.shell && !facts.shell.complex && facts.shell.commands.length > 1) {
    const each = await Promise.all(facts.shell.commands.map((command) => rulesFor(
      settings, kind, call, { ...facts, shell: { commands: [command], complex: false } }, cwd,
    )));
    return { match: each.every((result) => result.match) ? each[0].match : undefined };
  }
  const matched: Rule[] = [];
  let unknown: Rule | undefined;
  for (const rule of settings.rules[kind]) {
    const hit = await matchRule(rule, kind, call, facts, cwd);
    if (hit === 'yes') matched.push(rule);
    else if (hit === 'exclude') {
      for (let i = matched.length - 1; i >= 0; i--) {
        if (matched[i].source === rule.source && /^Read\((?!\/|~\/|\*\))/.test(matched[i].text.trim()) &&
            !matched[i].text.trim().endsWith('/**)') && !matched[i].text.trim().endsWith('/)')) matched.splice(i, 1);
      }
    } else if (hit === 'unknown') unknown ??= rule;
  }
  return { match: matched[0], unknown };
}

function hookMatches(matcher: unknown, tool: string): Match {
  if (matcher === undefined || matcher === '' || matcher === '*') return 'yes';
  if (typeof matcher !== 'string') return 'unknown';
  if (/^[A-Za-z0-9_,| -]+$/.test(matcher)) return matcher.split(/[|,]/).some((entry) => entry.trim() === tool) ? 'yes' : 'no';
  try {
    return new RegExp(matcher).test(tool) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

async function runHooks(event: HookEvent, call: InnerCall, ctx: GateContext, settings: Settings, out?: ToolOutput) {
  const jobs = new Map<string, { hook: Hook; command: string; args?: string[] }>();
  const results: HookResult[] = [];
  let facts: Facts | undefined;
  for (const hook of settings.hooks[event]) {
    const match = hookMatches(hook.matcher, call.tool);
    if (match === 'no') continue;
    const { config, source } = hook;
    if (config.if !== undefined) {
      const condition = typeof config.if === 'string' ? config.if : '';
      facts ??= await factsFor(call, ctx.cwd, settings);
      const hit = condition ? await matchRule({ text: condition, root: ctx.cwd, source }, 'ask', call, facts, ctx.cwd) : 'unknown';
      if (hit === 'no' && (!facts.shell?.complex || !/^Bash\(/.test(condition))) continue;
      if (hit !== 'yes' && !(hit === 'no' && /^Bash\(/.test(condition) && facts.shell?.complex)) {
        const kind = typeof config.type === 'string' ? config.type : 'unknown';
        results.push({ decision: 'deny', withhold: event === 'PostToolUse',
          reason: 'Code Mode cannot evaluate a matching ' + kind + ' ' + event + ' hook. Turn Code Mode off or use the normal tool.' });
        continue;
      }
    }
    const args = config.args;
    if (match === 'unknown' || config.type !== 'command' || typeof config.command !== 'string' ||
        (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) ||
        (config.shell !== undefined && config.shell !== 'bash' && args === undefined) ||
        config.asyncRewake === true || (hook.pluginRoot && JSON.stringify(config).includes('$' + '{user_config.'))) {
      const kind = typeof config.type === 'string' ? config.type : 'unknown';
      results.push({ decision: 'deny', withhold: event === 'PostToolUse',
        reason: 'Code Mode cannot run a matching ' + kind + ' ' + event + ' hook. Turn Code Mode off or use the normal tool.' });
      continue;
    }
    const key = JSON.stringify([source, hook.pluginRoot, config.command, args, config.shell, config.async]);
    const existing = jobs.get(key);
    if (existing?.hook.config.onFailure === 'block' && config.onFailure !== 'block') continue;
    jobs.set(key, { hook, command: config.command, args: args as string[] | undefined });
  }
  if (!jobs.size) return results;
  const payload = JSON.stringify({
    session_id: ctx.sessionId, transcript_path: ctx.transcriptPath, cwd: ctx.cwd, permission_mode: ctx.mode,
    hook_event_name: event, tool_name: call.tool, tool_input: call.input, tool_use_id: call.id,
    ...(event === 'PermissionRequest' ? { permission_suggestions: [] } : {}),
    ...(out ? { tool_response: out.data } : {}),
  }) + '\n';
  const finished = await Promise.all([...jobs.values()].map(async ({ hook, command, args }): Promise<HookResult> => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: ctx.cwd, CLAUDE_PLUGIN_ROOT: hook.pluginRoot };
    const substitute = (text: string) => text.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT)\}/g,
      (placeholder, name: 'CLAUDE_PROJECT_DIR' | 'CLAUDE_PLUGIN_ROOT') => env[name] ?? placeholder);
    const timeout = typeof hook.config.timeout === 'number' && hook.config.timeout > 0
      ? Math.min(2_147_483_647, hook.config.timeout * 1000) : 600_000;
    const background = hook.config.async === true;
    // An async hook outlives the program, so only its own timeout stops it.
    const pending = runProcess(args ? substitute(command) : hook.config.shell === 'bash' ? 'bash' : 'sh',
      args ? args.map(substitute) : ['-c', command], {
        cwd: ctx.cwd, signal: background ? new AbortController().signal : ctx.signal, env, timeout,
        stdin: payload, cap: 262_144,
      });
    if (background) {
      void pending;
      return {};
    }
    const result = await pending;
    const failed = (reason: string, abnormal: boolean): HookResult => {
      if (event === 'PermissionRequest' && result.exitCode === 2) return {};
      console.warn('Code Mode ' + event + ' hook: ' + reason);
      if (event === 'PostToolUse' && abnormal) return { withhold: true };
      if (hook.config.onFailure === 'block' ||
          (event === 'PreToolUse' && abnormal && hook.config.onFailure !== 'continue')) return { decision: 'deny', reason };
      return {};
    };
    if (event === 'PostToolUse' && result.truncated) return failed('The hook output exceeded the size limit.', true);
    if (result.exitCode === 2 && event !== 'PermissionRequest') {
      return { decision: 'deny', reason: result.stderr.trim() || 'A hook blocked the call.' };
    }
    const abnormal = Boolean(result.error || result.timedOut || result.signaled ||
      result.interrupted || result.exitCode === 126 || result.exitCode === 127 || result.exitCode > 128);
    if (abnormal || (result.exitCode !== 0 && result.exitCode !== 2 && hook.config.onFailure === 'block')) {
      return failed(result.timedOut ? 'The hook did not finish.' : 'The hook failed (exit ' + result.exitCode + ').', abnormal);
    }
    const stdout = result.stdout.trim();
    const looksLikePostJson = event === 'PostToolUse' && result.exitCode === 0 &&
      (stdout.startsWith('{') || stdout.startsWith('['));
    if (!looksLikePostJson && (!stdout.startsWith('{') || !stdout.endsWith('}'))) {
      return result.exitCode === 0 || (event === 'PermissionRequest' && result.exitCode === 2)
        ? {} : failed('The hook exited with code ' + result.exitCode + '.', false);
    }
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (looksLikePostJson && Array.isArray(parsed)) return {};
      json = object(parsed);
    } catch {
      return failed('The hook returned invalid JSON.', result.exitCode === 0);
    }
    if (!json) return failed('The hook returned invalid JSON.', result.exitCode === 0);
    const output = object(json.hookSpecificOutput);
    if (json.hookSpecificOutput !== undefined && output?.hookEventName !== event) {
      return failed('The hook returned an unexpected event name.', result.exitCode === 0);
    }
    const permission = event === 'PermissionRequest' ? object(output?.decision) : undefined;
    const decision = json.continue === false || json.decision === 'block' ? 'deny'
      : event === 'PermissionRequest' ? permission?.behavior
      : output?.permissionDecision ?? (json.decision === 'approve' ? 'allow' : undefined);
    if (decision !== undefined && !['allow', 'deny', 'ask', 'defer'].includes(String(decision))) {
      return failed('The hook returned an invalid permission decision.', result.exitCode === 0);
    }
    const reason = json.continue === false ? json.stopReason : permission?.message ?? output?.permissionDecisionReason ?? json.reason;
    const context = output?.additionalContext ?? json.additionalContext;
    return {
      decision: decision as HookResult['decision'],
      reason: typeof reason === 'string' ? reason : undefined,
      input: event === 'PermissionRequest' ? object(permission?.updatedInput) : object(output?.updatedInput),
      context: typeof context === 'string' ? context.slice(0, 10_000) : undefined,
      replacement: output !== undefined && Object.hasOwn(output, 'updatedToolOutput') ? { data: output.updatedToolOutput } : undefined,
    };
  }));
  return results.concat(finished);
}

async function permittedPath(settings: Settings, target: Target | undefined) {
  if (!target || target.unresolved) return false;
  const aliases = await Promise.all(settings.directories.map((path) => canonical(path)));
  return target.paths.every((path) => [...settings.directories, ...aliases]
    .some((root) => root !== undefined && inside(root, path)));
}

async function readOnlyBash(call: InnerCall, facts: Facts, cwd: string, settings: Settings): Promise<boolean> {
  const source = call.input.command;
  if (!facts.shell || facts.shell.complex || typeof source !== 'string' || /(?![ \t\n])[\s\p{Cc}]/u.test(source)) return false;
  if (!SHELL) return false;
  const paths = new Map<string, boolean>();
  for (const command of facts.shell.commands) {
    const read = readOnlyPaths(command);
    if (!read) return false;
    for (const path of read.paths) {
      if (!path) return false;
      const absolute = resolveToolPath(cwd, path, false);
      paths.set(absolute, paths.get(absolute) || read.filesOnly === true);
    }
  }
  const targets = await Promise.all([...paths].map(async ([path, filesOnly]) => {
    const target = await targetFor(path, true, true);
    if (target.unresolved || (filesOnly && !(await stat(path).catch(() => undefined))?.isFile())) return undefined;
    return target;
  }));
  if (!(await Promise.all(targets.map((target) => permittedPath(settings, target)))).every(Boolean)) return false;
  const scopedRules = [...settings.rules.deny, ...settings.rules.ask].some(({ text }) => /^(?:Read|Edit)\(/.test(text.trim()));
  if (!scopedRules) return true;
  const bashPaths = targets.filter((target) => target !== undefined);
  // A directory operand can reach entries that the shell path matcher cannot enumerate.
  if (bashPaths.some((target) => target.directory)) return false;
  for (const kind of ['deny', 'ask'] as const) {
    const restrictive = await rulesFor(settings, kind, call, { ...facts, bashPaths }, cwd);
    if (restrictive.match || restrictive.unknown) return false;
  }
  return true;
}

async function evaluate(call: InnerCall, ctx: GateContext, settings: Settings, approved?: 'user' | 'hook'): Promise<Decision> {
  const context: string[] = [];
  const deny = (message: string): Decision => ({ allow: false, message, context });
  if (ctx.signal.aborted) return deny(CANCELLED);
  if (call.tool === 'Bash' && settings.sandbox) {
    return deny('Code Mode cannot run Bash inside the Claude Code sandbox; use Bash with run_in_background or turn Code Mode off.');
  }
  const initial = call;
  const hooks = await runHooks('PreToolUse', call, ctx, settings);
  for (const hook of hooks) {
    if (hook.decision !== 'defer' && hook.context) context.push(hook.context);
  }
  if (ctx.signal.aborted) return deny(CANCELLED);
  const blocked = hooks.find((hook) => hook.decision === 'deny');
  if (blocked) return deny(blocked.reason || 'A PreToolUse hook blocked the call.');
  const deferred = hooks.find((hook) => hook.decision === 'defer');
  const asked = hooks.find((hook) => hook.decision === 'ask');
  const allowed = hooks.find((hook) => hook.decision === 'allow');
  // With rewrites off, a hook's decision on a command still counts but the command runs as the program wrote it.
  const inputOf = (hook: HookResult) => (call.tool === 'Bash' && !ctx.hookRewrites ? undefined : hook.input);
  const rewrites = hooks.flatMap((hook) => inputOf(hook) && hook.decision !== 'defer'
    ? [normalize({ ...call, input: inputOf(hook)! }, ctx.cwd)] : []);
  const preferred = asked ? inputOf(asked) : allowed ? inputOf(allowed) : undefined;
  if (preferred) call = normalize({ ...call, input: preferred }, ctx.cwd);
  else call = rewrites.at(-1) ?? call;
  const conflict = rewrites.some((rewrite) => !isDeepStrictEqual(rewrite.input, call.input));
  if (call.tool === 'Bash' && call.input.command !== initial.input.command) context.push(REWRITE_NOTE);
  const read = call.tool === 'Read' && typeof call.input.file_path === 'string' && call.input.file_path
    ? await readTarget(call.input.file_path) : null;
  const facts = await factsFor(call, ctx.cwd, settings);
  if (read && typeof call.input.file_path === 'string') {
    const path = call.input.file_path;
    facts.target = { paths: read.path === path ? [path] : [path, read.path], directory: false, unresolved: false };
  }
  const allow = (): Decision => {
    if (call.tool === 'Read') approveRead(call.input, read);
    const filter = (call.tool === 'Glob' || call.tool === 'Grep') && settings.rules.deny.some(({ text }) => {
      const name = /^[\w*]+/.exec(text.trim())?.[0];
      return name !== undefined && wildcard(name, 'Read');
    });
    let unknown: string | undefined;
    return { allow: true, input: call.input, context, ...(filter && {
      searchPathAllowed: async (path: string) => {
        const target = await targetFor(path, false, true);
        if (target.unresolved) return false;
        const denied = await rulesFor(settings, 'deny', { ...call, tool: 'Read' }, { ...facts, target }, ctx.cwd);
        if (!denied.match && denied.unknown) unknown ??= denied.unknown.text;
        return !denied.match && !denied.unknown;
      },
      // Skipped files would otherwise read as "no matches".
      searchNote: () => unknown && `Some files were skipped because Code Mode could not evaluate the deny rule ${unknown}.`,
    }) };
  };
  const denied = await rulesFor(settings, 'deny', call, facts, ctx.cwd);
  if (denied.match) return deny('Denied by rule ' + denied.match.text + '.');
  const shellDenyMayApply = settings.rules.deny.some(({ text }) => /^(?:Bash|Read|Edit)\(/.test(text.trim()));
  if (facts.shell && shellDenyMayApply && (facts.shell.complex || facts.uncertainBashPaths)) {
    return deny('Code Mode could not rule out a deny rule for this shell command.');
  }
  const inScope = await permittedPath(settings, facts.target);
  if (call.tool !== 'Bash' && settings.blockOutside && !inScope) return deny('Reads outside the working directories are blocked.');
  const toAsk = await rulesFor(settings, 'ask', call, facts, ctx.cwd);
  const remove = facts.shell?.commands.some((command) =>
    shellVariants(command, 'deny').some((variant) => /^(?:\S*\/)?rm(?:dir)?(?:\s|$)/.test(variant)));
  const criticalRemoval = remove && facts.shell?.commands.some((command) =>
    /(?:^|\s)["']?(?:\/(?:\s|["']|$)|\/(?:home|etc|usr|bin|boot|lib|lib64|sbin|var|dev|proc|sys|root|opt|run|mnt|media|tmp)\/?(?:["']|\s|$)|~\/?(?:["']|\s|$)|\$(?:HOME|\{HOME\})(?:["']|\s|$))/.test(command));
  if (criticalRemoval && (ctx.mode === 'auto' || ctx.mode === 'plan')) {
    return deny('Code Mode blocked a potentially critical path removal.');
  }
  const bashOutside = Boolean(facts.shell && settings.blockOutside &&
    (facts.shell.complex || facts.uncertainBashPaths || !(await Promise.all(
      facts.bashPaths.map((target) => permittedPath(settings, target)),
    )).every(Boolean)));
  const bypass = ctx.mode === 'bypassPermissions' && !settings.disableBypass;
  const unknownRule = denied.unknown ?? toAsk.unknown;
  const planBash = call.tool === 'Bash' && ctx.mode === 'plan';
  const restrictions = [
    toAsk.match ? 'Approval required by rule ' + toAsk.match.text + '.' : undefined,
    unknownRule ? 'Code Mode cannot evaluate rule ' + unknownRule.text + '.' : undefined,
    deferred ? deferred.reason || 'A hook deferred the call, which Code Mode cannot resume.' : undefined,
    asked ? asked.reason || 'A PreToolUse hook requested approval.' : undefined,
    conflict ? 'PreToolUse hooks returned different inputs.' : undefined,
    ...settings.gaps,
    facts.target?.unresolved ? 'Code Mode could not verify the file path.' : undefined,
    // In bypass an unparsed command only matters when an ask rule could match it (deny rules were handled above).
    (facts.shell?.complex || facts.uncertainBashPaths) && (!bypass || settings.rules.ask.some(({ text }) => /^(?:Bash|Read|Edit)\(/.test(text.trim())))
      ? 'Code Mode could not fully analyze the shell command.' : undefined,
    bashOutside ? 'Code Mode could not verify that Bash reads stay inside the working directories.' : undefined,
    // Bypass runs removals like the CLI does; only critical paths still ask there.
    remove && (!bypass || criticalRemoval) ? 'Code Mode requires approval for shell removals.' : undefined,
  ].filter(Boolean);
  const reason = [...restrictions, ...(planBash ? ['Bash requires approval in plan mode.'] : [])].join(' ');
  const modeAllows = bypass || (call.tool !== 'Bash' && inScope);
  const allowRule = !reason && !modeAllows && !allowed ? (await rulesFor(settings, 'allow', call, facts, ctx.cwd)).match : undefined;
  const readOnly = !restrictions.length && !approved && !modeAllows && !allowRule && (!allowed || planBash) &&
    call.tool === 'Bash' && ctx.mode !== 'bypassPermissions' && await readOnlyBash(call, facts, ctx.cwd, settings);
  if (ctx.signal.aborted) return deny(CANCELLED);
  if (approved && !isDeepStrictEqual(call.input, initial.input)) {
    return deny('A hook changed the approved edit. Submit the updated call for approval.');
  }
  if (readOnly || approved === 'user' || (approved === 'hook' && !reason) ||
      (!reason && (modeAllows || allowed || allowRule))) return allow();
  if (settings.denyInsteadOfPrompting) return deny(reason || 'This call requires approval and permission prompts are disabled.');
  if (!approved) {
    const responses = await runHooks('PermissionRequest', call, ctx, settings);
    if (ctx.signal.aborted) return deny(CANCELLED);
    for (const hook of responses) if (hook.context) context.push(hook.context);
    const refusal = responses.find((hook) => hook.decision === 'deny');
    if (refusal) return deny(refusal.reason || 'A PermissionRequest hook denied the call.');
    const approvals = responses.filter((hook) => hook.decision === 'allow');
    if (approvals.length) {
      const edits = approvals.map((hook) => {
        const input = inputOf(hook);
        return input ? normalize({ ...call, input }, ctx.cwd) : call;
      });
      if (edits.every((edit) => isDeepStrictEqual(edit.input, edits[0].input))) {
        if (isDeepStrictEqual(call.input, edits[0].input)) return allow();
        if (call.tool === 'Bash' && edits[0].input.command !== call.input.command) context.push(REWRITE_NOTE);
        const result = await evaluate(edits[0], ctx, settings, 'hook');
        return { ...result, context: [...context, ...result.context] };
      }
    }
  }
  const answer = await askUntilAbort(ctx, call, reason || null);
  if (!answer.allow) return deny(answer.message);
  const edited = normalize({ ...call, input: answer.input }, ctx.cwd);
  if (isDeepStrictEqual(call.input, edited.input)) return allow();
  const result = await evaluate(edited, ctx, settings, 'user');
  return { ...result, context: [...context, ...result.context] };
}

async function askUntilAbort(ctx: GateContext, call: InnerCall, reason: string | null) {
  const interrupted = { allow: false, message: CANCELLED } as const;
  if (ctx.signal.aborted) return interrupted;
  let abort: () => void = () => {};
  const cancelled = new Promise<typeof interrupted>((resolve) => {
    abort = () => resolve(interrupted);
    ctx.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const answer = await Promise.race([ctx.ask(call, reason), cancelled]);
    return ctx.signal.aborted ? interrupted : answer;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}

export async function before(call: InnerCall, ctx: GateContext): Promise<Decision> {
  if (ctx.signal.aborted) return { allow: false, message: CANCELLED, context: [] };
  ctx = { ...ctx };
  const settings = await settingsFor(ctx.cwd);
  return evaluate(normalize(call, ctx.cwd), ctx, settings);
}

export async function after(call: InnerCall, input: Record<string, unknown>, out: ToolOutput, ctx: GateContext): Promise<{ context: string[] }> {
  const context: string[] = [];
  const withhold = () => {
    const message = 'A PostToolUse hook replaced this output with a format Code Mode cannot return.';
    Object.assign(out, failure(call.tool, message));
    context.push(message);
  };
  if (ctx.signal.aborted || out.isError) return { context };
  try {
    ctx = { ...ctx };
    const settings = await settingsFor(ctx.cwd);
    const hooks = await runHooks('PostToolUse', normalize({ ...call, input }, ctx.cwd), ctx, settings, out);
    for (const hook of hooks) {
      if (hook.context) context.push(hook.context);
      if (hook.decision === 'deny' || hook.decision === 'ask') context.push(hook.reason || 'A PostToolUse hook reported a problem.');
    }
    const replacements = hooks.flatMap((hook) => hook.replacement ? [hook.replacement] : []);
    if (hooks.some((hook) => hook.withhold)) withhold();
    else if (replacements.length) {
      const data = object(replacements[0].data);
      if (call.tool === 'Bash' && replacements.length === 1 && 'exitCode' in out.data &&
          typeof data?.stdout === 'string' && typeof data.stderr === 'string' && typeof data.interrupted === 'boolean') {
        out.data = { stdout: data.stdout, stderr: data.stderr, interrupted: data.interrupted, exitCode: out.data.exitCode };
      } else withhold();
    }
  } catch {
    console.warn('Code Mode could not evaluate PostToolUse hooks.');
    withhold();
  }
  return { context };
}
