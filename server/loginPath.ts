import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

const WAIT_MS = 3000;

let loaded = false;
export async function enrichLoginPath() {
  if (loaded) return;
  loaded = true;
  if (process.env.CW_SHELL !== 'tauri' || !['linux', 'darwin'].includes(process.platform)) return;
  const marker = '__TARCSWEB_PATH__';
  const path = await new Promise<string>((done) => {
    const child = execFile(process.env.SHELL || '/bin/sh', ['-ilc', `printf '\\n${marker}%s\\n' "$PATH"`], (err, out) => {
      clearTimeout(timer);
      done(err ? '' : out.split('\n').find((line) => line.startsWith(marker))?.slice(marker.length) ?? '');
    });
    // A login shell that hangs or ignores SIGTERM must not hold up the boot.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done('');
    }, WAIT_MS);
  });
  if (path) process.env.PATH = [...new Set([...path.split(delimiter), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean))].join(delimiter);
}
