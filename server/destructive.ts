import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

// Holds listed destructive effects, modelled outside writes, hidden commands/targets and privilege/environment tricks.
// null offers model review (including project scripts), not execution safety; lookup, configuration and disk races remain trusted.

// What the checker reads from an ask: the tool's own name, the full shell command, file paths as the tool gave them,
// the folder a command runs in when it is not the session's, and a Codex request for write access to a whole folder.
export type AskFacts = { tool: string; command?: string; paths?: string[]; cwd?: string; grantRoot?: string };

type Row = { name: string; re: RegExp; unless?: RegExp };

// Thrown for anything the checker does not model; destructive() turns it into the pin's reason.
class Unchecked extends Error {}
const unchecked = (what: string): never => {
  throw new Unchecked(`Could not be checked: ${what}`);
};
const listed = (name: string) => `On the destructive list: ${name}`;

const HOME = homedir();
const git = (rest: string) => new RegExp(String.raw`^git\s+` + rest);

// Matched against one fully parsed simple command, rebuilt as "name arg arg" from its executable on. Add a row to
// extend it. A git command is matched against the git rows only, so a commit message never trips another row.
const COMMANDS: Row[] = [
  // Mass delete
  { name: 'rm -r', re: /^rm\s(?:.*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--no-preserve-root)(?:\s|$)/ },
  { name: 'rimraf', re: /^(?:rimraf|del|del-cli|trash|rmrf)(?:\s|$)/ },
  { name: 'find -delete', re: /^find\s(?:.*\s)?-delete(?:\s|$)/ },
  { name: 'rsync deletion', re: /^rsync\b.*\s--(?:delete[\w-]*|remove-source-files)(?:[=\s]|$)/ },
  { name: 'git clean', re: git(String.raw`clean\b`) },
  // Discarding git work
  { name: 'git reset', re: git(String.raw`reset\b`) },
  { name: 'git history rewriting', re: git(String.raw`(?:rebase|filter-branch|filter-repo)\b|commit\b.*\s--amend\b`) },
  { name: 'git checkout -- / .', re: git(String.raw`checkout\b.*\s(?:--|\.|-f|--force)(?:\s|$)`) },
  { name: 'git restore', re: git(String.raw`restore\b`) },
  { name: 'git stash drop', re: git(String.raw`stash\s+(?:drop|clear)\b`) },
  { name: 'git branch deletion or replacement', re: git(String.raw`branch\b.*\s(?:-[a-zA-Z]*[dDfFM][a-zA-Z]*|--delete|--force)(?:\s|$)`) },
  { name: 'git tag deletion or replacement', re: git(String.raw`tag\b.*\s(?:-[a-zA-Z]*[df][a-zA-Z]*|--delete|--force)(?:\s|$)`) },
  { name: 'git worktree remove --force', re: git(String.raw`worktree\s+remove\b.*\s(?:-f|--force)\b`) },
  // Publishing
  { name: 'git push', re: git(String.raw`push\b`) },
  { name: 'gh pr merge', re: /^gh\s+pr\s+merge\b/ },
  { name: 'gh release', re: /^gh\s+release\b/ },
  { name: 'gh repo delete', re: /^gh\s+repo\s+(?:delete|archive|rename|edit)\b/ },
  { name: 'gh api write', re: /^gh\s+api\b.*\s(?:(?:-X|--method)[\s=]*(?!GET\b)[A-Za-z]|-[fF]\s|--(?:raw-)?field\b|--input\b)/ },
  { name: 'npm publish', re: /^(?:npm|pnpm|yarn|bun)\s(?:.*\s)?(?:un)?publish(?:\s|$)/ },
  { name: 'cargo publish', re: /^(?:cargo\s+(?:publish|yank)|twine\s+upload)\b/ },
  // Cloud and deploy
  {
    name: 'aws (not read-only)', re: /^aws\s/,
    unless: /^aws\s+(?:--\S+(?:\s+(?!-)\S+)?\s+)*(?:[\w-]+\s+(?!get-secret-value\b|get-parameters?\b|get-login-password\b|get-session-token\b|get-authorization-token\b)(?:describe|list|get)-[\w-]+|s3\s+ls|sts\s+get-caller-identity)(?:\s|$)/,
  },
  { name: 'terraform apply', re: /^(?:terraform|tofu|terragrunt)\s(?:.*\s)?(?:apply|destroy|import|state|taint|untaint|force-unlock)\b/ },
  { name: 'vercel --prod', re: /^(?:vercel|vc)\b.*\s(?:--prod\b|(?:promote|rollback|remove|rm)\b)/ },
  { name: 'cloud deploy or delete', re: /^(?:gcloud|az|fly|flyctl|heroku|netlify|firebase|wrangler|railway)\s(?:.*\s)?(?:deploy|delete|destroy|publish|rm|remove)\b/ },
  { name: 'kubectl delete', re: /^(?:kubectl|helm)\s(?:.*\s)?(?:delete|apply|uninstall|drain|scale|rollout|patch|replace)\b/ },
  { name: 'docker system prune --volumes', re: /^(?:docker|podman)\s+system\s+prune\b.*\s--volumes\b/ },
  { name: 'docker volume rm', re: /^(?:docker|podman)\s+volume\s+(?:rm|remove|prune)\b/ },
  { name: 'docker compose down -v', re: /^(?:docker(?:-compose|\s+compose)|podman-compose)\s(?:.*\s)?down\b.*\s(?:-v|--volumes)\b/ },
  { name: 'remote copy', re: /^(?:scp|rsync|sftp)\s(?:.*\s)?[\w.-]*@?[\w.-]+:/ },
  { name: 'ssh', re: /^ssh\s/ },
  // Database tools; inline SQL goes through sqlWhy
  { name: 'migrate reset', re: /\bmigrat(?:e|ions?)[:\s]+(?:reset|fresh|refresh|rollback|revert|redo|down|drop)\b/i },
  { name: 'db push --force', re: /\bpush\b.*\s--(?:force-reset|force|accept-data-loss)\b/ },
  { name: 'database drop or reset', re: /\b(?:db|database|schema)[:\s]+(?:drop|reset|wipe|nuke|purge)\b/i },
  { name: 'drizzle-kit drop', re: /^drizzle-kit\s+drop\b/ },
  { name: 'dropdb', re: /^dropdb\b|\bmanage\.py\s+(?:flush|reset_db|sqlflush)\b/ },
  // System
  { name: 'sudo', re: /^(?:sudo|doas|pkexec|run0|su)(?:\s|$)/ },
  { name: 'chmod -R', re: /^(?:chmod|chown|chgrp)\s(?:.*\s)?(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)(?:\s|$)/ },
  {
    name: 'package removal',
    re: /^(?:(?:pacman|yay|paru)\s+-R|(?:pamac|snap|flatpak)\s+(?:remove|uninstall)|apt(?:-get)?\s+(?:remove|purge|autoremove)|(?:dnf|yum|zypper)\s+(?:remove|erase)|brew\s+(?:uninstall|remove|rm)\b|pip3?\s+uninstall\b)/,
  },
  { name: 'systemctl', re: /^systemctl\b/ },
  { name: 'shutdown', re: /^(?:shutdown|reboot|poweroff|halt)\b/ },
  { name: 'disk tools', re: /^(?:mkfs(?:\.\w+)?|fdisk|sfdisk|parted|wipefs|shred|mkswap)\b|^dd\s.*\bof=\/dev\// },
  { name: 'kill -9', re: /^(?:pkill|killall)\b|^kill\s(?:.*\s)?-(?:9|KILL|SIGKILL|s\s+(?:KILL|9))(?:\s|$)/ },
  { name: 'crontab -r', re: /^crontab\s+-r\b/ },
  // Secrets
  { name: 'curl upload', re: /^curl\b.*\s(?:-[a-zA-Z]*[dFT]|--(?:data[\w-]*|form[\w-]*|upload-file|json)\b|(?:-X|--request)[\s=]*(?:POST|PUT|PATCH|DELETE)\b)/ },
  { name: 'wget upload', re: /^wget\b.*\s--(?:post-data|post-file|body-data|body-file|method)\b/ },
  { name: 'printing the environment', re: /^(?:printenv\b.*|env|export\s+-p|set|declare\s+-p|typeset)$/ },
];

// Key, token and env files, by base name.
const SECRET = /^(?:\.env(?:\..*)?|\.envrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore)|credentials(?:\.\w+)?|\.credentials\.json|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.?tokens?|(?:.*[._-])?tokens?\.(?:json|txt)|secrets?\.(?:json|ya?ml|toml|txt|env))$/i;
// Home folders that hold settings, keys or credentials; touched from outside the session's folder, they stay with the user.
const PRIVATE = ['.claude', '.ssh', '.config', '.codex', '.aws', '.gnupg', '.kube', '.docker', '.local/share/keyrings'];
const DEVICES = /^\/dev\/null$/;
// Variables that change what runs or how, so a command prefixed with one is not what it reads as.
const DANGER_ENV = /^(?:PATH|LD_\w+|DYLD_\w+|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|IFS|CDPATH|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|ZDOTDIR|HOME|SHELL|PYTHON\w*|PERL5?\w*|RUBY\w*|GIT_\w+|npm_config_\w+|CARGO_\w+|RUSTC\w*|RUSTFLAGS|CC|CXX|EDITOR|VISUAL|PAGER|SSH_\w+)$/i;
// Shell syntax and builtins the checker does not follow.
const SYNTAX = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'coproc', '!', '{', '}', '[[', ']]']);
const OPAQUE = new Set(['eval', 'source', '.', 'exec', 'alias', 'unalias', 'builtin', 'trap', 'hash', 'enable', 'shopt', 'fc', 'history', 'bind', 'complete', 'compgen', 'mapfile', 'readarray', 'let']);
// Commands that run their arguments as another command.
const RUNNERS = new Set([
  'stdbuf', 'setsid', 'chroot', 'flock', 'watch', 'unbuffer', 'script', 'xvfb-run', 'strace', 'ltrace', 'gdb', 'lldb', 'valgrind', 'firejail', 'bwrap', 'systemd-run',
  'sg', 'runuser', 'chrt', 'ionice', 'taskset', 'caffeinate', 'dbus-run-session', 'faketime', 'proxychains', 'proxychains4', 'torsocks', 'parallel', 'entr', 'nodemon',
  'concurrently', 'npm-run-all', 'run-s', 'run-p', 'watchexec', 'cross-env', 'dotenv', 'env-cmd', 'direnv', 'nix-shell', 'nix', 'with-contenv', 'busybox', 'toolbox', 'distrobox',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'tcsh', 'csh', 'yash']);
