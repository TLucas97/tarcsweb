import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { CACHE_DIR, config, obj, rawConfig } from './config.ts';
import { levelGet } from './leveldb.ts';
import { onPerfChange, tuning } from './profile.ts';
import { onAgentsChange, saveSettings } from './settings.ts';
import { BROWSER_TEXT_MAX } from './protocol.ts';
import { browserFeedback } from './browserFeedback.ts';
import type { BrowserClientMessage, BrowserServerMessage, CursorShape, BrowserState, BrowserTab, BrowserTool, BrowserWhy } from './protocol.ts';
import { NO_FFMPEG, REC_SIZE, Recording, clearRecordings, deleteRecording, encoder, listRecordings, prune, sweepParts, videoOf, type Saved } from './recorder.ts';

// An isolated Chrome on a hidden display, shown live in the Browser panel. It starts when a panel opens or a panel pack
// needs it, and stops once neither has needed it for browserIdleMs. MCP packs attach to it through its DevTools port.

const DIR = join(CACHE_DIR, 'browser');
// On real disk, so logins survive restarts.
const PROFILE = join(DIR, 'profile');
// Informational: which server last owned the profile, and the Xvfb and Chrome it started.
const OWNER = join(DIR, 'owner.json');
// The last bridge device id read from the panel extension's storage, for when that storage cannot be parsed.
const DEVICE_CACHE = join(DIR, 'device.json');
// Cookie file of the hidden display, rewritten on every start.
const XAUTH = join(DIR, 'xauthority');
const WIN = { w: 1280, h: 860 };
// The hidden screen (CSS px) before any panel reported its monitor, roomy so the window can grow to the panel's size;
// it scales with the device scale factor up to SCREEN_MAX.
const SCREEN = { w: 3840, h: 2400 };
const SCREEN_MAX = { w: 5120, h: 3200 };
// Room past the monitor (CSS px) for the 240 px resize() keeps free plus the window's own toolbar.
const SCREEN_PAD = 320;
// Chrome refuses narrower windows, so a narrower panel shows the page scaled down.
const MIN_WIN = { w: 500, h: 320 };
// Claude in Chrome's native messaging host. A custom --user-data-dir reads hosts from <profile>/NativeMessagingHosts only.
const NATIVE_HOST = 'com.anthropic.claude_code_browser_extension.json';
// Claude in Chrome's Web Store id, for when the native host manifest lists no extension.
const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const DEVICE_KEY = 'bridgeDeviceId';
const DEVICE_ID = /^\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?\s*$/;
// Steps of a start that talk to Chrome; a hung Chrome fails the start instead of blocking every later start and stop.
const STEP_MS = 10_000;
// A tool call holds Chrome until it ends; past this, a call whose session is no longer working counts as abandoned.
const LEASE_MAX_MS = 10 * 60_000;
const CLAUDE_TTL_MS = 30_000;
const SETUP_OPEN = "The Browser panel's Chrome is open as a setup window on the desktop. Close that window, then try again.";

// CW_BROWSER_PORT or config browser.port, read once: the panel packs get it before Chrome starts, so Chrome never moves.
// DevTools on loopback has no auth, so any local process of this user can drive this Chrome; the MCP packs need it so.
const PORT_DEFAULT = 9333;
function wantedPort() {
  const n = Number(process.env.CW_BROWSER_PORT || obj(rawConfig.value.browser).port);
  return Number.isInteger(n) && n > 1023 && n <= 65535 ? n : PORT_DEFAULT;
}
const portFree = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => ok(true)));
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const STALE = 'This start was stopped.';
// Fails after ms, or as soon as the run's signal aborts, so a stop never waits on a hung step.
function timed<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal) {
  let t: NodeJS.Timeout | undefined;
  let off = () => {};
  return Promise.race([p, new Promise<never>((_, fail) => {
    t = setTimeout(() => fail(new Error(`Chrome did not answer ${what} in time.`)), ms);
    if (!signal) return;
    const stop = () => fail(new Error(STALE));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    off = () => signal.removeEventListener('abort', stop);
  })]).finally(() => {
    clearTimeout(t);
    off();
  });
}

// ---- Platform: the OS-specific helpers. Linux runs a headed Chrome on a private Xvfb, or a headless one when Xvfb is
// missing; macOS always runs it headless. Headless Chrome cannot host Claude in Chrome.
const OS = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'mac' : null;
const UNSUPPORTED = 'The Browser panel runs on Linux and macOS only.';

type Kind = 'flatpak' | 'chrome' | 'chromium' | 'brave' | 'edge' | 'cft';
// A Chrome found on this machine; path is the Flatpak app id or the binary.
type Found = { kind: Kind; path: string };
type Display = 'xvfb' | 'headless';
// The owner's own desktop, where the setup window opens: X11 (XWayland too) when the server has DISPLAY, else Wayland.
type Desk = 'x11' | 'wayland';
const deskMode = (): Desk | null => (OS !== 'linux' ? null : process.env.DISPLAY ? 'x11' : process.env.WAYLAND_DISPLAY ? 'wayland' : null);
type Engine = { label: string; cmd: string; args: string[]; flatpak: string | null; kind: Kind };
const LABEL: Record<Kind, string> = { flatpak: 'Flatpak Chrome', chrome: 'Google Chrome', chromium: 'Chromium', brave: 'Brave', edge: 'Microsoft Edge', cft: 'Chrome for Testing' };
const FLATPAK_ID = 'com.google.Chrome';
const NATIVE = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
// Chromium-based and speak CDP, so the same flags work; tried in this order, each in /Applications then ~/Applications.
const MAC_APPS: [Kind, string][] = [
  ['chrome', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['chromium', 'Applications/Chromium.app/Contents/MacOS/Chromium'],
  ['brave', 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['edge', 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
];
const NO_BROWSER = 'No supported browser found. Install Google Chrome, Chromium, Brave or Microsoft Edge, or set CW_BROWSER_BIN to the browser binary.';
// Set when the last search passed over a snap browser, so the error can say why it found nothing.
let snapSkipped = false;

const flags = (port: number, scale: number, display: Display | Desk) => [
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
  // A real keyring or Keychain would pop its unlock dialog on the owner's desktop.
  OS === 'mac' ? '--use-mock-keychain' : '--password-store=basic',
  display === 'headless' ? '--headless=new' : display === 'wayland' ? '--ozone-platform=wayland' : '--ozone-platform=x11', `--window-size=${WIN.w},${WIN.h}`,
  ...(display === 'x11' || display === 'wayland' ? [] : ['--window-position=0,0']),
  // A hidden browser must never play sound on the owner's desktop, nor answer his media keys (MPRIS).
  '--mute-audio', '--disable-audio-output', '--disable-features=HardwareMediaKeyHandling',
  // Frames come in device px, so a HiDPI viewer gets sharp text instead of an upscaled picture.
  ...(scale !== 1 ? [`--force-device-scale-factor=${scale}`] : []),
];

const hasFlatpak = (id: string, signal: AbortSignal) =>
  new Promise<boolean>((ok) => execFile('flatpak', ['info', id], { timeout: STEP_MS, signal }, (err) => ok(!err)));
const runnable = (p: string) => access(p, constants.X_OK).then(() => true, () => false);

async function onPath(name: string, skipSnap = false) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = dir && join(dir, name);
    if (!p || !(await runnable(p))) continue;
    // Snap Chromium cannot read a profile under a hidden home folder.
    if (p.startsWith('/snap/') || (await realpath(p).catch(() => p)).startsWith('/snap/')) {
      if (skipSnap) snapSkipped = true;
      continue;
    }
    return p;
  }
  return null;
}

// Playwright's newest Chrome for Testing build.
async function cftPath() {
  const root = join(homedir(), '.cache/ms-playwright');
  const dirs = (await readdir(root).catch(() => [] as string[])).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)));
  for (const d of dirs) for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) if (await runnable(join(root, d, sub))) return join(root, d, sub);
  return null;
}

const kindOf = (path: string): Kind =>
  /ms-playwright|for.testing/i.test(path) ? 'cft' : /brave/i.test(path) ? 'brave' : /msedge|microsoft.edge/i.test(path) ? 'edge' : /chromium/i.test(path) ? 'chromium' : 'chrome';

// CW_BROWSER_BIN or config browser.bin: "flatpak", "flatpak:<app id>" or a Chrome binary path. Otherwise Linux tries
// Flatpak Chrome, a native Chrome, Chromium, Brave or Edge, then Chrome for Testing; macOS takes the first installed of those.
async function findChrome(signal: AbortSignal): Promise<Found | null> {
  const raw = obj(rawConfig.value.browser).bin;
  const want = process.env.CW_BROWSER_BIN || (typeof raw === 'string' ? raw.trim() : '');
  if (want.startsWith('flatpak')) return { kind: 'flatpak', path: want.split(':')[1] || FLATPAK_ID };
  if (want) return { kind: kindOf(want), path: want };
  if (OS === 'mac') {
    for (const [kind, app] of MAC_APPS) for (const p of [join('/', app), join(homedir(), app)]) if (await runnable(p)) return { kind, path: p };
    return null;
  }
  if (OS !== 'linux') return null;
  snapSkipped = false;
  if (await hasFlatpak(FLATPAK_ID, signal)) return { kind: 'flatpak', path: FLATPAK_ID };
  if (signal.aborted) throw new Error(STALE);
  for (const name of NATIVE) {
    const p = await onPath(name, true);
    if (p) return { kind: kindOf(name), path: p };
  }
  if (await runnable('/opt/google/chrome/chrome')) return { kind: 'chrome', path: '/opt/google/chrome/chrome' };
  const cft = await cftPath();
  return cft ? { kind: 'cft', path: cft } : null;
}

const findDisplay = async (): Promise<Display> => (OS === 'linux' && (await onPath('Xvfb')) ? 'xvfb' : 'headless');

