import { execFile } from 'node:child_process';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { readBody, terminal } from './terminal.ts';
import { openWindow } from './appWindow.ts';
import { isWslHost } from './machine.ts';
import type { SessionManager } from './sessions.ts';
import type { ServerMessage } from './protocol.ts';

// A raise only counts this soon after an open, so a page cannot pull windows forward whenever it likes.
const RAISE_MS = 20_000;
const STEP_MS = 4000;
const KWIN_PLUGIN = 'tarcsweb-raise';

type Seat = { send: (m: ServerMessage) => void; active: number };

const run = (cmd: string, args: string[]) =>
  new Promise<string | null>((done) => execFile(cmd, args, { timeout: STEP_MS }, (err, out) => done(err ? null : out)));

// The most recent open tab or saved session in this folder; archived ones are left out.
async function latest(manager: SessionManager, cwd: string) {
  const real = await realpath(cwd).catch(() => cwd);
  const here = (p: string) => {
    const r = resolve(p);
    return r === cwd || r === real;
  };
  let best: { id: string; at: number } | null = null;
  for (const r of manager.roster()) if (here(r.cwd) && (!best || r.lastActive > best.at)) best = { id: r.id, at: r.lastActive };
  for (const p of (await manager.pastSessions()).sessions) {
    if (!p.archived && here(p.cwd) && (!best || p.lastModified > best.at)) best = { id: p.id, at: p.lastModified };
  }
  return best?.id ?? null;
}

// KWin 6 names it windowList/activeWindow, KWin 5 clientList/activeClient. A Chrome tab's caption ends in " - Google Chrome".
const kwinScript = (title: string) => `const t = ${JSON.stringify(title)};
const list = workspace.windowList ? workspace.windowList() : workspace.clientList();
let hit = null;
for (let i = 0; i < list.length; i++) {
  const c = list[i].caption;
  if (c === t) { hit = list[i]; break; }
  if (!hit && c.startsWith(t)) hit = list[i];
}
if (hit) {
  hit.minimized = false;
  if (workspace.windowList) workspace.activeWindow = hit; else workspace.activeClient = hit;
}
`;

const kwin = (path: string, method: string, ...args: string[]) =>
  run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', path, '--method', method, ...args]);

// Loads a one-shot KWin script over D-Bus; Wayland gives no other way to activate another app's window.
async function kwinRaise(title: string) {
  const dir = join(CACHE_DIR, 'folder-open');
  const file = join(dir, 'raise.js');
  await mkdir(dir, { recursive: true });
  await writeFile(file, kwinScript(title));
  await kwin('/Scripting', 'org.kde.kwin.Scripting.unloadScript', KWIN_PLUGIN);
  const id = (await kwin('/Scripting', 'org.kde.kwin.Scripting.loadScript', file, KWIN_PLUGIN))?.match(/-?\d+/)?.[0];
  if (id === undefined || id.startsWith('-')) return;
  // Plasma 6 exposes the script at /Scripting/Script<id>, Plasma 5 at /<id>.
  if ((await kwin(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run')) === null) await kwin(`/${id}`, 'org.kde.kwin.Script.run');
  await kwin('/Scripting', 'org.kde.kwin.Scripting.unloadScript', KWIN_PLUGIN);
}

const MAC_RAISE = [
  'on run argv',
  'set t to item 1 of argv',
  'if application "Google Chrome" is running then',
  'tell application "Google Chrome"',
  'repeat with w in windows',
  'if title of w starts with t then',
  'set index of w to 1',
  'exit repeat',
  'end if',
  'end repeat',
  'activate',
  'end tell',
  'end if',
  'end run',
];

// The file manager's right-click items (hooks/open-folder.mjs) land here, and go to the window used last.
class FolderOpen {
  private seats = new Set<Seat>();
  private raiseUntil = 0;

  // One per app socket; touch marks it as the window used last.
  join(send: (m: ServerMessage) => void) {
    const seat: Seat = { send, active: Date.now() };
    this.seats.add(seat);
    return { touch: () => void (seat.active = Date.now()), leave: () => void this.seats.delete(seat) };
  }

  // Handles POST /hook/open with { cwd, mode: 'new' | 'continue' }; false for any other path.
  async serve(req: IncomingMessage, res: ServerResponse, manager: SessionManager): Promise<boolean> {
    if ((req.url ?? '').split('?')[0] !== '/hook/open') return false;
    const reply = (status: number, body?: Record<string, unknown>) => {
      if (body) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      else res.writeHead(status).end();
      return true;
    };
    if (req.method !== 'POST') return reply(405);
    if (!terminal.authorized(req)) return reply(401);
    let body: { cwd?: unknown; mode?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return reply(400);
    }
    const raw = body?.cwd;
    const mode = body?.mode;
    if (typeof raw !== 'string' || raw.length > 4096 || !isAbsolute(raw) || (mode !== 'new' && mode !== 'continue')) return reply(400);
    const cwd = resolve(raw);
    if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) return reply(404, { error: 'Not a folder' });
    const resume = mode === 'continue' ? await latest(manager, cwd) : null;
    this.raiseUntil = Date.now() + RAISE_MS;
    const seat = [...this.seats].sort((a, b) => b.active - a.active)[0];
    if (seat) {
      seat.send({ type: 'open-folder', cwd, resume });
      return reply(200, { to: 'window' });
    }
    const err = await openWindow(`/?${resume ? `resume=${encodeURIComponent(resume)}` : `open=${encodeURIComponent(cwd)}`}`, await isWslHost());
    return err ? reply(500, { error: err }) : reply(200, { to: 'new window' });
  }

  // Best effort, once per open: KWin on KDE, AppActivate on Windows, Chrome's AppleScript on macOS, wmctrl on X11.
  async raise(title: string) {
    if (Date.now() > this.raiseUntil || !title.trim()) return;
    this.raiseUntil = 0;
    try {
      if (await isWslHost()) {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate('${title.replaceAll("'", "''")}') | Out-Null`]);
      } else if (process.platform === 'darwin') {
        await run('osascript', [...MAC_RAISE.flatMap((l) => ['-e', l]), title]);
      } else if (/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')) await kwinRaise(title);
      else await run('wmctrl', ['-a', title]);
    } catch {}
  }
}

export const folderOpen = new FolderOpen();
