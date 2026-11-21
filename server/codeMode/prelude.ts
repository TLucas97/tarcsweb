export const MAX_HOST_ARGS_BYTES = 256 * 1024;
export const HOST_ARGS_TOO_LARGE = 'Host tool arguments exceed 256 KiB';

export const GUEST_API = `// Write the body of an async function. Use await and return.
const r = await $\`git status --short\`; // { stdout, stderr, exitCode, interrupted }; nonzero exit throws ShellError with code and stderr tail
await $\`npm test\`.nothrow(); // allow nonzero exits
await $\`ls src\`.text(); // stdout without the final newline
await $\`ls src\`.lines(); // nonempty stdout lines
await $\`cat package.json\`.json(); // parsed stdout
await $\`make\`.timeout(300000); // ms, max 600000, defaults to host default
await $\`ls\`.cwd('web'); // runs cd 'web' && ls
await $('git log -1 --oneline'); // runs plain string as-is
// The template text is raw, like typing in a shell: backslashes stay as written.
// Template interpolations are single-quoted. Arrays expand to separate quoted args.
// Chain modifiers before awaiting. Each shell call runs once, when first awaited or .then() is called.
await read('src/a.ts'); // file text, throws if missing
await read('src/a.ts', { offset, limit }); // 1-based line window
await glob('src/**/*.ts', { path }); // matching paths as string[] (options optional)
await grep('TODO', { path, glob, type, ignoreCase, context, before, after, filesOnly, count, multiline, limit }); // ripgrep-style output string (options optional)
console.log(...); // also info, warn, error, debug`;

export const PRELUDE = String.raw`(function (dispatch, log) {
  'use strict';
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const asString = String;
  const ErrorClass = Error;
  const AsyncFunction = (async function () {}).constructor;

  async function host(tool, args) {
    const reply = parse(await dispatch(tool, stringify(args)));
    if (!reply.ok) throw new ErrorClass(reply.error);
    return reply.data;
  }

  function quote(value) {
    return "'" + asString(value).replace(/'/g, "'\\''") + "'";
  }

  class ShellError extends ErrorClass {
    constructor(result) {
      const tail = result.stderr.trimEnd().split(/\r?\n/).slice(-5).join('\n').slice(-2000);
      super('Shell exited with code ' + result.exitCode + (tail ? '\n' + tail : ''));
      this.name = 'ShellError';
      Object.assign(this, result);
    }
  }

  function $(template, ...values) {
    let command = template;
    // The raw text, so backslashes reach the shell as typed (\[ in a regex stays \[).
    if (typeof template !== 'string') {
      const raw = template.raw;
      command = raw[0];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        command += (Array.isArray(value) ? value.map(quote).join(' ') : quote(value)) + raw[i + 1];
      }
    }

    let pending;
    let allowFailure = false;
    let cwd;
    let timeout;
    let transform = result => result;
    const thenable = {
      nothrow() { allowFailure = true; return thenable; },
      cwd(path) { cwd = path; return thenable; },
      timeout(ms) {
        if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('Shell timeout must be positive');
        timeout = Math.min(600000, Math.ceil(ms));
        return thenable;
      },
      text() { transform = result => result.stdout.replace(/\r?\n$/, ''); return thenable; },
      lines() { transform = result => result.stdout.split(/\r?\n/).filter(Boolean); return thenable; },
      json() { transform = result => parse(result.stdout); return thenable; },
      then(resolve, reject) {
        pending ??= host('Bash', { command: cwd === undefined ? command : 'cd ' + quote(cwd) + ' && ' + command, timeout }).then(result => {
          if (result.truncated) note('$ ' + command, 'output cut to 30k chars; filter it in the command (grep, head, wc)');
          return result;
        });
        const select = transform;
        const ignoreExit = allowFailure;
        return pending.then(result => {
          if (!ignoreExit && result.exitCode !== 0) throw new ShellError(result);
          return select(result);
        }).then(resolve, reject);
      },
    };
    return thenable;
  }

  // A cut the program did not ask for goes to Logs, never into the data it parses.
  function note(what, why) {
    print('[cut] ' + asString(what).slice(0, 120) + ': ' + why);
  }

  async function read(file_path, { offset, limit } = {}) {
    const r = await host('Read', { file_path, offset, limit });
    if (r.capped) note(file_path, 'the file is ' + (r.capped / 1048576).toFixed(1) + ' MB and read() sees only its first 5 MB; use the shell (tail, sed -n, grep) for the rest');
    if (r.cut) note(file_path, 'lines over 2000 chars lost their end; filter the file in the shell instead');
    else if (r.truncated && !r.capped && limit === undefined) note(file_path, 'returned the first 2000 of ' + r.totalLines + ' lines; pass { offset, limit } for more');
    return r.text;
  }

  async function glob(pattern, { path } = {}) {
    const r = await host('Glob', { pattern, path });
    if (r.truncated) note(pattern, 'only the first ' + r.files.length + ' matches; narrow the pattern or path');
    return r.files;
  }

  async function grep(pattern, options = {}) {
    const { path, glob, type, ignoreCase, context, before, after, filesOnly, count, multiline, limit } = options;
    const output_mode = filesOnly ? 'files_with_matches' : count ? 'count' : 'content';
    const r = await host('Grep', {
      pattern, path, glob, type, output_mode, '-i': ignoreCase, '-n': output_mode === 'content' || undefined,
      '-C': context, '-B': before, '-A': after, multiline, head_limit: limit,
    });
    if (r.truncated && limit === undefined) note(pattern, 'output cut; narrow the pattern, path or glob, or use filesOnly or count');
    return r.output;
  }

  function encode(value) {
    return stringify(value, (_, item) => {
      switch (typeof item) {
        case 'function': return '[Function]';
        case 'symbol': return asString(item);
        case 'bigint': return asString(item) + 'n';
        default: return item;
      }
    });
  }

  function print(...values) {
    let line = '';
    for (let i = 0; i < values.length && line.length <= 2000; i++) {
      const value = values[i];
      let text;
      try { text = typeof value === 'string' ? value : encode(value) ?? 'undefined'; }
      catch { text = '[Unserializable value]'; }
      if (i > 0) line += ' ';
      line += text.slice(0, 2001 - line.length);
    }
    const clipped = line.length > 2000;
    log(stringify([clipped ? line.slice(0, 1997) + '...' : line, clipped]));
  }

  Object.assign(globalThis, { $, read, glob, grep, console: { log: print, info: print, warn: print, error: print, debug: print } });
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;

  return {
    start: source => new AsyncFunction('"use strict";\n' + parse(source))(),
    encode,
    describe(error) {
      const message = asString(error).slice(0, 2000);
      const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 2000) : '';
      return stringify({ message, stack });
    },
  };
})`;
