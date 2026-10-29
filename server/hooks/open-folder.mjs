// File manager right-click item from tarcsweb (Settings › Folder menu): asks the running app to open a folder.
// Usage: open-folder.mjs <hook dir> new|continue <path, file:// URI or Windows path>. Always exits 0.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POST_MS = 15_000;
const [dir, mode, arg] = process.argv.slice(2);
if (!dir || (mode !== 'new' && mode !== 'continue') || !arg) process.exit(0);

let wsl = !!process.env.WSL_DISTRO_NAME;
try {
  wsl ||= process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
} catch {}

// Best effort: a missing notifier just means no message.
function notify(text) {
  const opts = { stdio: 'ignore', timeout: 8000 };
  if (wsl) {
    const q = text.replaceAll("'", "''");
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).Popup('${q}', 5, 'tarcsweb', 64) | Out-Null`], opts);
  } else if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "tarcsweb"', '-e', 'end run', text], opts);
  } else spawnSync('notify-send', ['-a', 'tarcsweb', 'tarcsweb', text], opts);
}

// A file:// URI (Nautilus' folder on screen) or a Windows path (Explorer under WSL) becomes a local path; a file, its folder.
function folderOf(a) {
  let p = a;
  try {
    if (p.startsWith('file://')) p = fileURLToPath(p);
    else if (wsl && /^([A-Za-z]:\\|\\\\)/.test(p)) p = execFileSync('wslpath', ['-u', p], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!statSync(p).isDirectory()) p = dirname(p);
  } catch {}
  return p;
}

// Newest first; a file left behind by a crashed server has a dead pid. Same files as terminal-hook.mjs.
function servers() {
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      process.kill(s.pid, 0);
      if (Number.isInteger(s.port) && typeof s.token === 'string') out.push(s);
    } catch {}
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// Resolves with the status code, 0 when the server could not be reached.
function post(s, body) {
  return new Promise((done) => {
    const req = request({
      host: '127.0.0.1', port: s.port, path: '/hook/open', method: 'POST', timeout: POST_MS,
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode ?? 0));
      res.on('error', () => done(0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(0));
    req.end(body);
  });
}

const cwd = folderOf(arg);
const body = JSON.stringify({ cwd, mode });
let status = 0;
for (const s of servers()) {
  status = await post(s, body);
  if (status === 200 || status === 404) break;
}
if (status === 404) notify(`${cwd} is not a folder tarcsweb can open.`);
else if (status !== 200) notify(status ? 'tarcsweb could not open this folder.' : 'tarcsweb is not running. Start it, then try again.');
process.exit(0);