// Per interpreter: short flags that take inline code, long ones, short flags whose value follows, and the flags naming
// a module or the script.
const INTERPRETERS: Record<string, { code: string; long?: string[]; values?: string; longValues?: string[]; module?: string; script?: string }> = {
  python: { code: 'c', values: 'WXQ', module: 'm' },
  node: { code: 'ep', long: ['--eval', '--print'], values: 'rC', longValues: ['--require', '--import', '--loader', '--experimental-loader', '--input-type', '--conditions', '--env-file', '--title'] },
  perl: { code: 'eE', values: 'IMmxl0' },
  ruby: { code: 'e', values: 'IrCEFKTWx' },
  php: { code: 'ra', long: ['--run'], values: 'cdzt', script: 'f' },
  lua: { code: 'e', values: 'l' },
  Rscript: { code: 'e' },
  R: { code: 'e' },
  julia: { code: 'eE', long: ['--eval', '--print'], values: 'JLCtp' },
  osascript: { code: 'e', values: 'l' },
  groovy: { code: 'e' },
  tclsh: { code: '' },
  wish: { code: '' },
};
const interpreterOf = (name: string) => (/^(?:python|pypy)[\d.]*$/.test(name) ? 'python' : name === 'nodejs' ? 'node' : name === 'luajit' ? 'lua' : name);
const GIT_KNOWN = new Set([
  'add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'check-ignore', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'count-objects',
  'describe', 'diff', 'fetch', 'for-each-ref', 'format-patch', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'name-rev',
  'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash',
  'status', 'submodule', 'switch', 'tag', 'verify-commit', 'version', 'whatchanged', 'worktree',
]);
const GIT_SAFE_OPTS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects']);
// Commands that write the paths they are given: short options whose value follows, the one naming a target folder,
// whether the first operand is a mode or owner, and whether only the last operand is written (cp).
const WRITERS: Record<string, { values?: string; target?: string; skip1?: true; last?: true }> = {
  rm: {}, rmdir: {}, unlink: {}, shred: { values: 'ns' }, mv: { values: 'tS', target: 't' }, cp: { values: 'tS', target: 't', last: true },
  ln: { values: 'tS', target: 't' }, install: { values: 'mogtS', target: 't' }, rsync: { values: 'efT' }, tee: {}, touch: { values: 'drt' }, mkdir: { values: 'm' },
  truncate: { values: 'sr' }, chmod: { skip1: true }, chown: { skip1: true }, chgrp: { skip1: true },
};
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'duckdb', 'mongosh', 'mongo', 'redis-cli', 'clickhouse-client', 'sqlcmd']);
const REDIS_READS = new Set(['get', 'mget', 'keys', 'scan', 'info', 'ping', 'type', 'ttl', 'pttl', 'exists', 'hget', 'hgetall', 'hkeys', 'hlen', 'lrange', 'llen', 'smembers', 'scard', 'zrange', 'zcard', 'dbsize', 'strlen']);
// s, y, d, p, q, n, = and friends with plain addresses; e, w, W and r commands or flags are refused.
const SED_SAFE = /^\s*(?:(?:\d+|\$|\/(?:[^/\\]|\\.)*\/[IM]*)(?:\s*,\s*(?:\d+|\$|\/(?:[^/\\]|\\.)*\/[IM]*|[+~]\d+))?\s*!?\s*)?(?:[dDpPqQnN=gGhHxlz]|s(.)(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1[gpiImM0-9]*|y(.)(?:(?!\2)[^\\\n]|\\.)*\2(?:(?!\2)[^\\\n]|\\.)*\2)?\s*$/;

const shown = (p: string) => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const within = (p: string, d: string) => p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`);

// The absolute path a literal names, or null when an unknown folder or another user's home leaves it open.
function where(p: string, base: string | null) {
  const q = p.replace(/^~(?=\/|$)/, HOME);
  if (q.startsWith('~')) return null;
  if (isAbsolute(q)) return normalize(q);
  return base === null ? null : resolve(base, q);
}

// The path with symlinks resolved through its deepest existing ancestor, or null when that fails or a link dangles.
async function real(p: string): Promise<string | null> {
  const tail: string[] = [];
  for (let head = p; ; head = dirname(head)) {
    const r = await realpath(head).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : null));
    if (r === null) return null;
    if (r !== undefined) return join(r, ...tail.reverse());
    if (await lstat(head).then(() => true, () => false)) return null;
    if (dirname(head) === head) return null;
    tail.push(basename(head));
  }
}

// The asking session's folders, resolved; a folder at / or home admits reads but no writes.
type Effects = { paths: Set<string>; pending: Set<string>; unknown: boolean; pendingUnknown: boolean };
type Roots = { all: string[]; write: string[]; broad: string[]; homeReal: string; effects?: Effects };

// Commit only between segments so repeated checks of one destination do not conflict with themselves.
function advanceEffects(ctx: Roots) {
  const effects = ctx.effects;
  if (!effects) return;
  for (const p of effects.pending) effects.paths.add(p);
  effects.pending.clear();
  effects.unknown ||= effects.pendingUnknown;
  effects.pendingUnknown = false;
}
async function rootsOf(roots: string[]): Promise<Roots> {
  const homeReal = (await real(HOME)) ?? HOME;
  const all = (await Promise.all(roots.map(real))).filter((r) => r !== null);
  const broad = all.filter((r) => r === '/' || r === homeReal);
  return { all, write: all.filter((r) => !broad.includes(r)), broad, homeReal };
}

// The text before the first glob character, so a pattern is checked by the folder it expands in.
function unglob(p: string) {
  const k = p.search(/[*?[]/);
  if (k < 0) return p;
  const head = p.slice(0, k);
  return !head ? '.' : head.endsWith('/') ? head : dirname(`${head}x`);
}

// Why a path the ask reads or writes keeps it with the user.
async function pathWhy(raw: string, base: string | null, ctx: Roots, writes: boolean, overwrite = false) {
  if (writes && /[*?[]/.test(raw)) unchecked('a write pattern whose targets cannot be checked');
  if (writes && (raw.split('/').includes('..') || base?.split('/').includes('..'))) unchecked('a write with a parent path component');
  const p = unglob(raw);
  if (SECRET.test(basename(p))) return listed(`a secret file (${basename(p)})`);
  const w = where(p, base);
  if (w === null) return writes ? listed(`a path it cannot resolve (${raw})`) : null;
  if (writes && DEVICES.test(w)) return null;
  const disk = isAbsolute(p) ? p : p.startsWith('~') ? w : base === null ? w : `${base}/${p}`;
  const r = await real(disk);
  if (r === null) return writes ? listed(`a path it cannot resolve through the file system (${shown(w)})`) : null;
  if (SECRET.test(basename(r))) return listed(`a secret file (${basename(r)}, through a link)`);
  const dir = PRIVATE.find((d) => within(r, join(ctx.homeReal, d)) || within(w, join(HOME, d)));
  const own = ctx.all.find((root) => within(r, root));
  // A private folder counts even under a session rooted at home, unless the session itself works inside it.
  if (dir && !(own && within(own, join(ctx.homeReal, dir)))) return listed(`~/${dir}`);
  if (!writes) return null;
  if (ctx.effects) {
    if (ctx.effects.unknown) return listed('a write after a segment with untracked filesystem effects');
    if ([...ctx.effects.paths].some((p) => within(r, p) || within(p, r))) return listed(`a write touching an earlier segment's path (${shown(w)})`);
    ctx.effects.pending.add(r);
  }
  if (!ctx.write.some((root) => within(r, root))) {
    const to = r === w ? shown(w) : `${shown(w)}, which resolves to ${shown(r)}`;
    return listed(own && ctx.broad.includes(own) ? `a write in a session whose folder is ${shown(own)}` : `a write outside the session's folder (${to})`);
  }
  if (r.split('/').includes('.git')) return listed(`git internals (${shown(w)})`);
  // Another hard link may expose the same file outside the permitted roots.
  const stat = await lstat(r).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (stat?.isFile() && stat.nlink > 1) return listed(`a write to a file with multiple hard links (${shown(w)})`);
  if (overwrite && stat) return listed(`overwriting an existing path (${shown(w)})`);
  return null;
}

