// Absolute path from what was typed: "~/x", "/x", or relative to `base`; "." and ".." are folded.
export function resolvePath(typed: string, base: string, home: string) {
  const abs = typed === '~' || typed.startsWith('~/') ? home + typed.slice(1) : typed.startsWith('/') ? typed : `${base}/${typed}`;
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export const parentOf = (path: string) => (path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/');

// Internal checkout storage must not make unrelated projects match a folder search.
export function searchPath(path: string, home: string) {
  for (const app of ['claude-web', 'tarcsweb']) {
    const root = `${home}/.cache/${app}/worktrees/`;
    if (path.startsWith(root)) return path.slice(root.length);
  }
  return path;
}

// Every level from ~ (or /) down to `path`, for the breadcrumb after a typed jump.
export function chainTo(path: string, home: string) {
  const root = home && (path === home || path.startsWith(home + '/')) ? home : '/';
  const out = [root];
  for (const seg of path.slice(root.length).split('/').filter(Boolean)) out.push(`${out.at(-1) === '/' ? '' : out.at(-1)}/${seg}`);
  return out;
}

export const levelLabel = (path: string, home: string) => (path === home ? '~' : path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1));