function launch(found: Found, port: number, scale: number, display: Display | Desk): Engine {
  const args = flags(port, scale, display);
  if (found.kind !== 'flatpak') return { label: LABEL[found.kind], cmd: found.path, args, flatpak: null, kind: found.kind };
  // No sound server in the sandbox either, so even a page that gets around --mute-audio has nowhere to play.
  const sandbox = [...(display === 'wayland' ? [] : ['--nosocket=wayland']), '--nosocket=pulseaudio', '--nofilesystem=xdg-run/pipewire-0', `--filesystem=${PROFILE}`];
  return { label: LABEL.flatpak, cmd: 'flatpak', args: ['run', ...sandbox, found.path, ...args], flatpak: found.path, kind: 'flatpak' };
}

// Why the panel cannot host Claude in Chrome here, or null when it can. Then it keeps using the user's own Chrome.
function claudeLimit(found: Found | null, display: Display) {
  if (OS === 'mac') return "On macOS the panel's Chrome runs without a window, where Claude in Chrome cannot connect, so Claude in Chrome uses your own Chrome.";
  if (found?.kind === 'cft') return 'Chrome for Testing cannot install Web Store extensions, so Claude in Chrome uses your own Chrome. Install Google Chrome to use it here.';
  if (display === 'headless') return 'Claude in Chrome needs a display and Xvfb is not installed, so Claude in Chrome uses your own Chrome. Install Xvfb to use it here.';
  return null;
}

// The host manifest of the matching own Chrome; a Flatpak one points at a wrapper that only works inside Flatpak.
function hostSource(found: Found) {
  const dir = found.kind === 'flatpak' ? join(homedir(), '.var/app', found.path, 'config/google-chrome')
    : found.kind === 'chrome' ? join(homedir(), '.config/google-chrome')
    : found.kind === 'chromium' ? join(homedir(), '.config/chromium') : null;
  return dir && join(dir, 'NativeMessagingHosts', NATIVE_HOST);
}

// Copies it into the profile, the only place a custom --user-data-dir reads hosts from.
async function nativeHost(found: Found) {
  const src = hostSource(found);
  const text = src && (await readFile(src, 'utf8').catch(() => null));
  if (!text) return;
  const dest = join(PROFILE, 'NativeMessagingHosts', NATIVE_HOST);
  if ((await readFile(dest, 'utf8').catch(() => null)) === text) return;
  await mkdir(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(dest, text);
}

// Flatpak needs the session bus to start; Wayland or the desktop's X display would put the window on the real desktop,
// which only the setup window (desk) wants.
function baseEnv(desk?: Desk): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (OS !== 'linux') return env;
  env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/bus`;
  if (desk !== 'wayland') delete env.WAYLAND_DISPLAY;
  if (desk !== 'x11') delete env.DISPLAY;
  return env;
}

const cmdline = (pid: number) => readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.split('\0'), () => [] as string[]);

// Every process still holding this profile, from a server that died without cleaning up. macOS has no /proc, so ps.
async function profileProcs() {
  const flag = `--user-data-dir=${PROFILE}`;
  if (OS === 'mac') {
    const out = await new Promise<string>((ok) => execFile('ps', ['-axww', '-o', 'pid=,command='], { timeout: STEP_MS, maxBuffer: 16 << 20 }, (_e, s) => ok(String(s ?? ''))));
    return out.split('\n').flatMap((l) => {
      const m = /^\s*(\d+)\s(.*)$/.exec(l);
      return m && `${m[2]} `.includes(`${flag} `) ? [Number(m[1])] : [];
    });
  }
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d)).map(Number);
  const hits = await Promise.all(pids.map(async (pid) => ((await cmdline(pid)).includes(flag) ? pid : 0)));
  return hits.filter(Boolean);
}

// The profile lock. Linux uses an abstract socket, which the kernel frees when its process dies. macOS has none, so a
// socket file stands in, and a dead server's file refuses connections; socket paths cap near 104 bytes there.
const LOCK_ID = `tarcsweb-browser-${process.getuid?.() ?? 0}-${createHash('sha256').update(PROFILE).digest('hex').slice(0, 12)}`;
const LOCK = OS === 'linux' ? `\0${LOCK_ID}` : Buffer.byteLength(join(DIR, 'lock.sock')) < 100 ? join(DIR, 'lock.sock') : join(tmpdir(), `${LOCK_ID}.sock`);

const answers = (path: string) =>
  new Promise<boolean>((ok) => {
    const c = connect(path);
    const done = (held: boolean) => {
      c.destroy();
      ok(held);
    };
    c.setTimeout(1000, () => done(true));
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });

// The listening lock, or null while another live process holds it. Closing the server unlinks a socket file.
async function takeLock(): Promise<Server | null> {
  const listen = () =>
    new Promise<Server | null>((ok, fail) => {
      const s = createServer((c) => c.destroy());
      s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? ok(null) : fail(e)));
      s.listen(LOCK, () => ok(s));
    });
  const s = await listen();
  if (s || OS === 'linux' || (await answers(LOCK))) return s;
  await rm(LOCK, { force: true });
  return listen();
}

// The Claude extensions the native host serves, read from the manifest copied into the profile.
async function extensionIds() {
  try {
    const m = JSON.parse(await readFile(join(PROFILE, 'NativeMessagingHosts', NATIVE_HOST), 'utf8'));
    const ids = (Array.isArray(m.allowed_origins) ? m.allowed_origins : []).flatMap((o: unknown) => /^chrome-extension:\/\/([a-p]{32})\/$/.exec(String(o))?.[1] ?? []);
    if (ids.length) return ids as string[];
  } catch {}
  return [EXTENSION_ID];
}

// The bridge device id of the panel's Claude extension, read from its LevelDB storage. CDP may not attach to extensions,
// so the files are the only way in; callers check the id against the live browser list before trusting it.
async function extensionDevice() {
  let failed: unknown = null;
  for (const ext of await extensionIds()) {
    try {
      const value = await levelGet(join(PROFILE, 'Default', 'Local Extension Settings', ext), DEVICE_KEY);
      const id = value && DEVICE_ID.exec(value.toString('utf8'))?.[1];
      if (!id) continue;
      void rememberDevice(id);
      return id;
    } catch (e) {
      failed = e;
    }
  }
  if (!failed) return null;
  console.log(`browser: could not read the Claude extension's storage: ${fault(failed)}`);
  const saved = obj(await readFile(DEVICE_CACHE, 'utf8').then((s) => JSON.parse(s)).catch(() => null));
  return saved.profile === PROFILE && typeof saved.id === 'string' && DEVICE_ID.test(saved.id) ? saved.id : null;
}

// The id of the installed Claude extension, or null. Chrome unpacks each version under Extensions/<id>; an uninstall
// removes the folder.
async function installedExtension() {
  for (const id of await extensionIds()) {
    const dir = join(PROFILE, 'Default', 'Extensions', id);
    for (const v of await readdir(dir).catch(() => [] as string[])) {
      if (await access(join(dir, v, 'manifest.json')).then(() => true, () => false)) return id;
    }
  }
  return null;
}

// The page the setup window opens on: the extension's Web Store page, or its sign-in page once it is installed.
async function setupUrl() {
  const id = await installedExtension();
  return id ? `chrome-extension://${id}/sidepanel.html` : `https://chromewebstore.google.com/detail/claude/${(await extensionIds())[0]}`;
}

// A host manifest, in the profile or ready to be copied there, whose program exists; a stale one fails to connect.
async function hostReady(found: Found | null) {
  for (const p of [join(PROFILE, 'NativeMessagingHosts', NATIVE_HOST), found && hostSource(found)]) {
    const m = p ? obj(await readFile(p, 'utf8').then((s) => JSON.parse(s)).catch(() => null)) : {};
    if (typeof m.path === 'string' && (await runnable(m.path))) return true;
  }
  return false;
}

let savedDevice = '';
async function rememberDevice(id: string) {
  if (id === savedDevice) return;
  savedDevice = id;
  await writeFile(DEVICE_CACHE, JSON.stringify({ profile: PROFILE, id })).catch((e) => console.log(`browser: saving the device id failed: ${fault(e)}`));
}

// The last stderr lines that look like a reason; Chrome also logs plenty of harmless noise there.
const tail = (s: string) => s.split('\n').filter((l) => /error|fail|cannot|can't|denied|not found|no such/i.test(l)).slice(-2).join(' · ').slice(0, 300);

// One MIT-MAGIC-COOKIE-1 entry in the Xauthority format. FamilyWild with no display number matches any display, and Xvfb
// loads every cookie in its -auth file, so the file can be written before the display number is known.
async function writeXauth() {
  const field = (b: Buffer) => {
    const n = Buffer.alloc(2);
    n.writeUInt16BE(b.length);
    return Buffer.concat([n, b]);
  };
  const family = Buffer.from([0xff, 0xff]);
  const entry = Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(randomBytes(16))]);
  await writeFile(XAUTH, entry, { mode: 0o600 });
  await chmod(XAUTH, 0o600);
}