type Word = { v: string; glob: boolean };
type Tok = { kind: 'word'; w: Word } | { kind: 'op'; op: string } | { kind: 'redir'; mode: 'w' | 'r' | 'dup'; fd: number; append?: boolean };

// Splits a command line into words, operators and redirections the way bash does before expansion. Every expansion
// and every construct it does not model is refused.
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const at = (s: string) => src.startsWith(s, i);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') unchecked('a comment');
    if (at('&>')) {
      const append = at('&>>');
      i += append ? 3 : 2;
      out.push({ kind: 'redir', mode: 'w', fd: 1, append });
      continue;
    }
    const red = /^(\d*)(<<<|<<|<>|<&|<\(|<|>>|>\||>&|>\(|>)/.exec(src.slice(i, i + 24));
    if (red) {
      const op = red[2];
      if (op === '<<' || op === '<<<') unchecked('a heredoc or herestring');
      if (op === '<(' || op === '>(') unchecked('process substitution');
      i += red[0].length;
      out.push({ kind: 'redir', mode: op === '<&' || op === '>&' ? 'dup' : op === '<' ? 'r' : 'w', fd: red[1] ? Number(red[1]) : op.startsWith('<') ? 0 : 1, append: op === '>>' });
      continue;
    }
    const op = ['&&', '||', ';;', '|&', '((', '|', '&', ';', '(', ')', '\n'].find(at);
    if (op) {
      if (op === ';;') unchecked('a case statement');
      if (op === '((') unchecked('arithmetic');
      out.push({ kind: 'op', op: op === '|&' ? '|' : op });
      i += op.length;
      continue;
    }
    let v = '';
    // The word's unquoted characters, quoted ones as \0, to find globs, braces and a leading tilde.
    let bare = '';
    while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
      const ch = src[i];
      if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) unchecked('an unclosed quote');
        v += src.slice(i + 1, end);
        bare += '\0'.repeat(end - i - 1);
        i = end + 1;
      } else if (ch === '"') {
        let j = i + 1;
        for (; j < src.length && src[j] !== '"'; j++) {
          if (src[j] === '\\') unchecked('a backslash escape');
          if (src[j] === '$' || src[j] === '`') unchecked('a variable or command substitution');
        }
        if (j >= src.length) unchecked('an unclosed quote');
        v += src.slice(i + 1, j);
        bare += '\0'.repeat(j - i - 1);
        i = j + 1;
      } else if (ch === '\\') {
        unchecked('a backslash escape or line continuation');
      } else if (ch === '$') {
        unchecked(src[i + 1] === "'" ? "a $'…' string" : 'a variable or command substitution');
      } else if (ch === '`') {
        unchecked('a command substitution');
      } else {
        v += ch;
        bare += ch;
        i++;
      }
    }
    if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare)) unchecked('brace expansion');
    if (bare.startsWith('~')) {
      if (!/^~(?:\/|$)/.test(bare)) unchecked('a ~user path');
      v = HOME + v.slice(1);
    }
    out.push({ kind: 'word', w: { v, glob: /[*?[]/.test(bare) } });
  }
  return out;
}

type Simple = { words: Word[]; redirs: { mode: 'w' | 'r' | 'dup'; fd: number; target: Word; append?: boolean }[] };
type Walk = { roots: Roots; depth: number };

// Walks a command line in order, following the working folder through cd, pushd, popd and subshells.
async function lineWhy(src: string, cwd: string | null, walk: Walk): Promise<string | null> {
  if (walk.depth > 3) unchecked('commands nested more than three deep');
  advanceEffects(walk.roots);
  const toks = tokenize(src);
  let bases = [cwd];
  let skipped: (string | null)[] = [];
  const scopes: (string | null)[][] = [];
  const pushed: (string | null)[][] = [];
  let cur: Simple = { words: [], redirs: [] };
  let pipeAt = 0;
  // At each operator: the simple command that just ended, checked; next is the operator after it.
  const end = async (next: string | null) => {
    const s = cur;
    cur = { words: [], redirs: [] };
    s.words = unwrap(s.words);
    if (!s.words.length && !s.redirs.length) return null;
    const name = s.words[0]?.v;
    if (name !== 'cd' && name !== 'pushd' && name !== 'popd') {
      for (const base of bases) {
        const why = await simpleWhy(s, base, walk, pipeAt > 0);
        if (why) return why;
      }
      advanceEffects(walk.roots);
      return null;
    }
    if (s.redirs.length) unchecked(`${name} with a redirection`);
    const args = s.words.slice(1);
    let k = 0;
    if (name !== 'popd') while (args[k] && /^-[LPe@]+$/.test(args[k].v)) k++;
    if (args[k]?.v === '--') k++;
    const rest = args.slice(k);
    if (rest.length > 1 || rest[0]?.glob || /^[-+]/.test(rest[0]?.v ?? '')) unchecked(`${name} ${rest.map((w) => w.v).join(' ')}`);
    let targets: (string | null)[];
    if (name === 'popd') {
      if (rest.length || !pushed.length) unchecked('popd without a matching pushd');
      targets = pushed.pop()!;
    } else {
      if (!rest[0]) unchecked(`${name} without a literal folder`);
      targets = [];
      for (const base of bases) {
        const raw = rest[0].v;
        const p = isAbsolute(raw) ? raw : base === null ? null : `${base}/${raw}`;
        const r = p === null ? null : await realpath(p).catch(() => null);
        if (r === null || !walk.roots.all.some((root) => within(r, root))) unchecked(`${name} outside the roots or to an unresolved folder`);
        targets.push(r);
      }
      if (name === 'pushd') pushed.push(bases);
    }
    // && reaches the new folder; later separators can also follow a skipped or failed cd.
    if (pipeAt === 0 && next !== '|' && next !== '&') {
      skipped = [...new Set([...skipped, ...bases])];
      bases = next === '&&' ? targets : [...new Set([...bases, ...targets])];
    }
    for (const target of targets) if (target !== null) walk.roots.effects?.pending.add(target);
    advanceEffects(walk.roots);
    return null;
  };
  for (const [k, t] of toks.entries()) {
    if (t.kind === 'word') {
      if (toks[k - 1]?.kind !== 'redir') cur.words.push(t.w);
      continue;
    }
    if (t.kind === 'redir') {
      const target = toks[k + 1];
      if (target?.kind !== 'word') unchecked('a redirection without a target');
      const w = (target as { w: Word }).w;
      cur.redirs.push({ mode: t.mode === 'dup' && !/^(?:\d+|-)$/.test(w.v) ? 'w' : t.mode, fd: t.fd, target: w, append: t.append });
      continue;
    }
    if (t.op === '(') {
      if (cur.words.length || cur.redirs.length) unchecked('a function definition or array');
      scopes.push(bases);
      continue;
    }
    const why = await end(t.op === ')' ? null : t.op);
    if (why) return why;
    if ([';', '\n', '||', '&'].includes(t.op)) bases = [...new Set([...bases, ...skipped])];
    pipeAt = t.op === '|' ? pipeAt + 1 : 0;
    if (t.op === ')') {
      if (!scopes.length) unchecked('an unbalanced parenthesis');
      bases = scopes.pop()!;
    }
  }
  const why = await end(null);
  if (why) return why;
  if (scopes.length) unchecked('an unclosed parenthesis');
  return null;
}

