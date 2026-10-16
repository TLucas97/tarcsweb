// Material Icon Theme lookup, loaded lazily by the file tree; each SVG is fetched only when a row shows it.
import { fileExtensions, fileNames, folderNames, light } from '../../node_modules/material-icon-theme/dist/material-icons.json';

const DIR = '../../node_modules/material-icon-theme/icons/';
const svgs = import.meta.glob<string>('../../node_modules/material-icon-theme/icons/*.svg', { query: '?url', import: 'default' });

type Map = Record<string, string>;
const pick = (a: Map, b: Map, k: string) => a[k] ?? b[k];

// Same order VS Code uses: exact file name, then the longest matching extension ("d.ts" before "ts").
// The default maps are the dark-editor set; light swaps in `*_light` variants on top.
export function iconName(name: string, dir: boolean, open: boolean, dark = false) {
  const n = name.toLowerCase();
  const look = (l: Map, d: Map, k: string) => (dark ? d[k] : pick(l, d, k));
  if (dir) {
    const base = look(light.folderNames as Map, folderNames as Map, n) ?? 'folder';
    if (!open) return base;
    return dark ? `${base}-open` : base.replace(/(_light)?$/, '-open$1');
  }
  const byName = look(light.fileNames as Map, fileNames as Map, n);
  if (byName) return byName;
  for (let i = n.indexOf('.'); i >= 0; i = n.indexOf('.', i + 1)) {
    const hit = look(light.fileExtensions as Map, fileExtensions as Map, n.slice(i + 1));
    if (hit) return hit;
  }
  return 'file';
}

export function iconUrl(icon: string): Promise<string | null> {
  const load = svgs[`${DIR}${icon}.svg`];
  return load ? load() : Promise.resolve(null);
}