// A display Chrome can draw on without showing up on the desktop: a private Xvfb that only clients holding its cookie
// can reach. Linux only; findDisplay() picks headless elsewhere.
function spawnDisplay(screen: { w: number; h: number }) {
  return spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${screen.w}x${screen.h}x24`, '-nolisten', 'tcp', '-auth', XAUTH], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
}

async function displayEnv(proc: ChildProcess, signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const display = await timed(new Promise<string>((ok, fail) => {
    let out = '';
    let err = '';
    const t = setTimeout(() => fail(new Error('Xvfb did not start within 5 s')), 5000);
    proc.stdio[3]!.on('data', (d: Buffer) => {
      out += d;
      if (!out.includes('\n')) return;
      clearTimeout(t);
      ok(out.trim());
    });
    proc.stderr!.on('data', (d: Buffer) => (err = (err + d).slice(-2000)));
    proc.once('error', (e) => {
      clearTimeout(t);
      fail(new Error(`Xvfb failed to start: ${e.message}`));
    });
    proc.once('exit', (code) => {
      clearTimeout(t);
      fail(new Error(`Xvfb exited (${code}). ${tail(err)}`.trim()));
    });
  }), 6000, 'the hidden display', signal);
  // Flatpak copies the matching cookie from XAUTHORITY into its sandbox.
  return { ...baseEnv(), DISPLAY: `:${display}`, XAUTHORITY: XAUTH };
}

const gone = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;
const exited = (p: ChildProcess, ms: number) =>
  gone(p) ? Promise.resolve(true) : new Promise<boolean>((ok) => {
    const t = setTimeout(() => ok(false), ms);
    p.once('exit', () => {
      clearTimeout(t);
      ok(true);
    });
  });
// Chrome runs as its own process group, so one signal reaches every helper it started.
function signal(p: ChildProcess, group: boolean, sig: NodeJS.Signals) {
  try {
    if (p.pid) process.kill(group ? -p.pid : p.pid, sig);
  } catch {}
}
async function end(p: ChildProcess, group: boolean, wait: number) {
  if (!(await exited(p, wait))) {
    signal(p, group, 'SIGTERM');
    if (!(await exited(p, 2000))) signal(p, group, 'SIGKILL');
  }
  // Flatpak's leftovers (dbus proxy) stay in the group after the leader exits.
  if (group) signal(p, true, 'SIGTERM');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Owner = { server?: number; run?: number; xvfb?: number; chrome?: number };
const readOwner = (): Promise<Owner | null> => readFile(OWNER, 'utf8').then((s) => obj(JSON.parse(s)) as Owner, () => null);
// Written aside and renamed in, so a reader never sees half a file.
async function writeAside(path: string, data: Owner) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  return tmp;
}

type Pending = { ok: (v: any) => void; fail: (e: Error) => void };

// A minimal flat-session CDP client over the browser endpoint.
class Cdp {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private ws: WebSocket;

  constructor(ws: WebSocket, onEvent: (method: string, params: any, session?: string) => void, onClose: () => void) {
    this.ws = ws;
    // The close event follows and fails what is pending.
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.id === undefined) return onEvent(m.method, m.params, m.sessionId);
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.fail(new Error(m.error.message));
      else p?.ok(m.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.fail(new Error('DevTools connection closed'));
      this.pending.clear();
      onClose();
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string | null): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('DevTools connection closed'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise<T>((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  close() {
    this.ws.close();
  }

  // A handshake still open when its run goes stale is cut, so it never lands on a torn-down run.
  static open(url: string, signal: AbortSignal) {
    return new Promise<WebSocket>((ok, fail) => {
      if (signal.aborted) return fail(new Error(STALE));
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 << 20, handshakeTimeout: STEP_MS });
      const cut = () => {
        ws.terminate();
        fail(new Error(STALE));
      };
      signal.addEventListener('abort', cut, { once: true });
      ws.once('open', () => {
        signal.removeEventListener('abort', cut);
        ok(ws);
      });
      ws.once('error', (e) => {
        signal.removeEventListener('abort', cut);
        fail(new Error(`Chrome's DevTools connection failed: ${e.message}`));
      });
    });
  }
}

type Viewer = { open: boolean; visible: boolean; w: number; h: number; dpr: number };
// What one start created, so its teardown reaches all of it even when a newer start or stop came in between.
// abort fires when the run goes stale, so its pending steps give up at once.
type Run = { run: number; abort: AbortController; lock: Server | null; xvfb: ChildProcess | null; chrome: ChildProcess | null; cdp: Cdp | null };
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
const BUTTONS = ['none', 'left', 'middle', 'right'];
const MOUSE: Record<string, string> = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' };

// Agent cursor: agents send input over their own DevTools connections, so a script in an isolated world (no globals in
// the page) reports trusted pointer input through a binding. The panel's own mouse events carry OWNER_TWIST, so it skips them.
const OWNER_TWIST = 7;
const CURSOR_WORLD = 'cw-cursor';
const CURSOR_BINDING = 'cwCursor';
const CURSOR_OFF = 'cwCursorOff';
// Globals here live in the isolated world only. Chrome reuses the world per frame, so a rerun turns the earlier copy off
// first, and a detach turns it off too; a copy that missed both sends an old token, which is ignored.
const cursorScript = (token: string) => `(() => {
  globalThis.${CURSOR_OFF}?.();
  const send = globalThis.${CURSOR_BINDING};
  if (typeof send !== 'function') return;
  const o = { capture: true, passive: true };
  let last = null, t = 0;
  const at = (e) => {
    let x = e.clientX, y = e.clientY;
    for (let w = window; w !== w.top; w = w.parent) {
      const f = w.frameElement;
      if (!f) return null;
      const r = f.getBoundingClientRect();
      x += r.left + f.clientLeft;
      y += r.top + f.clientTop;
    }
    return Math.round(x) + ' ' + Math.round(y);
  };
  const field = 'textarea,input:not([type=checkbox],[type=radio],[type=range],[type=button],[type=submit],[type=reset],[type=color],[type=file],[type=image])';
  // The cursor Chrome shows there; auto means an I-beam over a field or selectable text, else the arrow.
  const shape = (e) => {
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return 'arrow';
    const c = getComputedStyle(t).cursor;
    if (c === 'pointer') return 'hand';
    if (c === 'text' || c === 'vertical-text') return 'text';
    if (c !== 'auto') return 'arrow';
    if (t.isContentEditable || t.matches(field)) return 'text';
    const n = document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
    if (n?.nodeType !== 3 || !n.parentElement || getComputedStyle(n.parentElement).userSelect === 'none') return 'arrow';
    const r = document.createRange();
    r.selectNodeContents(n);
    for (const b of r.getClientRects()) if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) return 'text';
    return 'arrow';
  };
  const report = (k, e) => {
    const p = at(e);
    if (p) send('${token} ' + k + ' ' + p + ' ' + shape(e));
  };
  const skip = (e) => !e.isTrusted || e.twist === ${OWNER_TWIST};
  const move = (e) => {
    if (skip(e)) return;
    last = e;
    t ||= setTimeout(() => { t = 0; report('move', last); last = null; }, 33);
  };
  const down = (e) => {
    if (skip(e)) return;
    clearTimeout(t);
    t = 0;
    last = null;
    report('down', e);
  };
  globalThis.${CURSOR_OFF} = () => {
    clearTimeout(t);
    t = 0;
    last = null;
    removeEventListener('pointermove', move, o);
    removeEventListener('pointerdown', down, o);
    delete globalThis.${CURSOR_OFF};
  };
  addEventListener('pointermove', move, o);
  addEventListener('pointerdown', down, o);
})()`;
const fault = (e: unknown) => (e instanceof Error ? e.message : String(e));

class BrowserHost {
  // Pages get it with the main socket's hello; the browser sockets need it on top of the origin and host checks.
  readonly key = randomBytes(24).toString('base64url');
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private viewers = new Map<WebSocket, Viewer>();
  private state: BrowserState = {
    status: 'stopped', error: null, engine: null, port: null, held: false, agents: config.browserAgents, tabs: [], active: null, canBack: false, canForward: false, loading: false, tools: [],
    unavailable: {}, rec: null, saved: null, recWhy: null, recError: null, claude: null, setupWindow: false, setupError: null,
    driving: false,
  };
  // The setup window's run while it is open, and the tabs it has; the window counts as closed once the last tab goes.
  private desk: Run | null = null;
  private deskTabs = new Set<string>();
  private deskSeen = false;
  private closing = false;
  // The Claude in Chrome setup check: when it last ran, the one in flight, and a pending re-check after browser events.
  private claudeAt = 0;
  private claudeRun: Promise<void> | null = null;
  private claudeTimer: NodeJS.Timeout | null = null;
  // The recording taking frames; null once it is stopping. recDone settles when the last one is saved, for shutdown.
  private rec: Recording | null = null;
  private recDone: Promise<unknown> = Promise.resolve();
  private recChecked = false;
  // The newest recording, so a stop after it ended on its own still gets its file; claimed once a stop took it.
  private recLast: { rec: Recording; claimed: boolean } | null = null;
  // Panels that asked for the recordings library, and the startup cleanup a first listing waits for.
  private libraryViewers = new Set<WebSocket>();
  private pruned: Promise<unknown> = Promise.resolve();
  // Sockets that only hear tool activity, one per open app page, so a closed panel can still open itself.
  private watchers = new Set<WebSocket>();
  // Browser layers per session whose CLI runs; a panel pack among them keeps Chrome from idling out once it was used.
  private holds = new Map<string, BrowserTool[]>();
  // Tool calls running on this Chrome, by session and tool use id.
  private leases = new Map<string, { session: string; timer: NodeJS.Timeout }>();
  // Sessions whose CLI made a call here; its pack MCPs connect on first use, so only these hold a live DevTools link.
  private used = new Set<string>();
  // When the owner last sent input, and when the last screencast frame was acked, for pacing frames.
  private inputAt = 0;
  private ackAt = 0;
  // Largest monitor (CSS px) any panel reported, so the hidden screen fits it; null until one does.
  private monitor: { w: number; h: number } | null = null;
  private readonly port = wantedPort();
  // Insertion order is tab order.
  private tabs = new Map<string, BrowserTab>();
  private cdp: Cdp | null = null;
  // The current start's processes; null once stopped or failed.
  private cur: Run | null = null;
  // Starts and teardowns run one after another, so a new Chrome never meets the old one's profile, port or lock.
  private queue: Promise<void> = Promise.resolve();
  // CDP session of the active tab; only that tab is attached.
  private session: string | null = null;
  // The select in flight, and a counter so a superseded one detaches its session.
  private picking: { id: string; p: Promise<void> } | null = null;
  private picks = 0;
  // Token of the cursor script installed on the active tab's session, and its world per frame there.
  private cursorToken = '';
  private worlds = new Map<string, number>();
  // Key of the running screencast (session and size), '' when off.
  private streaming = '';
  private meta = { w: 0, h: 0 };
  // The newest screencast frame and the tab it came from, for a panel that opens while the page sits still.
  private lastFrame: { session: string; buf: Buffer } | null = null;
  // Bumps on every start and stop, so a step from an older run bails out.
  private run = 0;
  private idle: NodeJS.Timeout | null = null;
  private pushing: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private fitTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  // Viewport size (CSS px) the window was last fitted to.
  private fitted = '';
  // Device scale factor and hidden screen (device px) of the running Chrome. The next start takes the largest DPR among
  // open panels, else the last one seen.
  private scale = 1;
  private screen = SCREEN;
  private dpr = 1;
  // The panel extension's bridge device id for this run, once found.
  private device: { run: number; id: string } | null = null;
  private runJson = '';
  // The Chrome and display this machine has, found at boot and again on every start.
  private found: { chrome: Found | null; display: Display } | null = null;
  private supportFns = new Set<() => void>();