// Options before operands: each short cluster or long option, with the values of those listed as taking one.
function operands(args: Word[], values = '', longValues: string[] = [], trailing: 'stop' | 'hold' | 'parse' = 'stop') {
  const opts: { flag: string; value?: Word }[] = [];
  const rest: Word[] = [];
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k].v;
    if (a === '--') {
      k++;
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      if (trailing === 'parse') { rest.push(args[k]); continue; }
      if (trailing === 'hold' && args.slice(k + 1).some((w) => w.v.startsWith('-') && w.v !== '-')) unchecked('options after operands on a write-capable command');
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts.push({ flag: a.slice(0, eq), value: { v: a.slice(eq + 1), glob: args[k].glob } });
      else if (longValues.includes(a)) opts.push({ flag: a, value: args[++k] });
      else opts.push({ flag: a });
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      if (!values.includes(a[j])) {
        opts.push({ flag: `-${a[j]}` });
        continue;
      }
      opts.push({ flag: `-${a[j]}`, value: j + 1 < a.length ? { v: a.slice(j + 1), glob: args[k].glob } : args[++k] });
      break;
    }
  }
  if (opts.some((o) => (values.includes(o.flag.slice(1)) || longValues.includes(o.flag)) && !o.value)) unchecked('an option without its value');
  return { opts, rest: [...rest, ...args.slice(k)] };
}

const pathLike = (v: string) => v.includes('/') || v.startsWith('.') || v.startsWith('~') || SECRET.test(v);

// Every path-like argument and option value, checked as a read.
async function readsWhy(args: Word[], base: string | null, ctx: Roots) {
  for (const a of args) {
    const v = a.v.replace(/^--?[\w-]+=/, '').replace(/^@/, '');
    if (!v || (v.startsWith('-') && !v.includes('/'))) continue;
    const why = await pathWhy(v, base, ctx, false);
    if (why) return why;
  }
  return null;
}

async function writesWhy(paths: (Word | undefined)[], base: string | null, ctx: Roots, overwrite = false) {
  for (const p of paths) {
    if (!p) continue;
    const why = await pathWhy(p.v, base, ctx, true, overwrite);
    if (why) return why;
  }
  return null;
}

const assigned = (w: Word) => /^[A-Za-z_]\w*\+?=/.test(w.v);
function checkEnv(w: Word) {
  const name = w.v.slice(0, w.v.search(/\+?=/));
  if (DANGER_ENV.test(name)) unchecked(`setting ${name}`);
}

// Directory tracking and nested dispatch must see the same executable behind benign wrappers.
function unwrap(input: Word[]): Word[] {
  let words = input;
  for (; words[0] && assigned(words[0]); words = words.slice(1)) checkEnv(words[0]);
  // Prefixes that only change how the next word runs.
  for (;;) {
    const name = words[0]?.v;
    if (name === 'env') {
      let k = 1;
      let ended = false;
      for (; words[k]; k++) {
        const a = words[k].v;
        if (ended) {
          if (!assigned(words[k])) break;
          checkEnv(words[k]);
          continue;
        }
        if (a === '-i' || a === '--ignore-environment') unchecked('env clearing the execution environment');
        if (a === '--') { ended = true; continue; }
        if (a.startsWith('--unset=')) { checkEnv({ v: `${a.slice(8)}=`, glob: false }); continue; }
        if (a === '-u' || a === '--unset') {
          const key = words[++k]?.v ?? unchecked('env without an unset variable');
          checkEnv({ v: `${key}=`, glob: false });
          continue;
        }
        if (a.startsWith('-')) unchecked(`env ${a}`);
        if (!assigned(words[k])) break;
        checkEnv(words[k]);
      }
      words = words.slice(k);
    } else if (name === 'nice') {
      const { opts, rest } = operands(words.slice(1), 'n', ['--adjustment']);
      if (opts.some((o) => o.flag !== '-n' && o.flag !== '--adjustment')) unchecked('nice with an unknown option');
      words = rest;
    } else if (name === 'timeout') {
      const { opts, rest } = operands(words.slice(1), 'sk', ['--signal', '--kill-after']);
      if (opts.some((o) => !['-s', '-k', '--signal', '--kill-after', '--foreground', '--preserve-status', '-v', '--verbose'].includes(o.flag))) unchecked('timeout with an unknown option');
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(rest[0]?.v ?? '')) unchecked('timeout without a plain duration');
      words = rest.slice(1);
    } else if (name === 'nohup' || name === 'time') {
      words = words.slice(name === 'time' && words[1]?.v === '-p' ? 2 : 1);
      if (words[0]?.v.startsWith('-')) unchecked(`${name} with options that may change execution or output`);
    } else if (name === 'command') {
      if (words[1]?.v === '-v' || words[1]?.v === '-V') return [];
      words = words.slice(words[1]?.v === '-p' ? 2 : 1);
    } else break;
  }
  return words;
}

