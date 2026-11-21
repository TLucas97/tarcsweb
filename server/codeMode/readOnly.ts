type Options = { short?: string; long?: string; numeric?: string };

const options: Record<string, Options> = {
  ls: { short: '1aAdFhlrSt', long: '--all --almost-all --classify --directory --human-readable --reverse' },
  cat: { short: 'AbEensTtuv', long: '--number --number-nonblank --show-all --show-ends --show-tabs --squeeze-blank' },
  head: { short: 'qv', long: '--quiet --silent --verbose', numeric: '-n -c --lines --bytes' },
  tail: { short: 'qv', long: '--quiet --silent --verbose', numeric: '-n -c --lines --bytes' },
  wc: { short: 'clLmw', long: '--bytes --chars --lines --max-line-length --words' },
  pwd: { short: 'LP' },
  echo: { short: 'eEn' },
  printf: {},
  which: { short: 'a', long: '--all' },
  file: { short: 'bhiLNv', long: '--brief --mime --mime-type --mime-encoding --dereference --no-dereference' },
  stat: { short: 'fLt', long: '--file-system --dereference --terse' },
  du: { short: 'achskmx', long: '--all --apparent-size --human-readable --one-file-system --summarize --total', numeric: '-d --max-depth' },
  df: { short: 'ahilPT', long: '--all --human-readable --inodes --local --portability --print-type' },
  date: { short: 'Iu', long: '--iso-8601 --utc --universal' },
  uname: { short: 'amnrspvio', long: '--all --machine --nodename --kernel-release --kernel-name --kernel-version --processor --hardware-platform --operating-system' },
  grep: { short: 'abcEFHhilnoqrsvwx', long: '--count --extended-regexp --fixed-strings --ignore-case --line-number --only-matching --quiet --recursive --word-regexp', numeric: '-A -B -C -m --after-context --before-context --context --max-count' },
  rg: { short: 'abcFHhilnoqsvwx', long: '--count --files --fixed-strings --hidden --ignore-case --line-number --no-config --no-ignore --only-matching --quiet --word-regexp', numeric: '-A -B -C -m --after-context --before-context --context --max-count' },
  sort: { short: 'bCcdfgiMhnruV', long: '--check --check=diagnose-first --check=quiet --check=silent --ignore-case --numeric-sort --reverse --unique' },
  uniq: { short: 'cdiu', long: '--count --repeated --ignore-case --unique', numeric: '-f -s -w --skip-fields --skip-chars --check-chars' },
  diff: { short: 'abBiqsuw', long: '--brief --ignore-case --ignore-all-space --ignore-blank-lines --report-identical-files --unified', numeric: '-U --width' },
  cmp: { short: 'bls', long: '--print-bytes --verbose --silent --quiet', numeric: '-n --bytes' },
  realpath: { short: 'ePq', long: '--canonicalize-existing --physical --quiet' },
  dirname: { short: 'z', long: '--zero' },
  basename: { short: 'z', long: '--zero' },
};

const lookup = (list: string | undefined, flag: string) => list?.split(' ').includes(flag) ?? false;

function operandsFor(args: string[], spec: Options) {
  const flags = new Set<string>();
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return { flags, operands: args.slice(index + 1) };
    if (arg === '-' || !arg.startsWith('-')) break;
    if (lookup(spec.long, arg)) {
      flags.add(arg);
      continue;
    }
    const [flag, attached] = arg.startsWith('--')
      ? arg.split(/=(.*)/s, 2) : [arg.slice(0, 2), arg.slice(2) || undefined];
    if (lookup(spec.numeric, flag)) {
      const value = attached ?? args[++index];
      if (!value || !/^\d+$/.test(value)) return undefined;
    } else {
      const letters = arg.slice(1);
      if (!/^[A-Za-z0-9]+$/.test(letters) || [...letters].some((letter) => !spec.short?.includes(letter))) return undefined;
      for (const letter of letters) flags.add('-' + letter);
    }
  }
  const operands = args.slice(index);
  if (operands.some((operand) => operand !== '-' && operand.startsWith('-'))) return undefined;
  return { flags, operands };
}

type ReadOnlyPaths = { paths: string[]; filesOnly?: boolean };

export function readOnlyPaths(command: string): ReadOnlyPaths | undefined {
  const program = /^[a-z]+(?=[ \t]|$)/.exec(command)?.[0];
  if (!program || !Object.hasOwn(options, program)) return undefined;

  // splitShell has already rejected substitutions, redirections and unquoted globs.
  const words = command.slice(program.length).match(/(?:[^ \t\n'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  if (words.some((word) => /^=|[~^]/.test(word.replace(/'[^']*'|"[^"]*"/g, '')))) return undefined;
  const args = words.map((word) => word.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
  const parsed = operandsFor(args, options[program]);
  if (!parsed) return undefined;
  const { flags, operands } = parsed;
  const [first] = operands;
  switch (program) {
    case 'pwd':
    case 'uname':
      return operands.length === 0 ? { paths: [] } : undefined;
    case 'echo':
      return { paths: [] };
    case 'printf':
      return first !== undefined && !first.replace(/%%|%[sbcdiouxX]/g, '').includes('%') ? { paths: [] } : undefined;
    case 'date':
      return operands.length === 0 || (operands.length === 1 && first.startsWith('+')) ? { paths: [] } : undefined;
    case 'which':
      return operands.every((name) => /^[\w.+][\w.+-]*$/.test(name)) ? { paths: [] } : undefined;
    case 'df':
      return operands.length || flags.has('-l') || flags.has('--local') ? { paths: operands } : undefined;
    case 'ls':
    case 'du':
      return { paths: operands.length ? operands : ['.'] };
    case 'sort':
      // Sorting can spill to temporary files. Checking order only reads input.
      if (![...flags].some((flag) => flag === '-c' || flag === '-C' || flag.startsWith('--check'))) return undefined;
      break;
    case 'uniq':
      if (operands.length > 1) return undefined;
      break;
    case 'diff':
    case 'cmp':
      if (operands.length !== 2) return undefined;
      return { paths: operands.filter((path) => path !== '-'), filesOnly: true };
    case 'basename':
    case 'dirname':
      if (operands.length === 0 || (program === 'basename' && operands.length > 2)) return undefined;
      return { paths: program === 'basename' ? [first] : operands };
    case 'rg': {
      if (process.env.RIPGREP_CONFIG_PATH && !flags.has('--no-config')) return undefined;
      if (flags.has('--files')) return { paths: operands.length ? operands : ['.'] };
      if (first === undefined) return undefined;
      const paths = operands.slice(1);
      return { paths: paths.length ? paths.filter((path) => path !== '-') : ['.'] };
    }
    case 'grep': {
      if (first === undefined) return undefined;
      const recursive = flags.has('-r') || flags.has('--recursive');
      const paths = operands.length > 1 ? operands.slice(1) : recursive ? ['.'] : [];
      return { paths: paths.filter((path) => path !== '-') };
    }
  }
  const readsStdin = ['cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'file'].includes(program);
  return { paths: readsStdin ? operands.filter((path) => path !== '-') : operands };
}