  // Every Chrome (group) and Xvfb not yet exited, including ones mid-teardown.
  private children = new Map<ChildProcess, boolean>();

  constructor() {
    // Never leave Chrome or Xvfb behind, even on an exit that skips shutdown().
    process.on('exit', () => {
      for (const [p, group] of this.children) if (!gone(p)) signal(p, group, 'SIGTERM');
    });
    onPerfChange((now, prev) => now !== prev && this.retune());
    onAgentsChange(() => {
      this.syncTools();
      this.review();
    });
    this.syncSupport();
    // In the queue, so a first start waits for it.
    this.queue = this.queue.then(() => this.sweepOrphans());
    // Sessions need to know before their first CLI whether Claude in Chrome can run on the panel.
    void this.detect(AbortSignal.timeout(2 * STEP_MS)).catch(() => {});
  }

  // The owner's switch: off, agents never start, hold or route to this Chrome; he can still use the panel himself.
  get agents() {
    return config.browserAgents;
  }

  // Why the panel cannot host Claude in Chrome on this machine, or null; then Claude in Chrome uses the user's own Chrome.
  get claudeWhyNot() {
    return this.state.unavailable.claude ?? null;
  }

  // Fires when what this machine can run on the panel changed.
  onSupport(fn: () => void) {
    this.supportFns.add(fn);
    return () => void this.supportFns.delete(fn);
  }

  private async detect(signal: AbortSignal) {
    const [chrome, display] = await Promise.all([findChrome(signal), findDisplay()]);
    this.found = { chrome, display };
    this.syncSupport();
    return this.found;
  }

  // Before detection finishes, Linux assumes the panel can host Claude in Chrome, so its calls stay checked.
  private syncSupport() {
    const f = this.found;
    const why = claudeLimit(f?.chrome ?? null, f?.display ?? (OS === 'linux' ? 'xvfb' : 'headless'));
    if (why === this.claudeWhyNot) return;
    this.set({ unavailable: why ? { claude: why } : {}, ...(why ? { claude: null } : {}) });
    if (!why && this.viewers.size) void this.checkClaude(true);
    for (const fn of this.supportFns) fn();
  }

  // Reads how far Claude in Chrome is set up in the panel profile. Files only, so it is cheap; still cached for
  // CLAUDE_TTL_MS unless forced (panel opened, Check again, a browser event that may have changed it).
  private checkClaude(force = false) {
    if (this.claudeRun) return this.claudeRun;
    if (!force && Date.now() - this.claudeAt < CLAUDE_TTL_MS) return Promise.resolve();
    const p = this.readClaude().catch((e) => console.log(`browser: checking the Claude in Chrome setup failed: ${fault(e)}`)).finally(() => {
      if (this.claudeRun === p) this.claudeRun = null;
    });
    return (this.claudeRun = p);
  }

  private async readClaude() {
    const { chrome } = this.found ?? (await this.detect(AbortSignal.timeout(2 * STEP_MS)));
    this.claudeAt = Date.now();
    if (this.claudeWhyNot) return void (this.state.claude && this.set({ claude: null }));
    // A host set up with /chrome after Chrome started gets copied now, so it works without a restart.
    if (chrome) await nativeHost(chrome).catch(() => {});
    const [extension, host, device] = await Promise.all([installedExtension(), hostReady(chrome), extensionDevice()]);
    if (this.claudeWhyNot) return;
    const desktop = this.found?.display === 'xvfb' && !!deskMode();
    this.set({ claude: { extension: !!extension, host, signedIn: !!device, flatpak: chrome?.kind === 'flatpak', desktop, checked: Date.now() } });
  }

  // Installing the extension or signing in shows up as extension targets and page loads; re-read soon after them.
  private claudeSoon() {
    const c = this.state.claude;
    if (this.claudeTimer || !c || (c.extension && c.host && c.signedIn) || ![...this.viewers.values()].some((v) => v.open)) return;
    this.claudeTimer = setTimeout(() => {
      this.claudeTimer = null;
      void this.checkClaude(true);
    }, 1500);
  }

  private track(p: ChildProcess, group: boolean) {
    this.children.set(p, group);
    p.once('exit', () => this.children.delete(p));
  }