// Overwrite checks are separate from containment: existing project data still needs the user.
async function simpleWhy(s: Simple, base: string | null, walk: Walk, piped: boolean): Promise<string | null> {
  if (walk.depth > 3) unchecked('commands nested more than three deep');
  const ctx = walk.roots;
  for (const r of s.redirs) {
    if (r.mode === 'dup') continue;
    if (r.target.glob) unchecked('a pattern as a redirection target');
    const why = await pathWhy(r.target.v, base, ctx, r.mode === 'w', r.mode === 'w' && !r.append);
    if (why) return why;
  }
  const stdin = piped || s.redirs.some((r) => r.mode === 'r' && r.fd === 0);
  const words = unwrap(s.words);
  const exe = words[0];
  if (!exe) return null;
  if (exe.glob) unchecked('a pattern as the command');
  if (!exe.v) unchecked('an empty command name');
  const name = exe.v.includes('/') ? basename(exe.v) : exe.v;
  const args = words.slice(1);
  if (['cd', 'pushd', 'popd'].includes(name)) unchecked('a directory change outside the shell directory tracker');
  if (['rm', 'unlink', 'rmdir', 'truncate'].includes(name)) return listed(`${name} deletes or truncates data`);
  if (SYNTAX.has(exe.v) || exe.v.startsWith('{')) unchecked(`shell syntax (${exe.v})`);
  if (OPAQUE.has(name)) unchecked(`${name}, which runs or defines code the checker cannot see`);
  if (RUNNERS.has(name)) unchecked(`${name}, which runs another command`);
  if (exe.v.includes('/')) {
    if (WRITERS[name] || SHELLS.has(name) || INTERPRETERS[interpreterOf(name)] || DB_CLIENTS.has(name)
      || ['git', 'cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'sort', 'uniq', 'jq', 'less', 'find', 'xargs', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'curl', 'wget', 'tar', 'unzip', 'dd', 'env', 'command', 'time', 'nohup', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'docker', 'podman', 'nerdctl'].includes(name)) unchecked('an executable path impersonating a modelled command');
    const p = where(exe.v, base);
    const r = p === null ? null : await real(p);
    if (r === null || !ctx.all.some((root) => within(r, root))) unchecked('an executable outside the project roots');
    const why = await pathWhy(exe.v, base, ctx, false);
    if (why) return why;
  }
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(name)) for (const a of args) if (assigned(a)) checkEnv(a);
  if (name === 'git') return gitWhy(args, base, ctx);
  if (name === 'gh' && args[0]?.v === 'release' && ['list', 'view'].includes(args[1]?.v)) return readsWhy(args, base, ctx);
  if (name === 'systemctl') {
    const { opts, rest } = operands(args);
    if (opts.every((o) => ['--user', '--system', '--no-pager', '--no-legend', '--plain', '--all', '-a', '--full', '-l'].includes(o.flag))
      && ['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'is-failed'].includes(rest[0]?.v)) return readsWhy(rest, base, ctx);
  }
  const text = [name, ...args.map((a) => a.v)].join(' ');
  for (const r of COMMANDS) if (r.re.test(text) && !r.unless?.test(text)) return listed(r.name);
  const why = (await runsWhy(name, args, base, walk, stdin)) ?? (await writerWhy(name, args, base, ctx)) ?? (await readsWhy(args, base, ctx));
  if (!why && ctx.effects && !WRITERS[name] && !SHELLS.has(name)
    && !['dd', 'sed', 'find', 'xargs', 'npx', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'jq', 'less', 'ls', 'pwd', 'stat', 'du', 'file', 'echo', 'printf', ':', 'true', 'false', 'basename', 'dirname', 'readlink', 'realpath'].includes(name)) ctx.effects.pendingUnknown = true;
  return why;
}

// Commands whose arguments are code, another command or output paths: shells, interpreters, package runners, xargs,
// find, database clients, sed, awk, curl, wget, docker, tar.
async function runsWhy(name: string, args: Word[], base: string | null, walk: Walk, stdin: boolean): Promise<string | null> {
  const ctx = walk.roots;
  const positional = args.filter((a) => !a.v.startsWith('-')).map((a) => a.v);
  if (['make', 'gmake'].includes(name) && args.some((a) => a.v.includes('=') || /^--eval(?:=|$)|^-.*E/.test(a.v))) unchecked('make with inline code or recipe-variable overrides');
  if (name === 'kubectl' && positional.some((v) => ['exec', 'run', 'debug'].includes(v))) unchecked('kubectl executing code in an untracked remote context');
  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    const { opts, rest } = operands(args);
    if (opts.some((o) => !['-y', '--yes', '-s', '--silent', '-q', '--quiet', '--offline', '--prefer-offline', '--ignore-scripts'].includes(o.flag))) unchecked(`${name} with execution-changing global options`);
    const verb = rest[0]?.v;
    if (verb === 'dlx' || verb === 'create') unchecked(`${name} fetching executable code`);
    if (verb === 'exec' || verb === 'x') {
      const payload = rest.slice(1);
      if (name === 'npm') return npxWhy(payload, base, { ...walk, depth: walk.depth + 1 });
      const nested = payload[0]?.v === '--' ? payload.slice(1) : payload;
      if (!nested[0] || nested[0].v.startsWith('-')) unchecked(`${name} exec without a literal command`);
      advanceEffects(ctx);
      return simpleWhy({ words: nested, redirs: [] }, base, { ...walk, depth: walk.depth + 1 }, false);
    }
  }
  if (SHELLS.has(name)) {
    const { opts, rest } = operands(args, 'o', ['--rcfile', '--init-file']);
    if (opts.some((o) => ['--rcfile', '--init-file', '-l', '--login'].includes(o.flag))) unchecked(`${name} loading startup code`);
    if (opts.some((o) => o.flag === '-c')) {
      if (!rest[0]) unchecked(`${name} -c without a command`);
      return lineWhy(rest[0].v, base, { ...walk, depth: walk.depth + 1 });
    }
    if (opts.some((o) => o.flag === '-s' || o.flag === '-i') || !rest[0]) unchecked(`${name} reading commands from its input`);
    if (ctx.effects) ctx.effects.pendingUnknown = true;
    return pathWhy(rest[0].v, base, ctx, false);
  }
  const lang = interpreterOf(name);
  const spec = INTERPRETERS[lang];
  if (spec) {
    const { opts, rest } = operands(args, (spec.values ?? '') + (spec.module ?? '') + (spec.script ?? ''), spec.longValues);
    if (opts.some((o) => (o.flag.length === 2 && spec.code.includes(o.flag[1])) || spec.long?.includes(o.flag))) unchecked(`inline ${lang} code`);
    const module = spec.module && opts.some((o) => o.flag === `-${spec.module}`);
    const script = (spec.script && opts.find((o) => o.flag === `-${spec.script}`)?.value) || rest[0];
    if (module) return null;
    if (!script || script.v === '-') unchecked(`${lang} reading code from its input`);
    return pathWhy(script!.v, base, ctx, false);
  }
  if (name === 'deno') {
    if (!positional[0] || positional[0] === 'eval' || positional[0] === 'repl') unchecked('deno code the checker cannot see');
    if (args.some((a) => /^(?:https?|jsr|npm):/.test(a.v))) unchecked('deno running remote code');
    return null;
  }
  if (name === 'bun') {
    if (positional[0] === 'x' || positional[0] === 'create') unchecked(`bun ${positional[0]}, which downloads and runs a package`);
    if (args.some((a) => ['-e', '--eval', '-p', '--print'].includes(a.v))) unchecked('inline bun code');
    return null;
  }
  if (['bunx', 'pnpx', 'uvx'].includes(name)) unchecked(`${name}, which may download and run a package`);
  if ((name === 'pnpm' || name === 'yarn') && positional[0] === 'dlx') unchecked(`${name} dlx, which downloads and runs a package`);
  if (['npm', 'pnpm', 'yarn'].includes(name) && ['create', 'init'].includes(positional[0] ?? '') && positional[1]) unchecked(`${name} ${positional[0]} ${positional[1]}, which downloads a package`);
  if (name === 'pipx' && positional[0] === 'run') unchecked('pipx run, which downloads and runs a package');
  if (name === 'uv' && positional[0] === 'tool' && positional[1] === 'run') unchecked('uv tool run, which downloads and runs a package');
  if (name === 'npx') return npxWhy(args, base, walk);
  if (name === 'npm' && (args[0]?.v === 'exec' || args[0]?.v === 'x')) return npxWhy(args.slice(1), base, walk);
  if (name === 'xargs') {
    const known = ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-n', '-L', '-P', '-s', '-d', '-E', '-I', '-i', '-a'];
    const longValues = ['--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--eof', '--replace', '--arg-file'];
    const { opts, rest } = operands(args, 'nLPsdEIia', longValues);
    if (opts.some((o) => !known.includes(o.flag) && !longValues.includes(o.flag))) unchecked('xargs with an unknown option');
    const file = opts.find((o) => o.flag === '-a' || o.flag === '--arg-file')?.value;
    const why = file ? await pathWhy(file.v, base, ctx, false) : null;
    if (why || !rest.length) return why;
    advanceEffects(ctx);
    const inner = await simpleWhy({ words: rest, redirs: [] }, base, walk, false);
    if (inner) return inner;
    const innerName = basename(rest[0].v);
    if (!['cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'echo', 'ls', 'stat', 'du', 'file'].includes(innerName)) unchecked(`xargs feeding ${innerName} arguments the checker cannot see`);
    if (['sort'].includes(innerName) && rest.some((w) => /^-.*o|^--output/.test(w.v))) unchecked('xargs supplying a write target');
    return null;
  }
  if (name === 'find') {
    const starts: Word[] = [];
    let k = 0;
    for (; k < args.length && !/^[-(!)]/.test(args[k].v); k++) starts.push(args[k]);
    const first = await readsWhy(starts.map((w) => (pathLike(w.v) ? w : { ...w, v: `./${w.v}` })), base, ctx);
    if (first) return first;
    for (; k < args.length; k++) {
      const a = args[k].v;
      if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(a)) {
        const why = await writesWhy([args[k + 1] ?? { v: '', glob: false }], base, ctx, true);
        if (why) return why;
      }
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(a)) continue;
      const stop = args.findIndex((w, j) => j > k && (w.v === ';' || w.v === '+'));
      if (stop < 0) unchecked(`find ${a} without a plain ; or + at its end`);
      const inner = args.slice(k + 1, stop);
      if (!inner.length) unchecked(`find ${a} without a command`);
      if (a.endsWith('dir') || !['cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ls', 'stat', 'du', 'file'].includes(inner[0].v)) unchecked(`find ${a} with computed execution context or write targets`);
      // {} stands for each path found, which lies under one of the start folders.
      for (const from of starts.length ? starts : [{ v: '.', glob: false }]) {
        const why = await simpleWhy({ words: inner.map((w) => (w.v === '{}' ? from : w)), redirs: [] }, base, walk, false);
        if (why) return why;
      }
      k = stop;
    }
    return null;
  }
  if (DB_CLIENTS.has(name)) return dbWhy(name, args, base, ctx, stdin);
  if (name === 'sed') {
    const flags = args.flatMap((w) => {
      const m = /^-([nEr]*)i(.*)$/.exec(w.v);
      return m ? [...(m[1] ? [{ ...w, v: `-${m[1]}` }] : []), { ...w, v: `--in-place${m[2] ? `=${m[2]}` : ''}` }] : [w];
    });
    const { opts, rest } = operands(flags, 'efl', ['--expression', '--file', '--line-length'], 'hold');
    if (opts.some((o) => !['-n', '-E', '-r', '-i', '--quiet', '--silent', '--regexp-extended', '--in-place', '-e', '--expression', '-f', '--file', '-l', '--line-length', '-u', '--unbuffered', '-s', '--separate', '-z', '--null-data', '--sandbox', '--posix'].includes(o.flag))) unchecked('sed with an unmodelled option');
    if (opts.some((o) => o.flag === '-f' || o.flag === '--file')) unchecked('a sed script from a file');
    const given = opts.filter((o) => o.flag === '-e' || o.flag === '--expression').map((o) => o.value?.v ?? '');
    const scripts = given.length ? given : [rest[0]?.v ?? ''];
    if (scripts.some((sc) => sc.split(/[;\n]/).some((cmd) => !SED_SAFE.test(cmd)))) unchecked('a sed script beyond plain substitutions');
    const files = given.length ? rest : rest.slice(1);
    const inplace = opts.findLast((o) => o.flag === '-i' || o.flag === '--in-place');
    const suffix = inplace?.value?.v;
    if (suffix && /[/*?[]/.test(suffix)) unchecked('sed backup suffix selecting additional paths');
    return inplace ? writesWhy([...files, ...(suffix ? files.map((w) => ({ ...w, v: w.v + suffix })) : [])], base, ctx, true) : readsWhy(files, base, ctx);
  }
  if (['awk', 'gawk', 'mawk', 'nawk'].includes(name)) {
    const { opts, rest } = operands(args, 'Fvfi', ['--file', '--include', '--assign', '--field-separator'], 'hold');
    if (opts.some((o) => ['-f', '--file', '-i', '--include', '-E', '--exec'].includes(o.flag))) unchecked('an awk program from a file');
    if (/system|getline|[|>]|ENVIRON|PROCINFO|close|fflush/.test(rest[0]?.v ?? '')) unchecked('an awk program that runs commands or writes files');
    return readsWhy(rest.slice(1), base, ctx);
  }
  if (name === 'curl' || name === 'wget') return fetchWhy(name, args, base, ctx);
  if (['docker', 'podman', 'nerdctl'].includes(name)) return dockerWhy(args, base, ctx);
  if (name === 'tar') {
    const flagged = args.map((a, k) => (k === 0 && /^[a-zA-Z]+$/.test(a.v) ? { ...a, v: `-${a.v}` } : a));
    const { opts } = operands(flagged, 'fCbTX', ['--file', '--directory'], 'parse');
    const has = (...f: string[]) => opts.some((o) => f.includes(o.flag));
    if (has('-P', '--absolute-names')) unchecked('tar with absolute names');
    if (has('-x', '--extract', '--get', '--delete', '--overwrite', '--recursive-unlink', '--remove-files', '--checkpoint-action', '--to-command', '--use-compress-program', '-I')) unchecked('tar with input-selected writes, deletion or command execution');
    const dir = opts.find((o) => o.flag === '-C' || o.flag === '--directory')?.value ?? { v: '.', glob: false };
    const file = opts.find((o) => o.flag === '-f' || o.flag === '--file')?.value;
    return writesWhy([has('-x', '--extract', '--get') ? dir : undefined, has('-c', '-r', '-u', '--create', '--append', '--update') ? file : undefined], base, ctx, true);
  }
  if (name === 'unzip') {
    if (!args.some((a) => /^-[lZptv]+$/.test(a.v))) unchecked('unzip writes paths supplied by the archive');
    return readsWhy(args, base, ctx);
  }
  if (name === 'patch' || name === 'cpio') unchecked(`${name}, which writes the files its input names`);
  return null;
}

// npx runs a binary already in node_modules/.bin, or downloads the package; only the first is let through.
async function npxWhy(args: Word[], base: string | null, walk: Walk) {
  const { opts, rest } = operands(args, 'pc', ['--package', '--call']);
  if (opts.some((o) => !['-y', '--yes', '--no', '--no-install', '-q', '--quiet'].includes(o.flag))) unchecked(`npx with ${opts.map((o) => o.flag).join(' ')}`);
  const bin = rest[0]?.v ?? unchecked('npx without a command');
  if (!/^[\w.-]+$/.test(bin) || base === null) unchecked(`npx ${bin}, which may download a package`);
  let found = false;
  for (let d = base!; !found && walk.roots.all.some((r) => within(d, r)); d = dirname(d)) {
    found = await access(join(d, 'node_modules', '.bin', bin)).then(() => true, () => false);
    if (dirname(d) === d) break;
  }
  if (!found) unchecked(`npx ${bin}, which is not installed in the project and may be downloaded`);
  advanceEffects(walk.roots);
  return simpleWhy({ words: rest, redirs: [] }, base, walk, false);
}

// Inline SQL passes only when every statement is a plain read; strings and comments are blanked before matching.
function sqlWhy(sql: string) {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === '\\') unchecked('a backslash inside SQL text');
        if (sql[j] !== c) continue;
        if (sql[j + 1] !== c) break;
        j++;
      }
      if (j >= sql.length) unchecked('an unclosed SQL string');
      out += c === "'" ? "''" : ' x ';
      i = j + 1;
    } else if (sql.startsWith('/*', i)) {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) unchecked('an unclosed SQL comment');
      out += ' ';
      i = j + 2;
    } else if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      out += ' ';
      i = j < 0 ? sql.length : j;
    } else if (c === '#' || c === '$') {
      unchecked(`SQL with ${c}`);
    } else {
      out += c;
      i++;
    }
  }
  const flat = out.replace(/\s+/g, ' ').trim();
  if (/\bdrop\s+(?:table|database|schema|index|view|user|role|column|owned)\b/i.test(flat)) return listed('DROP');
  if (/\btruncate\b/i.test(flat)) return listed('TRUNCATE');
  if (/\bdelete\s+from\b(?![^;]*\bwhere\b)/i.test(flat)) return listed('DELETE FROM without WHERE');
  if (/^\\(?:d[a-zA-Z]*\+?|l\+?|x|conninfo)(?:\s+[\w.*]+)?$/.test(flat)) return null;
  const write = /\b(?:into|insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|call|do|lock|vacuum|set|reset|load|attach|detach|pragma|analyze|nextval|setval|lo_\w+|pg_\w+|dblink\w*|sleep|benchmark|outfile|dumpfile|load_file)\b/i;
  for (const st of flat.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (!/^(?:select|show|explain|describe|desc|values|table|with)\b/i.test(st) || write.test(st)) return listed('SQL that is not a plain read');
  }
  return null;
}

async function dbWhy(name: string, args: Word[], base: string | null, ctx: Roots, stdin: boolean) {
  if (name !== 'redis-cli' && args.length) unchecked(`${name} client options or query text may select output or execute database code`);
  const inline: string[] = [];
  const flags: Record<string, { code: string[]; file: string[] }> = {
    psql: { code: ['-c', '--command'], file: ['-f', '--file'] }, mysql: { code: ['-e', '--execute'], file: [] }, mariadb: { code: ['-e', '--execute'], file: [] },
    'clickhouse-client': { code: ['-q', '--query'], file: ['--queries-file'] }, sqlcmd: { code: ['-Q', '-q'], file: ['-i'] },
  };
  if (flags[name]) {
    const { code, file } = flags[name];
    for (const [k, a] of args.entries()) {
      const eq = a.v.indexOf('=');
      const long = a.v.startsWith('--');
      const flag = long ? (eq > 0 ? a.v.slice(0, eq) : a.v) : a.v.slice(0, 2);
      if (file.includes(flag)) unchecked(`SQL from a file (${name} ${flag})`);
      if (code.includes(flag)) inline.push((long ? (eq > 0 ? a.v.slice(eq + 1) : args[k + 1]?.v) : a.v.length > 2 ? a.v.slice(2) : args[k + 1]?.v) ?? '');
    }
  } else if (name === 'sqlite3' || name === 'duckdb') {
    const { opts, rest } = operands(args, '', ['-cmd', '-init', '-separator', '-newline', '-nullvalue']);
    if (opts.some((o) => o.flag === '-cmd' || o.flag === '-init')) unchecked(`${name} -cmd or -init`);
    const why = rest[0] ? await pathWhy(rest[0].v, base, ctx, true) : null;
    if (why) return why;
    if (rest[1]) inline.push(rest.slice(1).map((w) => w.v).join(' '));
    if (inline.some((sql) => /(?:^|;)\s*\./.test(sql))) unchecked(`${name} dot commands`);
  } else if (name === 'mongosh' || name === 'mongo') {
    if (stdin || args.some((a) => a.v === '--eval' || a.v.startsWith('--eval=') || a.v === '-f' || a.v === '--file')) unchecked(`JavaScript for ${name}`);
    return null;
  } else if (name === 'redis-cli') {
    const { rest } = operands(args, 'hpanusc', ['--user', '--pass', '--cacert', '--cert', '--key']);
    if (!rest[0]) return stdin ? unchecked('commands piped into redis-cli') : null;
    return REDIS_READS.has(rest[0].v.toLowerCase()) ? null : listed(`redis ${rest[0].v}`);
  }
  if (!inline.length && stdin) unchecked(`SQL piped into ${name}`);
  for (const sql of inline) {
    const why = sqlWhy(sql);
    if (why) return why;
  }
  return null;
}

async function fetchWhy(name: 'curl' | 'wget', args: Word[], base: string | null, ctx: Roots) {
  const curl = name === 'curl';
  const longValues = curl
    ? ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--hsts', '--alt-svc', '--config', '--data', '--header', '--user', '--cookie', '--url', '--request', '--form', '--upload-file']
    : ['--output-document', '--directory-prefix', '--output-file', '--append-output', '--save-cookies', '--input-file', '--execute', '--header', '--user-agent'];
  const { opts, rest } = operands(args, curl ? 'oDcKbdHuAeExXTrwmFy' : 'OPoaieUtTwQlA', longValues, 'parse');
  const pick = (...f: string[]) => opts.filter((o) => f.includes(o.flag));
  if (pick(...(curl ? ['-K', '--config'] : ['-e', '--execute'])).length) unchecked(`${name} reading options or commands it does not show`);
  if (curl ? pick('-O', '--remote-name', '--remote-name-all', '-J', '--remote-header-name').length : !pick('-O', '--output-document').length) unchecked(`${name} writes filenames selected by the response or URL`);
  const here = { v: '.', glob: false };
  const out = curl
    ? [...pick('-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--hsts', '--alt-svc', '--output-dir').map((o) => o.value),
        ...(pick('-O', '--remote-name', '--remote-name-all', '-J').length ? [here] : [])]
    : [...pick('-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '--save-cookies').map((o) => o.value),
        ...(pick('-O', '--output-document').length ? [] : [here])];
  const why = await writesWhy(out, base, ctx, true);
  return why ?? readsWhy([...opts.flatMap((o) => (o.value ? [o.value] : [])), ...rest.filter((w) => !/^[a-z]+:\/\//i.test(w.v))], base, ctx);
}

// A container sees the host only through its mounts, so each bind source must lie in the session's folder.
async function dockerWhy(args: Word[], base: string | null, ctx: Roots) {
  const subs = args.filter((a) => !a.v.startsWith('-')).map((a) => a.v);
  const sub = subs[0] === 'container' || subs[0] === 'compose' ? subs[1] : subs[0];
  if (subs.some((s) => ['exec', 'run', 'create'].includes(s))) unchecked('container command payload in an untracked filesystem');
  if (sub === 'cp') return writesWhy(args.filter((a) => !a.v.startsWith('-') && !['cp', 'container'].includes(a.v) && !/^[\w.-]+:/.test(a.v)), base, ctx);
  if (sub !== 'run' && sub !== 'create') return null;
  for (const [k, a] of args.entries()) {
    const v = a.v;
    if (v === '--privileged' || /^--(?:pid|userns|uts|ipc|cap-add|device|security-opt|volumes-from)(?:=|$)/.test(v)) return listed(`a container with host access (${v})`);
    const value = (short: string, long: string) =>
      v === short || v === long ? args[k + 1]?.v : v.startsWith(`${long}=`) ? v.slice(long.length + 1) : !v.startsWith('--') && v.startsWith(short) && v.length > 2 ? v.slice(2) : undefined;
    const vol = value('-v', '--volume');
    const mount = value('--mount', '--mount');
    const host = vol !== undefined ? vol.split(':')[0] : mount !== undefined ? /(?:^|,)(?:source|src)=([^,]+)/.exec(mount)?.[1] : undefined;
    if (mount !== undefined && host === undefined && !/(?:^|,)type=(?:volume|tmpfs)(?:,|$)/.test(mount)) unchecked('a container mount without a plain source');
    if (host === undefined || !/^[/.~]/.test(host)) continue;
    if (await pathWhy(host, base, ctx, true)) return listed(`a container mount outside the session's folder (${host})`);
  }
  return null;
}

async function writerWhy(name: string, args: Word[], base: string | null, ctx: Roots) {
  if (name === 'sort' || name === 'less') {
    const { opts } = operands(args, name === 'sort' ? 'otT' : 'oO', name === 'sort' ? ['--output', '--temporary-directory'] : ['--log-file', '--LOG-FILE'], 'parse');
    for (const o of opts.filter((o) => ['-o', '-O', '-T', '--output', '--temporary-directory', '--log-file', '--LOG-FILE'].includes(o.flag))) {
      const why = await writesWhy([o.value], base, ctx, !['-T', '--temporary-directory'].includes(o.flag));
      if (why) return why;
    }
    return null;
  }
  if (name === 'dd') {
    for (const a of args) {
      if (!a.v.startsWith('of=') && !a.v.startsWith('if=')) continue;
      const append = args.some((w) => /^oflag=.*\bappend\b/.test(w.v)) && args.some((w) => /^conv=.*\bnotrunc\b/.test(w.v));
      const why = await pathWhy(a.v.slice(3), base, ctx, a.v.startsWith('of='), a.v.startsWith('of=') && !append);
      if (why) return why;
    }
    return null;
  }
  const spec = WRITERS[name];
  if (!spec) return null;
  const { opts, rest } = operands(args, spec.values, ['--target-directory', '--reference', '--suffix', '--mode', '--date', '--time', '--size'], 'parse');
  if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(name) && opts.some((o) => ['-r', '-R', '-a', '--recursive', '--archive', '--parents', '--backup', '-b', '-S', '--suffix', '--link-dest', '--copy-dest', '--compare-dest', '--backup-dir', '--temp-dir', '--partial-dir', '--log-file', '--files-from', '--rsync-path', '-e'].includes(o.flag)
    || (o.flag.startsWith('--target') && o.flag !== '--target-directory'))) unchecked(`${name} with additional or recursively selected write targets`);
  const targets = opts.filter((o) => (spec.target && o.flag === `-${spec.target}`) || o.flag === '--target-directory').map((o) => o.value);
  const ops = spec.skip1 && !opts.some((o) => o.flag === '--reference') ? rest.slice(1) : rest;
  const writes = !spec.last ? ops : targets.length ? [] : ops.slice(-1);
  const why = await writesWhy([...targets, ...writes], base, ctx);
  if (why) return why;
  if (name === 'tee') return writesWhy(ops, base, ctx, !opts.some((o) => o.flag === '-a' || o.flag === '--append'));
  if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(name)) {
    const dest = targets[0] ?? ops.at(-1);
    const literal = dest && where(dest.v, base);
    const to = literal && await real(literal);
    if (to && await lstat(to).then((s) => s.isDirectory(), () => false)) {
      for (const source of targets.length ? ops : ops.slice(0, -1)) {
        const why = await pathWhy(join(to, basename(source.v)), base, ctx, true, true);
        if (why) return why;
      }
    } else if (dest) return pathWhy(dest.v, base, ctx, true, true);
  }
  return readsWhy(spec.last ? (targets.length ? ops : ops.slice(0, -1)) : [], base, ctx);
}

async function gitWhy(args: Word[], base: string | null, ctx: Roots) {
  let k = 0;
  let dir = base;
  for (; args[k]?.v.startsWith('-'); k++) {
    const a = args[k].v;
    if (a !== '-C' && !a.startsWith('-C') && !/^--(?:git-dir|work-tree)(?:=|$)/.test(a)) {
      if (!GIT_SAFE_OPTS.has(a)) unchecked(`git ${a}`);
      continue;
    }
    const value = a.startsWith('-C') && a.length > 2 ? a.slice(2) : a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++k]?.v;
    if (!value || /[*?[]/.test(value)) unchecked('git with no plain repository folder');
    const p = isAbsolute(value!) ? value! : dir === null ? null : `${dir}/${value}`;
    const r = p === null ? null : await realpath(p).catch(() => null);
    if (r === null || !ctx.all.some((root) => within(r, root))) unchecked('git repository folder outside the roots or unresolved');
    if (a.startsWith('-C') || a.startsWith('--work-tree')) dir = r;
  }
  const sub = args[k]?.v;
  if (!sub) return null;
  if (ctx.effects && !['status', 'diff', 'show', 'log', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'version', 'describe', 'show-ref'].includes(sub)) ctx.effects.pendingUnknown = true;
  if (!GIT_KNOWN.has(sub)) unchecked(`git ${sub}, which is not a known git command (it may be an alias)`);
  if (dir !== base) {
    const r = dir === null ? null : await real(dir);
    if (r === null) unchecked('git -C with a folder it cannot resolve');
    if (!ctx.all.some((root) => within(r!, root))) return listed(`git in a folder outside the session's folder (${shown(dir!)})`);
  }
  const rest = args.slice(k + 1);
  const vs = rest.map((a) => a.v);
  if (sub === 'rm') return listed('git rm deletes worktree files');
  if (sub === 'worktree' && vs[0] !== 'add' && vs[0] !== 'list') unchecked('git worktree mutation may remove or relocate files');
  const { opts } = operands(rest, sub === 'checkout' || sub === 'switch' ? 'bBcC' : '', ['--output'], 'parse');
  if ((sub === 'checkout' || sub === 'switch') && opts.some((o) => ['-B', '-C', '-f', '--force', '--force-create', '--discard-changes', '-m', '--merge', '--orphan'].includes(o.flag))) return listed(`git ${sub} replacing branches or discarding work`);
  if (sub === 'checkout' && !opts.some((o) => o.flag === '-b')) unchecked('git checkout may replace worktree files; only new-branch checkout is offered');
  if (sub === 'fetch' && vs.some((v) => /^\+|^--(?:force|prune)|^-[^-]*[fp]/.test(v))) return listed('git fetch rewriting or pruning refs');
  if ((sub === 'stash' && vs.some((v) => v === 'drop' || v === 'clear'))
    || (sub === 'reflog' && vs.some((v) => v === 'expire' || v === 'delete'))
    || (sub === 'remote' && vs.some((v) => v === 'remove' || v === 'rm' || v === 'prune'))
    || (sub === 'notes' && vs.some((v) => v === 'remove' || v === 'prune'))) return listed(`git ${sub} deleting saved refs or work`);
  for (let j = 0; j < rest.length; j++) {
    const v = rest[j].v;
    if (v === '--') break;
    const output = /^--output(?:=|$)/.test(v) || (['diff', 'show', 'log', 'format-patch'].includes(sub) && /^-o/.test(v));
    if (!output) continue;
    const value = v.includes('=') ? v.slice(v.indexOf('=') + 1) : v.startsWith('-o') && v.length > 2 ? v.slice(2) : rest[++j]?.v;
    if (!value) unchecked('git output without a literal path');
    const why = await pathWhy(value!, dir, ctx, true, true);
    if (why) return why;
  }
  if (sub === 'config' && !vs.some((v) => /^(?:--(?:get|get-all|get-regexp|list|show-origin|show-scope)|-l)$/.test(v))) unchecked('git config that changes settings');
  if (sub === 'submodule' && vs.includes('foreach')) unchecked('git submodule foreach');
  if (sub === 'rebase' && vs.some((v) => v === '-x' || v.startsWith('--exec'))) unchecked('git rebase --exec');
  if (sub === 'bisect' && vs[0] === 'run') unchecked('git bisect run');
  const text = ['git', sub, ...vs].join(' ');
  for (const r of COMMANDS) if (r.re.source.startsWith('^git') && r.re.test(text)) return listed(r.name);
  if (sub === 'clone' || sub === 'init' || (sub === 'worktree' && vs[0] === 'add')) {
    const values = sub === 'clone' ? 'bo' : sub === 'init' ? 'b' : 'bB';
    const longValues = sub === 'clone' ? ['--branch', '--origin', '--depth', '--filter'] : sub === 'init' ? ['--initial-branch'] : ['--reason'];
    const flags = sub === 'clone'
      ? ['-b', '-o', '-q', '--quiet', '-v', '--verbose', '-n', '--no-checkout', '--bare', '--mirror', '--single-branch', '--no-single-branch', '--no-tags', '--progress']
      : sub === 'init' ? ['-b', '-q', '--quiet', '--bare'] : ['-b', '-B', '-f', '--force', '--detach', '--checkout', '--no-checkout', '--lock'];
    const parsed = operands(sub === 'worktree' ? rest.slice(1) : rest, values, longValues, 'parse');
    if (parsed.opts.some((o) => !flags.includes(o.flag) && !longValues.includes(o.flag))) unchecked(`git ${sub} with unparsed option operands`);
    if (sub === 'worktree' && parsed.opts.some((o) => ['-B', '-f', '--force'].includes(o.flag))) return listed('git worktree replacing branches or work');
    if (parsed.rest.length > (sub === 'init' ? 1 : 2)) unchecked(`git ${sub} with ambiguous destinations`);
    let target: string | undefined = sub === 'clone' ? parsed.rest[1]?.v : parsed.rest[0]?.v;
    if (sub === 'clone' && !target) {
      const repo = parsed.rest[0]?.v ?? unchecked('git clone without a repository');
      target = repo.replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '');
      if (!target || !/^[\w.-]+$/.test(target) || target === '.' || target === '..') unchecked('git clone without a literal destination');
      if (parsed.opts.some((o) => o.flag === '--bare' || o.flag === '--mirror')) target += '.git';
    }
    if (!target && sub === 'worktree') unchecked('git worktree add without a destination');
    return pathWhy(target ?? '.', dir, ctx, true, true);
  }
  // A message is not a path; path-like words are read-checked (git add .env, git show HEAD:.env).
  return readsWhy(rest.filter((a, j) => !['-m', '--message', '-F'].includes(rest[j - 1]?.v ?? '') && !a.v.startsWith('-m')), dir, ctx);
}

const FILE_TOOLS = /^(?:Read|Grep|Glob|Edit|MultiEdit|Write|NotebookEdit)$/;
const EDITS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/;

// Why an ask stays with the user under auto-approve, or null when the commander may judge it. roots: the asking
// session's folder and its worktree; the first is where relative paths start. Runs once per ask, so it may read the disk.
export async function destructive(f: AskFacts | undefined, roots: string[]): Promise<string | null> {
  if (!f) return 'Not a command or file change the checker can read';
  if (f.grantRoot) return `Asks for write access to a whole folder (${shown(f.grantRoot)})`;
  const ctx = await rootsOf(roots);
  const cwd = f.cwd ?? roots[0] ?? null;
  try {
    if (f.tool === 'Bash') {
      ctx.effects = { paths: new Set(), pending: new Set(), unknown: false, pendingUnknown: false };
      return f.command?.trim() ? await lineWhy(f.command, cwd, { roots: ctx, depth: 0 }) : 'No command to check';
    }
    if (!FILE_TOOLS.test(f.tool)) return `Not a command or file change the checker can read (${f.tool})`;
    const writes = EDITS.test(f.tool);
    if (!f.paths?.length) return 'No file path to check';
    for (const p of f.paths ?? []) {
      const why = await pathWhy(p, cwd, ctx, writes, f.tool === 'Write');
      if (why) return why;
    }
    return null;
  } catch (err) {
    if (err instanceof Unchecked) return err.message;
    throw err;
  }
}
