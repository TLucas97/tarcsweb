import type { ShellInfo } from './protocol.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { openSurface } from './appWindow.ts';
import { userChrome } from './userChrome.ts';

// Set by the Tauri app when it starts this server.
export const IN_TAURI = process.env.CW_SHELL === 'tauri';

const OS: ShellInfo['os'] = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'other';

export function shellInfo(): ShellInfo {
  const eligible = IN_TAURI && OS === 'linux';
  return { kind: IN_TAURI ? 'tauri' : 'service', os: OS, chrome: userChrome()?.name ?? null,
    ...(eligible ? { voiceHelper: { available: !!userChrome(), ...(!userChrome() ? { reason: 'chrome-missing' as const } : {}) } } : {}) };
}

const digest = (s: string) => createHash('sha256').update(s).digest();
export function shellAuthorized(req: IncomingMessage): boolean {
  const token = process.env.CW_SHELL_TOKEN;
  return IN_TAURI && !!token && req.headers.origin === undefined
    && timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${token}`));
}

export function shellSend(cmd: { cmd: 'show'; path?: string } | { cmd: 'hide' }) {
  if (IN_TAURI) process.stdout.write(`@@tarcsweb-shell ${JSON.stringify(cmd)}\n`);
}

export async function serveShell(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/api/identity') {
    if (req.method !== 'GET') res.writeHead(405).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ app: 'tarcsweb' }));
    return true;
  }
  if (!IN_TAURI) return false;
  if (path !== '/api/shell' && path !== '/api/shell/open') return false;
  const status = !IN_TAURI ? 404 : !shellAuthorized(req) ? 401 : req.method !== (path === '/api/shell' ? 'GET' : 'POST') ? 405 : 200;
  if (status !== 200) { res.writeHead(status).end(); return true; }
  const reply = (body: unknown, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (path === '/api/shell') {
    reply({ app: 'tarcsweb', openMode: config.openMode, chrome: shellInfo().chrome, os: OS });
    return true;
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) { reply({ error: 'Request too large' }, 413); return true; }
  }
  let input: unknown;
  try { input = JSON.parse(body); } catch { reply({ error: 'Invalid JSON' }, 400); return true; }
  const m = input as { mode?: unknown; path?: unknown } | null;
  if (!m || (m.mode !== 'chrome-app' && m.mode !== 'chrome-tab') || (m.path !== undefined && (typeof m.path !== 'string' || m.path.length > 4096))) {
    reply({ error: 'Invalid open mode or path' }, 400);
    return true;
  }
  reply({ error: await openSurface(m.mode, m.path as string | undefined) });
  return true;
}

export function watchShellParent(quit: () => void) {
  const pid = Number(process.env.CW_PARENT_PID);
  if (!IN_TAURI || !Number.isSafeInteger(pid) || pid <= 0) return;
  const timer = setInterval(() => {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        clearInterval(timer);
        quit();
      }
    }
  }, 2000);
  timer.unref();
}