  // The DevTools port the panel packs connect to.
  get devtoolsPort() {
    return this.port;
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const q = new URL(req.url ?? '/', 'http://local').searchParams;
    const got = Buffer.from(q.get('key') ?? '');
    const want = Buffer.from(this.key);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // A frame over maxPayload errors this socket only, and ws closes it.
      ws.on('error', (e) => console.log(`browser: socket error: ${fault(e)}`));
      if (q.has('watch')) this.watch(ws);
      else this.connect(ws);
    });
  }

  // A recording running or still being saved, so shutdown waits longer for its file.
  get recording() {
    return !!(this.rec || this.state.rec);
  }

  // A running recording is saved before the server exits.
  close() {
    this.closing = true;
    return Promise.all([this.closeSetup(), this.stop(), this.recDone]);
  }

  private watch(ws: WebSocket) {
    this.watchers.add(ws);
    ws.on('close', () => this.watchers.delete(ws));
    // The header icon can flip the agents switch; nothing else is taken from a watch socket.
    ws.on('message', (raw, binary) => {
      let m: BrowserClientMessage | null = null;
      try {
        m = binary ? null : JSON.parse(String(raw));
      } catch {}
      if (m?.type === 'agents') void this.setAgents(m.on);
    });
    this.sendTo(ws, this.runMessage());
  }

  private async setAgents(on: unknown) {
    if (typeof on !== 'boolean' || on === this.agents) return;
    const error = await saveSettings({ browserAgents: on });
    if (error) console.log(`browser: ${error}`);
  }

  private runMessage() {
    const { status } = this.state;
    const on = status === 'live' || status === 'starting';
    const why: BrowserWhy | null = !on ? null : [...this.viewers.values()].some((v) => v.open) ? 'panel' : this.kept() || this.leases.size ? 'session' : this.rec ? 'recording' : 'idle';
    return JSON.stringify({ type: 'run', status, why, agents: this.agents } satisfies BrowserServerMessage);
  }

  // Tells every page's header icon whether Chrome runs and why, only when that changed.
  private announce() {
    const json = this.runMessage();
    if (json === this.runJson) return;
    this.runJson = json;
    for (const ws of this.watchers) this.sendTo(ws, json);
  }

  // The panel extension's device id once Chrome is up; null when it is not stored yet.
  async claudeDevice() {
    const run = this.run;
    if (this.state.status !== 'live' || this.claudeWhyNot) return null;
    if (this.device?.run === run) return this.device.id;
    const id = await extensionDevice();
    if (id && run === this.run) this.device = { run, id };
    return id;
  }

  // Bumps on every start and stop, so callers can tell a restarted Chrome from the one they checked.
  get runId() {
    return this.run;
  }

  // A session's CLI started, stopped or changed packs.
  hold(session: string, tools: BrowserTool[]) {
    let dropped = false;
    if (!tools.length) {
      for (const [k, l] of this.leases) if (l.session === session) dropped = this.dropLease(k) || dropped;
      this.used.delete(session);
    }
    const was = this.holds.get(session);
    if (was ? was.join() === tools.join() : !tools.length) return void (dropped && this.review());
    if (tools.length) this.holds.set(session, tools);
    else this.holds.delete(session);
    this.syncTools();
    this.review();
  }

  private syncTools() {
    const all = this.agents ? [...new Set([...this.holds.values()].flat())].sort() : [];
    if (all.join() !== this.state.tools.join() || this.agents !== this.state.agents) this.set({ tools: all, agents: this.agents });
  }

  // A browser tool call keeps Chrome up until it ends, however long its permission prompt waits; its end restarts the
  // idle countdown. working() tells a pending call from an abandoned one once LEASE_MAX_MS passed.
  acquire(session: string, id: string, working: () => boolean) {
    const key = `${session}\0${id}`;
    this.dropLease(key);
    const lease = { session, timer: undefined as unknown as NodeJS.Timeout };
    const arm = () => (lease.timer = setTimeout(() => (working() ? arm() : this.release(session, id)), LEASE_MAX_MS));
    arm();
    this.leases.set(key, lease);
    this.used.add(session);
    this.syncDriving();
    this.review();
  }

  release(session: string, id: string) {
    if (this.dropLease(`${session}\0${id}`)) this.review();
  }

  // The session's turn ended or its CLI stopped, so none of its calls is still running.
  releaseAll(session: string) {
    let dropped = false;
    for (const [k, l] of this.leases) if (l.session === session) dropped = this.dropLease(k) || dropped;
    if (dropped) this.review();
  }

  private dropLease(key: string) {
    const l = this.leases.get(key);
    if (!l) return false;
    clearTimeout(l.timer);
    this.leases.delete(key);
    this.syncDriving();
    return true;
  }

  // The panel shows "Claude is using this tab" while any tool call runs on this Chrome.
  private syncDriving() {
    const on = this.leases.size > 0;
    if (on !== this.state.driving) this.set({ driving: on });
  }

  private kept() {
    if (!this.agents) return false;
    for (const [s, t] of this.holds) if (this.used.has(s) && (t.includes('playwright') || t.includes('devtools'))) return true;
    return false;
  }

  // A panel pack's tool call waits here, since its MCP server connects on first use. It overrides the owner's Stop.
  async ensure(until = Date.now() + 40_000) {
    // The profile can run only once, and the owner is using it in the setup window.
    if (this.state.setupWindow) throw new Error(SETUP_OPEN);
    const status = () => this.state.status;
    if (status() !== 'live') {
      if (this.state.held) this.set({ held: false });
      if (status() !== 'starting') void this.start();
      while (status() === 'starting' && Date.now() < until) await sleep(100);
      if (status() !== 'live') throw new Error(this.state.error ?? 'Chrome did not start in time.');
    }
    this.review();
  }

  // show_url: a new tab for the user to look at. It takes no lease, so the panel never reads as driven by an agent.
  async openPage(url: string, session: string) {
    await this.ensure();
    const cdp = this.cdp;
    if (!cdp || this.state.status !== 'live') throw new Error(this.state.error ?? 'Chrome stopped before the page could open.');
    const { targetId } = await cdp.send('Target.createTarget', { url });
    await this.select(targetId);
    const json = JSON.stringify({ type: 'show', session } satisfies BrowserServerMessage);
    for (const ws of this.watchers) this.sendTo(ws, json);
  }

  // Sessions report only calls that act on this Chrome; Claude in Chrome's are checked against its selected browser first.
  activity(tool: BrowserTool, session: string, turn: number) {
    if (!this.watchers.size || (tool === 'claude' && this.state.status !== 'live')) return;
    const json = JSON.stringify({ type: 'activity', tool, session, turn } satisfies BrowserServerMessage);
    for (const ws of this.watchers) this.sendTo(ws, json);
  }

  // Whether this machine can record, checked when a panel first connects or a recording starts; parts left by a
  // crashed run go then too.
  private recCheck() {
    if (this.recChecked) return;
    this.recChecked = true;
    this.pruned = sweepParts((p) => p === this.recLast?.rec.part).then(() => prune()).catch(() => {});
    void encoder().then((e) => this.set({ recWhy: e ? null : NO_FFMPEG }));
  }

  private async sendLibrary(to: Iterable<WebSocket>) {
    await this.pruned;
    const json = JSON.stringify({ type: 'recordings', list: await listRecordings() } satisfies BrowserServerMessage);
    for (const ws of to) this.sendTo(ws, json);
  }

  private pushLibrary() {
    if (this.libraryViewers.size) void this.sendLibrary(this.libraryViewers).catch(() => {});
  }

  // The panel's record button and browser_record both start here, on the active tab of a live Chrome.
  async recordStart(title: string | null) {
    const busy = () => (this.rec ? 'A recording is already running.' : this.state.rec ? 'The last recording is still being saved.' : null);
    if (busy()) throw new Error(busy()!);
    // A Chrome that just went live may still be attaching its first tab.
    for (let i = 0; i < 50 && this.state.status === 'live' && !this.session; i++) await sleep(100);
    if (this.state.status !== 'live' || !this.session) throw new Error('The browser is not running.');
    this.recCheck();
    const enc = await encoder();
    if (!enc) {
      this.set({ recWhy: NO_FFMPEG });
      throw new Error(NO_FFMPEG);
    }
    if (busy()) throw new Error(busy()!);
    if (this.state.status !== 'live') throw new Error('The browser is not running.');
    let done = () => {};
    this.recDone = new Promise<void>((ok) => (done = ok));
    const rec: Recording = new Recording(enc, title?.trim().slice(0, 80) || null, {
      spawned: (p) => this.track(p, false),
      // Frames stop going to it at once; the window and the screencast go back to following the panel.
      stopping: () => {
        if (this.rec !== rec) return;
        this.rec = null;
        this.set({ rec: { since: rec.since, title: rec.title, saving: true } });
        void this.syncStream();
        this.fit();
        this.review();
      },
      ended: (r) => {
        done();
        if (r instanceof Error) this.set({ rec: null, recError: r.message });
        else this.set({ rec: null, saved: videoOf(r), recError: null, recWhy: null });
        this.pushLibrary();
      },
    });
    this.rec = rec;
    this.recLast = { rec, claimed: false };
    this.set({ rec: { since: rec.since, title: rec.title }, recError: null, recWhy: null });
    void this.syncStream();
    this.review();
  }

  // Stops the running recording; one that already ended on its own (a cap, Chrome stopped) is returned once.
  recordStop(): Promise<Saved> {
    const last = this.recLast;
    if (!last || last.claimed) return Promise.reject(new Error('No recording is running.'));
    last.claimed = true;
    return last.rec.stop('stopped');
  }

  private connect(ws: WebSocket) {
    this.viewers.set(ws, { open: false, visible: false, w: 0, h: 0, dpr: 1 });
    this.recCheck();
    void this.checkClaude(true);
    this.sendTo(ws, JSON.stringify(this.stateMessage()));
    if (this.meta.w) this.sendTo(ws, JSON.stringify({ type: 'meta', ...this.meta } satisfies BrowserServerMessage));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      let msg: BrowserClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handle(ws, msg).catch((e) => console.log(`browser: ${msg?.type} failed: ${fault(e)}`));
    });
    ws.on('close', () => {
      this.viewers.delete(ws);
      this.libraryViewers.delete(ws);
      this.review();
    });
  }

  private async handle(ws: WebSocket, m: BrowserClientMessage) {
    const cdp = this.cdp;
    const s = this.session;
    if (m?.type === 'feedback') {
      if (!cdp || !s) return this.sendTo(ws, JSON.stringify({ type: 'feedback', error: 'The browser is not running' }));
      try {
        const item = await browserFeedback(cdp, s, m);
        if (item) this.sendTo(ws, JSON.stringify({ type: 'feedback', item } satisfies BrowserServerMessage));
      } catch (e) {
        if (m.action !== 'hover') this.sendTo(ws, JSON.stringify({ type: 'feedback', error: fault(e) } satisfies BrowserServerMessage));
      }
      return;
    }
    switch (m?.type) {
      case 'view': {
        const v = { open: m.open === true, visible: m.visible === true, w: num(m.w, 0, 8192), h: num(m.h, 0, 8192), dpr: num(m.dpr ?? 1, 0.5, 4) };
        const was = this.viewers.get(ws);
        this.viewers.set(ws, v);
        // A recording pins the screencast's size, so a panel shown mid-recording gets no first frame from a restart.
        const f = this.lastFrame;
        if (v.open && v.visible && !(was?.open && was.visible) && f?.session === this.session && this.state.status === 'live' && ws.readyState === WebSocket.OPEN) {
          if (this.meta.w) this.sendTo(ws, JSON.stringify({ type: 'meta', ...this.meta } satisfies BrowserServerMessage));
          ws.send(f.buf, { binary: true });
        }
        if (v.open) this.dpr = v.dpr;
        const sw = num(m.sw, 0, 16384);
        const sh = num(m.sh, 0, 16384);
        if (sw && sh) this.monitor = { w: Math.max(sw, this.monitor?.w ?? 0), h: Math.max(sh, this.monitor?.h ?? 0) };
        return this.review();
      }
      case 'start':
        this.set({ held: false });
        if (this.state.status === 'stopped' || this.state.status === 'error') return this.start();
        return;
      case 'stop':
        this.set({ held: true });
        return this.stop();
      case 'agents':
        return this.setAgents(m.on);
      case 'claude-check':
        return this.checkClaude(true);
      case 'setup-window':
        return m.open === true ? this.openSetup() : void this.closeSetup();
      case 'record':
        if (m.on === true) return void this.recordStart(null).catch((e) => this.set({ recError: fault(e) }));
        return void this.recordStop().catch(() => {});
      case 'record-delete': {
        const path = text(m.path, 4096);
        if (!path || !(await deleteRecording(path))) return;
        if (this.state.saved?.path === path) this.set({ saved: null });
        return this.pushLibrary();
      }
      case 'record-list':
        this.libraryViewers.add(ws);
        return this.sendLibrary([ws]);
      case 'record-clear': {
        // Between its rename and `ended`, the recording being saved is already a finished-looking file.
        const busy = this.state.rec && this.recLast ? this.recLast.rec.part.replace(/\.part$/, '') : '';
        await clearRecordings(busy);
        if (this.state.saved && this.state.saved.path !== busy) this.set({ saved: null });
        return this.pushLibrary();
      }
    }
    if (!cdp || this.state.status !== 'live') return;
    if (m.type === 'mouse' || m.type === 'key' || m.type === 'text') this.inputAt = Date.now();
    switch (m.type) {
      case 'navigate': {
        const url = text(m.url, 8000);
        if (url && s) await cdp.send('Page.navigate', { url }, s);
        return;
      }
      case 'back':
      case 'forward': {
        if (!s) return;
        const h = await cdp.send('Page.getNavigationHistory', {}, s);
        const entry = h.entries[h.currentIndex + (m.type === 'back' ? -1 : 1)];
        if (entry) await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, s);
        return;
      }
      case 'reload':
        if (s) await cdp.send('Page.reload', {}, s);
        return;
      case 'tab-new':
      case 'tab-open': {
        const url = m.type === 'tab-open' ? text(m.url, 8000) : 'about:blank';
        if (!url) return;
        const { targetId } = await cdp.send('Target.createTarget', { url });
        return this.select(targetId);
      }
      case 'tab-select':
        if (typeof m.id === 'string' && this.tabs.has(m.id)) return this.select(m.id);
        return;
      case 'tab-close': {
        if (typeof m.id !== 'string' || !this.tabs.has(m.id)) return;
        // Chrome quits with its last tab.
        if (this.tabs.size === 1) await cdp.send('Target.createTarget', { url: 'about:blank' });
        await cdp.send('Target.closeTarget', { targetId: m.id });
        return;
      }
      case 'mouse': {
        const type = MOUSE[m.kind];
        if (!type || !s) return;
        const wheel = m.kind === 'wheel';
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: num(m.x, 0, 1e5), y: num(m.y, 0, 1e5), modifiers: num(m.mods, 0, 15) | 0, twist: OWNER_TWIST,
          button: BUTTONS.includes(m.button) ? m.button : 'none', buttons: num(m.buttons, 0, 31) | 0, clickCount: num(m.clicks, 0, 3) | 0,
          ...(wheel ? { deltaX: num(m.dx, -1e4, 1e4), deltaY: num(m.dy, -1e4, 1e4) } : {}),
        }, s);
        return;
      }
      case 'key': {
        const key = text(m.key, 40);
        const chars = text(m.text, 8) ?? '';
        if (key === null || !s) return;
        const type = m.kind === 'up' ? 'keyUp' : chars ? 'keyDown' : 'rawKeyDown';
        const code = num(m.keyCode, 0, 255) | 0;
        await cdp.send('Input.dispatchKeyEvent', {
          type, key, code: text(m.code, 40) ?? '', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: num(m.mods, 0, 15) | 0,
          location: num(m.location, 0, 3) | 0, autoRepeat: m.repeat === true, ...(type === 'keyDown' ? { text: chars, unmodifiedText: chars } : {}),
        }, s);
        return;
      }
      case 'text': {
        const t = text(m.text, BROWSER_TEXT_MAX);
        if (t && s) await cdp.send('Input.insertText', { text: t }, s);
        return;
      }
    }
  }

  // Chrome runs while any panel is open, a session used a panel pack it still has, a tool call or a recording runs; the
  // screencast runs while a panel is visible or a recording takes frames.
  private review() {
    const open = [...this.viewers.values()].some((v) => v.open);
    if (!open && this.state.held) this.set({ held: false });
    if (open || this.kept() || this.leases.size || this.rec) {
      if (this.idle) clearTimeout(this.idle);
      this.idle = null;
      if (open && this.state.status === 'stopped' && !this.state.held && !this.state.setupWindow) void this.start();
    } else if (this.state.status !== 'stopped' && !this.idle) {
      this.idle = setTimeout(() => {
        this.idle = null;
        void this.stop();
      }, tuning().browserIdleMs);
    }
    void this.syncStream();
    this.fit();
    this.announce();
  }

  // A profile switch re-arms the idle countdown and the title poll, and restarts the screencast at the new quality.
  private retune() {
    if (this.idle) clearTimeout(this.idle);
    if (this.poll) clearInterval(this.poll);
    this.idle = this.poll = null;
    this.review();
  }

  // The window follows the largest visible panel, so the page fills it instead of being letterboxed.
  private fit() {
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.resize().catch((e) => console.log(`browser: resize failed: ${fault(e)}`));
    }, 120);
  }

  private async resize() {
    const cdp = this.cdp;
    const s = this.session;
    const id = this.state.active;
    const shown = [...this.viewers.values()].filter((v) => v.open && v.visible && v.w && v.h);
    // The window keeps its size while recording, so the video never changes scale mid-way.
    if (!cdp || !s || !id || !shown.length || this.state.status !== 'live' || this.rec) return;
    const big = shown.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    // Window bounds are in CSS px, the hidden screen in device px.
    const w = Math.min(Math.floor(this.screen.w / this.scale) - 240, Math.max(MIN_WIN.w, Math.round(big.w / big.dpr)));
    const h = Math.min(Math.floor(this.screen.h / this.scale) - 240, Math.max(MIN_WIN.h, Math.round(big.h / big.dpr)));
    if (`${w}x${h}` === this.fitted) return;
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: id });
    // The tab strip and toolbar sit around the viewport, so the window is the target plus what they take now. innerWidth
    // counts the scrollbar, which frames show too; the layout viewport leaves it out and made frames 15 px too wide.
    const inner = await cdp.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }, s).catch(() => null);
    let [vw, vh] = Array.isArray(inner?.result?.value) ? inner.result.value : [];
    if (typeof vw !== 'number' || typeof vh !== 'number' || !vw || !vh) {
      const { cssLayoutViewport: vp } = await cdp.send('Page.getLayoutMetrics', {}, s);
      [vw, vh] = [vp.clientWidth, vp.clientHeight];
    }
    const width = w + bounds.width - vw;
    const height = h + bounds.height - vh;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width, height, windowState: 'normal' } });
    this.fitted = `${w}x${h}`;
  }

  private start() {
    if (this.state.status === 'starting' || this.state.status === 'live' || this.state.setupWindow || this.closing) return this.queue;
    const r: Run = { run: ++this.run, abort: new AbortController(), lock: null, xvfb: null, chrome: null, cdp: null };
    this.cur = r;
    this.set({ status: 'starting', error: null, port: null });
    return (this.queue = this.queue.then(() => this.boot(r)));
  }

  // Never throws: a failure becomes the error state, and a start overtaken by a stop leaves its teardown to that stop.
  // Every step is bounded and gives up when the run goes stale, so the queue (and Stop behind it) always moves on.
  private async boot(r: Run) {
    const stale = () => r.run !== this.run;
    const signal = r.abort.signal;
    try {
      if (stale()) return;
      await mkdir(PROFILE, { recursive: true });
      await this.claim(r);
      if (stale()) return;
      if (!(await this.portReady())) {
        throw new Error(`Port ${this.port} is taken by another program, so the panel's Chrome cannot open DevTools there. Close that program, or set browser.port in the config (or CW_BROWSER_PORT) and restart the app.`);
      }
      // Common steps (1, 1.25, 1.5, 2...) so a fractional DPR maps to what Chrome renders well.
      this.scale = Math.min(3, Math.max(1, Math.round(Math.max(this.dpr, ...[...this.viewers.values()].filter((v) => v.open).map((v) => v.dpr)) * 4) / 4));
      // Xvfb's framebuffer is resident memory, so it fits the panel's monitor once one reported it (~25 MB less at 1080p).
      const css = this.monitor ? { w: this.monitor.w + SCREEN_PAD, h: this.monitor.h + SCREEN_PAD } : SCREEN;
      this.screen = { w: Math.min(SCREEN_MAX.w, Math.round(css.w * this.scale)), h: Math.min(SCREEN_MAX.h, Math.round(css.h * this.scale)) };
      const { chrome: found, display } = await this.detect(signal);
      if (stale()) return;
      if (!found) throw new Error(OS ? (snapSkipped ? `${NO_BROWSER} A snap browser was found but snap builds are not supported (they cannot read the panel's profile), so use a non-snap build.` : NO_BROWSER) : UNSUPPORTED);
      const engine = launch(found, this.port, this.scale, display);
      this.set({ engine: display === 'headless' ? `${engine.label} (headless)` : engine.label });
      if (!this.claudeWhyNot) await nativeHost(found).catch((e) => console.log(`browser: native host setup failed: ${fault(e)}`));
      let env = baseEnv();
      let xvfb: ChildProcess | null = null;
      if (display === 'xvfb') {
        await writeXauth();
        if (stale()) return;
        xvfb = r.xvfb = spawnDisplay(this.screen);
        this.track(xvfb, false);
        env = await displayEnv(xvfb, signal);
        if (stale()) return;
        if (gone(xvfb)) throw new Error('The hidden display closed.');
        xvfb.once('exit', () => !stale() && this.fail('The hidden display closed.'));
      }
      if (stale()) return;
      let err = '';
      const chrome = spawn(engine.cmd, engine.args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      r.chrome = chrome;
      this.track(chrome, true);
      chrome.stderr!.on('data', (d: Buffer) => (err = (err + d).slice(-4000)));
      chrome.once('error', (e) => !stale() && this.fail(`Chrome failed to start: ${e.message}`));
      chrome.once('exit', (code, sig) => !stale() && this.fail(`Chrome closed unexpectedly (${sig ?? `exit code ${code}`}). ${tail(err)}`.trim()));
      const tmp = await writeAside(OWNER, { server: process.pid, run: r.run, xvfb: xvfb?.pid, chrome: chrome.pid });
      await rename(tmp, OWNER);
      const path = await this.waitPort(r, chrome);
      const ws = await Cdp.open(`ws://127.0.0.1:${this.port}${path}`, signal);
      const cdp: Cdp = new Cdp(ws, (m, p, s) => this.cdp === cdp && this.onEvent(m, p, s), () => !stale() && this.fail('Lost the DevTools connection.'));
      r.cdp = cdp;
      if (stale()) return;
      this.cdp = cdp;
      await timed(cdp.send('Target.setDiscoverTargets', { discover: true }), STEP_MS, 'target discovery', signal);
      const { targetInfos } = await timed(cdp.send('Target.getTargets'), STEP_MS, 'the tab list', signal);
      if (stale()) return;
      for (const t of targetInfos) if (t.type === 'page' && !t.subtype) this.tabs.set(t.targetId, { id: t.targetId, title: t.title, url: t.url });
      const first = [...this.tabs.keys()].at(-1) ?? (await timed(cdp.send('Target.createTarget', { url: 'about:blank' }), STEP_MS, 'a new tab', signal)).targetId;
      if (stale()) return;
      this.set({ status: 'live', port: this.port });
      // The native host was just copied, and a policy may install the extension on a first run.
      void this.checkClaude(true);
      this.fitted = '';
      await timed(this.select(first), STEP_MS, 'the first tab', signal);
      this.fit();
    } catch (e) {
      if (!stale()) this.fail(fault(e));
    }
  }

  // A Chrome killed by claim() may free the port a moment later.
  private async portReady() {
    for (let i = 0; i < 8; i++) {
      if (await portFree(this.port)) return true;
      await sleep(250);
    }
    return false;
  }

  // One server per profile: the lock keeps it, and a dead owner's leftovers are cleared once the lock is ours.
  private async claim(r: Run) {
    r.lock = await this.lock();
    await this.clearLeftovers();
    await rename(await writeAside(OWNER, { server: process.pid, run: r.run }), OWNER);
  }

  // Only call with the lock held: no live server owns the profile then, so whatever still holds it is a dead one's.
  private async clearLeftovers() {
    const prev = await readOwner();
    // Only an Xvfb on this profile's cookie file, in case its pid was reused.
    if (prev?.xvfb && prev.server !== process.pid) {
      const args = await cmdline(prev.xvfb);
      if (args[0]?.endsWith('Xvfb') && args.includes(XAUTH)) signal({ pid: prev.xvfb } as ChildProcess, false, 'SIGTERM');
    }
    const stale = await profileProcs();
    for (const pid of stale) signal({ pid } as ChildProcess, false, 'SIGTERM');
    if (stale.length) await sleep(1500);
    for (const pid of await profileProcs()) signal({ pid } as ChildProcess, false, 'SIGKILL');
    // No process holds the profile now; a lock left by a killed Chrome would make the next one hang on a hidden dialog.
    await Promise.all(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'].map((f) => rm(join(PROFILE, f), { force: true })));
    return prev;
  }

  // A crashed server leaves its Chrome and Xvfb running until the next start; this clears them at boot instead.
  private async sweepOrphans() {
    if (!OS || !(await access(PROFILE).then(() => true, () => false))) return;
    const lock = await takeLock().catch(() => null);
    if (!lock) return;
    try {
      const prev = await this.clearLeftovers();
      if (prev?.server && prev.server !== process.pid) await rm(OWNER, { force: true });
    } catch (e) {
      console.log(`browser: clearing leftovers failed: ${fault(e)}`);
    } finally {
      await new Promise<void>((ok) => lock.close(() => ok()));
    }
  }

  // Listening on the lock fails while another process holds it, so two servers never both own the profile.
  private async lock() {
    if (!OS) throw new Error(UNSUPPORTED);
    const s = await takeLock();
    if (s) return s.unref();
    const o = await readOwner();
    const by = o?.server && o.server !== process.pid && alive(o.server) ? ` (pid ${o.server})` : '';
    throw new Error(`Another tarcsweb server${by} is using this browser.`);
  }

  // owner.json goes only when this run wrote it; the lock goes with the socket.
  private async unlock(r: Run) {
    const s = r.lock;
    r.lock = null;
    const o = await readOwner();
    if (o?.server === process.pid && o.run === r.run) await rm(OWNER, { force: true });
    await new Promise<void>((ok) => s?.close(() => ok()) ?? ok());
  }

  // Chrome writes DevToolsActivePort only for port 0, so the fixed port is asked for its browser endpoint.
  private async waitPort(r: Run, chrome: ChildProcess, stale = () => r.run !== this.run) {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      if (stale() || gone(chrome)) throw new Error('Chrome stopped before it was ready.');
      try {
        const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.any([r.abort.signal, AbortSignal.timeout(1000)]) })).json();
        const path = typeof v?.webSocketDebuggerUrl === 'string' ? new URL(v.webSocketDebuggerUrl).pathname : '';
        if (path) return path;
      } catch {}
      await sleep(150);
    }
    throw new Error(`Chrome did not open its DevTools port (${this.port}) within 30 s.`);
  }

  // Resolves once this run's Chrome and Xvfb are gone; a start that comes meanwhile waits behind that teardown.
  private stop() {
    ++this.run;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const r = this.cur;
    r?.abort.abort();
    this.reset();
    this.set({ status: 'stopped', error: null, port: null });
    void this.rec?.stop('chrome').catch(() => {});
    return (this.queue = this.queue.then(() => this.teardown(r, true)));
  }

  private fail(error: string) {
    ++this.run;
    const r = this.cur;
    r?.abort.abort();
    this.reset();
    this.set({ status: 'error', error, port: null });
    void this.rec?.stop('chrome').catch(() => {});
    console.log(`browser: ${error}`);
    this.queue = this.queue.then(() => this.teardown(r, false));
  }

  private reset() {
    this.cur = null;
    this.cdp = null;
    this.session = null;
    this.worlds.clear();
    this.picking = null;
    this.streaming = '';
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.tabs.clear();
    this.state = { ...this.state, active: null, canBack: false, canForward: false, loading: false };
  }

  // Browser.close lets Chrome save cookies; signals follow if it hangs, Xvfb goes last so Chrome never loses its display
  // mid-save, and the lock goes once both are gone.
  private async teardown(r: Run | null, graceful: boolean) {
    if (!r) return;
    try {
      const { cdp, chrome, xvfb } = r;
      if (cdp && graceful && chrome && !gone(chrome)) await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(1500)]);
      cdp?.close();
      if (chrome) await end(chrome, true, graceful ? 3000 : 500);
      if (xvfb) await end(xvfb, false, 0);
    } catch (e) {
      console.log(`browser: teardown failed: ${fault(e)}`);
    } finally {
      if (r.lock) await this.unlock(r).catch((e) => console.log(`browser: unlock failed: ${fault(e)}`));
    }
  }

  // Opens the panel's profile as a normal window on the owner's desktop, for what the panel cannot show: the Web Store's
  // Add dialog and the extension's sign-in. The panel's own Chrome stops first, since a profile runs only once.
  private async openSetup() {
    if (this.state.setupWindow || this.closing) return;
    const f = this.found ?? (await this.detect(AbortSignal.timeout(2 * STEP_MS)).catch(() => null));
    if (this.state.setupWindow || this.closing) return;
    const why = !f?.chrome || f.display !== 'xvfb' || this.claudeWhyNot || !deskMode() ? 'The setup window needs a desktop display and a Chrome that can run Claude in Chrome.'
      : this.leases.size ? 'An agent is using the browser right now. Try again once its call ends.'
      : this.rec || this.state.rec ? 'Stop the recording first.' : null;
    if (why) return this.set({ setupError: why });
    this.set({ setupWindow: true, setupError: null, held: false });
    void this.stop();
    const r: Run = { run: this.run, abort: new AbortController(), lock: null, xvfb: null, chrome: null, cdp: null };
    this.desk = r;
    this.deskTabs.clear();
    this.deskSeen = false;
    this.queue = this.queue.then(() => this.deskBoot(r));
  }

  // Runs in the queue behind the panel Chrome's teardown. Same engine, profile, mute flags and DevTools port as the panel.
  private async deskBoot(r: Run) {
    const stale = () => this.desk !== r;
    const signal = r.abort.signal;
    try {
      if (stale()) return;
      await mkdir(PROFILE, { recursive: true });
      await this.claim(r);
      if (stale()) return;
      if (!(await this.portReady())) throw new Error(`Port ${this.port} is taken by another program, so the setup window cannot open DevTools there.`);
      const { chrome: found } = await this.detect(signal);
      const desk = deskMode();
      if (stale()) return;
      if (!found || !desk) throw new Error('No Chrome or desktop display was found for the setup window.');
      await nativeHost(found).catch((e) => console.log(`browser: native host setup failed: ${fault(e)}`));
      const url = await setupUrl();
      if (stale()) return;
      const engine = launch(found, this.port, 1, desk);
      let err = '';
      const chrome = spawn(engine.cmd, [...engine.args, url], { env: baseEnv(desk), detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      r.chrome = chrome;
      this.track(chrome, true);
      chrome.stderr!.on('data', (d: Buffer) => (err = (err + d).slice(-4000)));
      chrome.once('error', (e) => this.deskGone(r, `The setup window could not open: ${e.message}`));
      // The owner closing the window ends Chrome; an exit before any tab showed up is a failed start.
      chrome.once('exit', (code, sig) => this.deskGone(r, this.deskSeen || code === 0 ? null : `The setup window closed (${sig ?? `exit code ${code}`}). ${tail(err)}`.trim()));
      await rename(await writeAside(OWNER, { server: process.pid, run: r.run, chrome: chrome.pid }), OWNER);
      const path = await this.waitPort(r, chrome, stale);
      const ws = await Cdp.open(`ws://127.0.0.1:${this.port}${path}`, signal);
      // Without DevTools the window's close cannot be seen, so a lost link ends the setup.
      r.cdp = new Cdp(ws, (m, p) => !stale() && this.deskEvent(m, p), () => void (!stale() && this.deskGone(r, null)));
      if (stale()) return;
      await timed(r.cdp.send('Target.setDiscoverTargets', { discover: true }), STEP_MS, 'target discovery', signal);
    } catch (e) {
      if (!stale()) this.deskGone(r, fault(e));
    }
  }

  // Tracks the window's tabs, and re-reads the setup as the owner installs the extension or signs in.
  private deskEvent(method: string, p: any) {
    const t = p?.targetInfo;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.claudeSoon();
      if (t?.type !== 'page' || t.subtype) return;
      this.deskTabs.add(t.targetId);
      this.deskSeen = true;
    } else if (method === 'Target.targetDestroyed' && this.deskTabs.delete(p.targetId) && !this.deskTabs.size) {
      // The last tab went with its window; Chrome may stay up in the background for an extension.
      void this.closeSetup();
    }
  }

  // The teardown's Browser.close lets Chrome save a new login before any signal.
  private closeSetup() {
    return this.desk ? this.deskGone(this.desk, null) : Promise.resolve();
  }

  // The window closed, crashed or failed to open: its Chrome goes, the setup is read again once Chrome flushed its files,
  // and an open panel starts its own Chrome again behind that.
  private deskGone(r: Run, error: string | null) {
    if (this.desk !== r) return this.queue;
    this.desk = null;
    this.deskTabs.clear();
    r.abort.abort();
    if (error) console.log(`browser: ${error}`);
    this.set({ setupWindow: false, setupError: error });
    this.queue = this.queue.then(() => this.teardown(r, true)).then(() => this.claudeRun).then(() => this.checkClaude(true));
    this.review();
    return this.queue;
  }

  private onEvent(method: string, p: any, session?: string) {
    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const t = p.targetInfo;
        if (method === 'Target.targetCreated' && String(t.url).startsWith('chrome-extension://')) this.claudeSoon();
        // A subtype marks a prerender or other hidden page, not a tab.
        if (t.type !== 'page' || t.subtype) return;
        const fresh = !this.tabs.has(t.targetId);
        this.tabs.set(t.targetId, { id: t.targetId, title: t.title, url: t.url });
        // A page's popup or target=_blank tab is shown at once; any other tab (an agent's, maybe in the background) is
        // followed by sweep() only once it is really in front.
        if (fresh && t.openerId && this.state.status === 'live') void this.select(t.targetId).catch(() => {});
        else if (t.targetId !== this.state.active) this.sweepSoon();
        return this.push();
      }
      case 'Target.targetDestroyed': {
        if (!this.tabs.delete(p.targetId)) return;
        if (this.state.active === p.targetId) {
          this.session = null;
          this.worlds.clear();
          this.streaming = '';
          const next = [...this.tabs.keys()].at(-1);
          if (next) void this.select(next).catch(() => {});
        }
        return this.push();
      }
      case 'Target.detachedFromTarget':
        if (p.sessionId === this.session) {
          this.session = null;
          this.worlds.clear();
          this.streaming = '';
        }
        return;
    }
    if (!session || session !== this.session) return;
    switch (method) {
      case 'Page.screencastFrame':
        return this.frame(p, session);
      case 'Runtime.bindingCalled':
        if (p.name === CURSOR_BINDING) this.cursor(p.payload);
        return;
      case 'Page.frameNavigated':
        if (!p.frame.parentId) void this.history();
        // The old document took its world along.
        this.worlds.delete(p.frame.id);
        void this.watchCursor(session, p.frame.id);
        return;
      case 'Page.frameDetached':
        this.worlds.delete(p.frameId);
        return;
      case 'Page.navigatedWithinDocument':
        this.sweepSoon();
        return void this.history();
      case 'Page.frameStartedLoading':
      case 'Page.frameStoppedLoading':
        // The main frame's id is the tab's target id.
        if (p.frameId !== this.state.active) return;
        this.set({ loading: method === 'Page.frameStartedLoading' });
        if (method !== 'Page.frameStoppedLoading') return;
        this.sweepSoon();
        this.claudeSoon();
        return;
    }
  }

  private sweepSoon() {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweep();
    }, 150);
  }

  // Chrome sends targetInfoChanged on URL changes only, so titles are read after loads and on a slow poll while shown.
  // An agent switching tabs (Target.activateTarget, Page.bringToFront) sends no event at all; /json/list puts the last
  // activated tab first, so once the shown tab went hidden the panel follows that one.
  private async sweep() {
    const cdp = this.cdp;
    const picks = this.picks;
    if (!cdp || this.sweeping) return;
    this.sweeping = true;
    try {
      const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1000) })).json().catch(() => null);
      if (cdp !== this.cdp || !Array.isArray(list)) return;
      let changed = false;
      let front: string | null = null;
      for (const t of list) {
        const tab = typeof t?.id === 'string' ? this.tabs.get(t.id) : undefined;
        if (!tab || t.type !== 'page') continue;
        front ??= t.id;
        if (tab.title === t.title && tab.url === t.url) continue;
        this.tabs.set(t.id, { id: t.id, title: String(t.title ?? ''), url: String(t.url ?? '') });
        changed = true;
      }
      if (changed) this.push();
      const s = this.session;
      if (!front || !s || front === this.state.active || this.picking || picks !== this.picks) return;
      // A tab opened in the background also sorts first, so the shown tab must really be hidden.
      const r = await timed(cdp.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, s), 1000, 'a visibility check').catch(() => null);
      if (r?.result?.value === 'hidden' && s === this.session && picks === this.picks && this.tabs.has(front)) void this.select(front).catch(() => {});
    } catch {
    } finally {
      this.sweeping = false;
    }
  }

  // Concurrent selects of one tab share a single attach.
  private select(id: string): Promise<void> {
    if (this.picking?.id === id) return this.picking.p;
    if (this.state.active === id && this.session) return Promise.resolve();
    const p: Promise<void> = this.attach(id).finally(() => {
      if (this.picking?.p === p) this.picking = null;
    });
    this.picking = { id, p };
    return p;
  }

  private async attach(id: string) {
    const cdp = this.cdp;
    if (!cdp) return;
    const n = ++this.picks;
    const old = this.session;
    this.session = null;
    this.streaming = '';
    this.rec?.hideCursor();
    this.set({ active: id, loading: false });
    // The old tab's cursor scripts go off before the detach, so they keep no listeners or events in its document.
    const worlds = [...this.worlds.values()];
    this.worlds.clear();
    if (old) void this.cursorOff(cdp, old, worlds).then(() => cdp.send('Target.detachFromTarget', { sessionId: old })).catch(() => {});
    await cdp.send('Target.activateTarget', { targetId: id }).catch(() => {});
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: id, flatten: true });
    // A newer select took over meanwhile.
    if (this.cdp !== cdp || n !== this.picks) return void cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    this.session = sessionId;
    this.cursorToken = randomBytes(6).toString('hex');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId);
    await Promise.all([this.history(), this.syncStream(), this.watchFrames(sessionId, id)]);
  }

  // Frames already loaded get the script on attach; later documents get it from frameNavigated.
  private async watchFrames(s: string, main: string) {
    const tree = await this.cdp?.send('Page.getFrameTree', {}, s).catch(() => null);
    const ids: string[] = [];
    const walk = (n: any) => {
      if (typeof n?.frame?.id !== 'string') return;
      ids.push(n.frame.id);
      for (const c of n.childFrames ?? []) walk(c);
    };
    walk(tree?.frameTree);
    await Promise.all((ids.length ? ids : [main]).map((f) => this.watchCursor(s, f)));
  }

  // Runs on attach and on every frame's new document. Runtime stays disabled (it would stream console traffic), and then
  // a binding reaches only contexts that exist when it is added, so it is added after the world. Cross-origin frames fail.
  private async watchCursor(s: string, frameId: string) {
    const cdp = this.cdp;
    if (!cdp) return;
    try {
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: CURSOR_WORLD }, s);
      await cdp.send('Runtime.addBinding', { name: CURSOR_BINDING, executionContextName: CURSOR_WORLD }, s);
      await cdp.send('Runtime.evaluate', { expression: cursorScript(this.cursorToken), contextId: executionContextId }, s);
      // The tab was switched meanwhile, so this copy goes off at once.
      if (s !== this.session || cdp !== this.cdp) return void this.cursorOff(cdp, s, [executionContextId]);
      // An attach and a navigation can both install into one document; only the newest copy stays on.
      const prev = this.worlds.get(frameId);
      this.worlds.set(frameId, executionContextId);
      if (prev !== undefined && prev !== executionContextId) void this.cursorOff(cdp, s, [prev]);
    } catch {}
  }

  private cursorOff(cdp: Cdp, s: string, worlds: number[]) {
    const off = (contextId: number) => cdp.send('Runtime.evaluate', { expression: `globalThis.${CURSOR_OFF}?.()`, contextId }, s).catch(() => {});
    return timed(Promise.all(worlds.map(off)), 1000, 'the cursor cleanup').catch(() => {});
  }

  // Goes to visible panels only, like frames.
  private cursor(payload: unknown) {
    const [token, kind, x, y, s] = String(payload).split(' ');
    const px = Number(x);
    const py = Number(y);
    if (token !== this.cursorToken || (kind !== 'move' && kind !== 'down') || !Number.isFinite(px) || !Number.isFinite(py)) return;
    this.rec?.cursor(kind, px, py);
    const shape: CursorShape = s === 'hand' || s === 'text' ? s : 'arrow';
    const json = JSON.stringify({ type: 'cursor', kind, x: px, y: py, shape } satisfies BrowserServerMessage);
    for (const [ws, v] of this.viewers) if (v.visible) this.sendTo(ws, json);
  }

  private async history() {
    const s = this.session;
    if (!this.cdp || !s) return;
    const h = await this.cdp.send('Page.getNavigationHistory', {}, s).catch(() => null);
    if (h && s === this.session) this.set({ canBack: h.currentIndex > 0, canForward: h.currentIndex < h.entries.length - 1 });
  }

  // Frames are sized to the largest visible panel (in device px), never past the viewport. A recording takes them at
  // the viewport's own size, capped at REC_SIZE, whether a panel shows them or not.
  private async syncStream() {
    const cdp = this.cdp;
    const s = this.session;
    const rec = !!this.rec;
    const shown = [...this.viewers.values()].filter((v) => v.open && v.visible);
    const step = (v: number, max: number) => Math.min(max, Math.max(320, Math.ceil(v / 64) * 64));
    const w = rec ? Math.min(this.screen.w, REC_SIZE.w) : step(Math.max(0, ...shown.map((v) => v.w)) || WIN.w * this.scale, this.screen.w);
    const h = rec ? Math.min(this.screen.h, REC_SIZE.h) : step(Math.max(0, ...shown.map((v) => v.h)) || WIN.h * this.scale, this.screen.h);
    // A recording keeps small text sharp; the panel alone follows the profile's quality.
    const q = rec ? 95 : tuning().browserQuality;
    const want = cdp && s && (shown.length || rec) && this.state.status === 'live' ? `${s}:${w}x${h}:${q}` : '';
    if (!want && this.poll) clearInterval(this.poll);
    if (!want) this.poll = null;
    else if (!this.poll) {
      this.poll = setInterval(() => void this.sweep(), tuning().browserTitleMs);
      this.sweepSoon();
    }
    if (want === this.streaming) return;
    const was = this.streaming;
    this.streaming = want;
    if (!cdp || !s) return;
    if (was.startsWith(`${s}:`)) await cdp.send('Page.stopScreencast', {}, s).catch(() => {});
    if (want && this.streaming === want) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: q, maxWidth: w, maxHeight: h, everyNthFrame: 1 }, s).catch(() => {});
  }

  // The ack waits until the frame left for every viewer, so a slow socket slows Chrome down instead of queueing. Acks
  // are also spaced out, more widely once the owner stops giving input; a recording keeps the faster pace.
  private frame(p: any, session: string) {
    const w = Math.round(p.metadata.deviceWidth);
    const h = Math.round(p.metadata.deviceHeight);
    if (w !== this.meta.w || h !== this.meta.h) {
      this.meta = { w, h };
      this.broadcast(JSON.stringify({ type: 'meta', w, h } satisfies BrowserServerMessage));
    }
    const buf = Buffer.from(p.data, 'base64');
    this.lastFrame = { session, buf };
    this.rec?.frame(buf, p.metadata.deviceWidth);
    const sent: Promise<void>[] = [];
    for (const [ws, v] of this.viewers) {
      if (!v.visible || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 4 << 20) continue;
      sent.push(new Promise((ok) => ws.send(buf, { binary: true }, () => ok())));
    }
    void Promise.all(sent).then(() => {
      const t = tuning();
      const now = Date.now();
      const gap = !this.rec && now - this.inputAt > t.browserInputIdleMs ? t.browserIdleFrameMs : t.browserFrameMs;
      const wait = Math.max(0, this.ackAt + gap - now);
      const ack = () => {
        this.ackAt = Date.now();
        if (this.session === session) this.cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }, session).catch(() => {});
      };
      if (wait) setTimeout(ack, wait);
      else ack();
    });
  }

  private set(patch: Partial<BrowserState>) {
    this.state = { ...this.state, ...patch };
    this.push();
    if (patch.status) this.announce();
  }

  private stateMessage(): BrowserServerMessage {
    return { type: 'state', state: { ...this.state, tabs: [...this.tabs.values()] } };
  }

  // Title and URL changes come in bursts; one state message per 40 ms is plenty.
  private push() {
    if (this.pushing) return;
    this.pushing = setTimeout(() => {
      this.pushing = null;
      this.broadcast(JSON.stringify(this.stateMessage()));
    }, 40);
  }

  private broadcast(json: string) {
    for (const ws of this.viewers.keys()) this.sendTo(ws, json);
  }

  private sendTo(ws: WebSocket, json: string) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

export const browser = new BrowserHost();
