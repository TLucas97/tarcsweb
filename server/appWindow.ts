import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { config } from './config.ts';
import type { OpenMode } from './protocol.ts';
import { IN_TAURI, shellSend } from './shell.ts';
import { findUserChrome } from './userChrome.ts';
import { isWslHost } from './machine.ts';

const APP_URL = 'http://localhost:24816/';
const APP_ARGS = ['run', 'com.google.Chrome'];

// With CW_DIST this server hosts the page; in Dev mode Vite does, at the first allowed origin (24816 by default).
const appUrl = () => process.env.CW_DIST
  ? `http://localhost:${Number(process.env.CW_PORT) || 24817}/`
  : `${(process.env.CW_ORIGINS ?? 'http://localhost:24816').split(',')[0].trim()}/`;

const activationRequests = new Map<string, (token?: string) => void>();
let activationInput: ReturnType<typeof createInterface> | undefined;

async function launchEnvironment(program: string): Promise<NodeJS.ProcessEnv> {
  if (!IN_TAURI || process.platform !== 'linux' || process.env.CW_ACTIVATION_PIPE !== '1') return process.env;
  if (!activationInput) {
    activationInput = createInterface({ input: process.stdin });
    activationInput.on('line', (line) => {
      let reply: { type?: string; id?: string; token?: string };
      try { reply = JSON.parse(line); } catch { return; }
      if (reply?.type === 'activation-token' && typeof reply.id === 'string') {
        activationRequests.get(reply.id)?.(typeof reply.token === 'string' ? reply.token : undefined);
      }
    });
  }
  const id = randomUUID();
  const token = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => {
      console.warn('Desktop activation timed out; opening without a token');
      done();
    }, 1000);
    const done = (value?: string) => {
      clearTimeout(timer);
      activationRequests.delete(id);
      resolve(value);
    };
    activationRequests.set(id, done);
    // shellSend only types show/hide; this request also needs a reply on the parent's stdin pipe.
    process.stdout.write(`@@tarcsweb-shell ${JSON.stringify({ cmd: 'activation-token', id, program })}\n`);
  });
  const env = { ...process.env };
  delete env.XDG_ACTIVATION_TOKEN;
  delete env.DESKTOP_STARTUP_ID;
  if (token) {
    env.XDG_ACTIVATION_TOKEN = token;
    env.DESKTOP_STARTUP_ID = token;
  }
  return env;
}

// Starts a detached program; resolves null once it runs, or the error.
function launch(cmd: string, args: string[]): Promise<string | null> {
  if (IN_TAURI) return launchTauri(cmd, args);
  return new Promise((done) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => done(`Could not open the app: ${e.message}`));
    child.on('spawn', () => {
      child.unref();
      done(null);
    });
  });
}

async function launchTauri(cmd: string, args: string[]): Promise<string | null> {
  const env = await launchEnvironment(cmd);
  return new Promise((done) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
    child.on('error', (e) => done(`Could not open the app: ${e.message}`));
    child.on('spawn', () => {
      child.unref();
      done(null);
    });
  });
}

export async function openSurface(mode: OpenMode, path = '/', wsl?: boolean): Promise<string | null> {
  const base = new URL(appUrl());
  let target: URL;
  try { target = new URL(path, base); } catch { return 'Invalid app path'; }
  if (target.origin !== base.origin) return 'The app path must stay on this server';
  if (IN_TAURI && mode === 'desktop') {
    shellSend({ cmd: 'show', path: target.pathname + target.search + target.hash });
    return null;
  }
  return open(target.href, wsl ?? await isWslHost(), mode !== 'chrome-tab');
}

// flatpak run starts fine even when Chrome is not installed, so ask first.
const chromeFlatpak = () =>
  new Promise<boolean>((done) => execFile('flatpak', ['info', APP_ARGS[1]], { timeout: 5000 }, (err) => done(!err)));

// Opens the app at path: a Chrome app window on Linux (the default browser when Flatpak is missing), the default
// browser on Windows (WSL) and macOS. wsl is passed in, so this module stays free of async platform checks.
export async function openWindow(path = '/', wsl = false): Promise<string | null> {
  if (IN_TAURI) return openSurface(config.openMode ?? 'desktop', path, wsl);
  return open(new URL(path, APP_URL).href, wsl, true);
}

// A normal tab in the user's Chrome, for pages such as a project's dev server.
export const openTab = (url: string, wsl = false) => open(url, wsl, false);

async function open(url: string, wsl: boolean, app: boolean) {
  if (IN_TAURI) return openTauri(url, wsl, app);
  if (wsl) return launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replaceAll("'", "''")}'`]);
  if (process.platform === 'win32') return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  if (process.platform === 'darwin') return launch('open', [url]);
  return (await chromeFlatpak()) ? launch('flatpak', [...APP_ARGS, app ? `--app=${url}` : url]) : launch('xdg-open', [url]);
}

async function openTauri(url: string, wsl: boolean, app: boolean) {
  if (wsl) return launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replaceAll("'", "''")}'`]);
  const chrome = await findUserChrome();
  if (chrome) return launch(chrome.command, [...chrome.args, app ? `--app=${url}` : url]);
  if (process.platform === 'win32') return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
