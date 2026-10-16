import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

export function oneLine(s: string, max = 140) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// Inside the project: relative; under home: ~/...; else as is.
export function displayPath(cwd: string, path: string) {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  const home = homedir();
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}
