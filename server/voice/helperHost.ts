import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { CACHE_DIR } from '../config.ts';
import { IN_TAURI } from '../shell.ts';
import { findUserChrome } from '../userChrome.ts';
import { tuning } from '../profile.ts';
import { Cdp } from '../cdp.ts';
import type { HelperClientMessage, HelperServerMessage } from '../protocol.ts';
import { recoverOwned, identity, sweepHelpers, type Owner } from './helperProcess.ts';

export type Reservation = {
  owner: object; callId: string; runId: string; token: string; abort: AbortController;
  muted: boolean; seq: number; meter: boolean; held: boolean; offer: number;
  socket?: WebSocket; supervisor?: ChildProcess; owned?: Owner; dir?: string; cdp?: Cdp; stopped?: Promise<void>; recovered?: Promise<void>;
};
const root = join(CACHE_DIR, 'voice-helper');
const flags = ['--headless=new', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-default-apps', '--disable-background-networking', '--no-first-run', '--disable-background-timer-throttling', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--autoplay-policy=no-user-gesture-required', '--no-default-browser-check', '--disable-component-update', '--disable-sync', '--disable-features=MediaRouter,OptimizationHints,Translate', '--renderer-process-limit=1', '--password-store=basic'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modules = new Map<string, Promise<string>>();
export class VoiceHelpers {
  private reservations = new Map<object, Reservation>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: tuning().helperPayloadBytes, perMessageDeflate: false });
  private pending = 0;
  private origin = '';
  private swept: Promise<void> = Promise.resolve();
  configure(port: number) {
    this.origin = `http://127.0.0.1:${port}`;
    if (IN_TAURI && process.platform === 'linux') this.swept = sweepHelpers(root);
  }
  private message: (r: Reservation, m: Exclude<HelperClientMessage, { type: 'helper-hello' }>) => void;
  private failed: (r: Reservation, error: string) => void;
  constructor(message: VoiceHelpers['message'], failed: VoiceHelpers['failed']) { this.message = message; this.failed = failed; }
  get(owner: object) { return this.reservations.get(owner); }
  reserve(owner: object, callId: string) {
    if (!IN_TAURI || process.platform !== 'linux' || !this.origin) throw new Error('Voice helper is unavailable in this window.');
    const r: Reservation = { owner, callId, runId: randomUUID(), token: randomBytes(32).toString('hex'), abort: new AbortController(), muted: false, seq: 0, meter: false, held: false, offer: 0 };
    this.reservations.set(owner, r);
    void this.launch(r).catch((e) => { if (this.current(r)) this.failed(r, e instanceof Error ? e.message : 'Voice helper failed.'); void this.stop(r); });
    return r;
  }
  private current(r: Reservation) { return this.reservations.get(r.owner) === r && !r.abort.signal.aborted; }
  private check(r: Reservation) { if (!this.current(r)) throw new Error('Voice helper stopped.'); }
  send(r: Reservation, m: HelperServerMessage) { if (this.current(r) && r.socket?.readyState === WebSocket.OPEN) r.socket.send(JSON.stringify(m)); }
  control(r: Reservation, values: { muted?: boolean; seq?: number; meter?: boolean; held?: boolean }) {
    Object.assign(r, values);
    this.send(r, { type: 'helper-control', runId: r.runId, ...values });
  }
  async serve(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/voice-helper' && !path.startsWith('/voice-helper/')) return false;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'microphone=(self), camera=()', 'Content-Security-Policy': `default-src 'none'; script-src 'self'; connect-src ${this.origin.replace('http:', 'ws:')}; frame-ancestors 'none'` };
    if (req.method !== 'GET' || !['/voice-helper', '/voice-helper/helper.ts', '/voice-helper/media.ts'].includes(path)) { res.writeHead(404, headers).end(); return true; }
    if (path === '/voice-helper') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html><head><meta charset="utf-8"><title>Voice helper</title></head><body><script type="module" src="/voice-helper/helper.ts"></script></body></html>'); return true; }
    if (!modules.has(path)) modules.set(path, readFile(new URL(`.${path.slice('/voice-helper'.length)}`, import.meta.url), 'utf8').then((s) => stripTypeScriptTypes(s)));
    try { const js = await modules.get(path)!; res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }).end(js); }
    catch { modules.delete(path); res.writeHead(503, headers).end(); }
    return true;
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const peer = req.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(peer ?? '') || req.headers.origin !== this.origin || req.headers.host !== new URL(this.origin).host || this.pending >= tuning().helperPendingMax) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.pending++;
      let r: Reservation | undefined;
      let pending = true;
      const release = () => { if (pending) { pending = false; this.pending--; } };
      const timer = setTimeout(() => ws.terminate(), tuning().helperHelloMs);
      let at = Date.now(), count = 0, levelAt = 0;
      ws.on('error', () => {});
      ws.on('close', () => { clearTimeout(timer); release(); if (r && this.current(r)) { this.failed(r, 'The voice helper disconnected.'); void this.stop(r); } });
      ws.on('message', (raw, binary) => {
        if (Date.now() - at >= 1000) { at = Date.now(); count = 0; }
        if (binary || ++count > tuning().helperMessagesPerSec) return ws.terminate();
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return ws.terminate(); }
        if (!m || typeof m !== 'object') return ws.terminate();
        if (!r) {
          const candidate = [...this.reservations.values()].find((x) => x.runId === m.runId);
          if (m.type !== 'helper-hello' || m.version !== 1 || typeof m.token !== 'string' || !/^[0-9a-f]{64}$/.test(m.token) || !candidate || !this.current(candidate) || candidate.socket || !candidate.token || !timingSafeEqual(Buffer.from(m.token), Buffer.from(candidate.token))) return ws.terminate();
          r = candidate; r.token = ''; r.socket = ws; release(); clearTimeout(timer);
          this.send(r, { type: 'helper-ready', callId: r.callId, runId: r.runId, muted: r.muted, seq: r.seq, meter: r.meter, held: r.held, levelsMs: tuning().helperLevelsMs });
          return;
        }
        if (!this.current(r) || m.runId !== r.runId) return ws.terminate();
        switch (m.type) {
          case 'helper-offer':
            if (!Number.isSafeInteger(m.offer) || m.offer <= r.offer || typeof m.sdp !== 'string' || !m.sdp.length || m.sdp.length > 64_000) return ws.terminate();
            r.offer = m.offer; break;
          case 'helper-media':
            if (!Number.isSafeInteger(m.offer) || !['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(m.peer) || !['pending', 'playing', 'blocked'].includes(m.playback) || typeof m.muted !== 'boolean' || !Number.isSafeInteger(m.seq) || m.seq < 0) return ws.terminate();
            if ((m.offer !== r.offer && !(m.offer === r.offer + 1 && m.peer === 'new' && m.playback === 'pending')) || m.seq !== r.seq) return;
            break;
          case 'helper-levels':
            if (![m.mic, m.out].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return ws.terminate();
            if (!r.meter || Date.now() - levelAt < tuning().helperLevelsMs || ws.bufferedAmount > 64_000) return;
            levelAt = Date.now(); break;
          case 'helper-rt': if (!Array.isArray(m.events) || m.events.length > 100) return ws.terminate(); break;
          case 'helper-pause': break;
          case 'helper-error': if (typeof m.code !== 'string' || m.code.length > 100 || typeof m.message !== 'string' || m.message.length > 1000) return ws.terminate(); break;
          default: return ws.terminate();
        }
        this.message(r, m);
      });
    });
  }
  private async launch(r: Reservation) {
    const deadline = setTimeout(() => { if (this.current(r)) this.failed(r, 'Voice helper startup timed out.'); void this.stop(r); }, tuning().helperStartMs);
    try {
      await this.swept;
      const chrome = await findUserChrome(); this.check(r);
      if (!chrome) throw new Error('Chrome is not installed. Open the call in a browser.');
      await mkdir(root, { recursive: true, mode: 0o700 }); this.check(r);
      r.dir = await mkdtemp(join(root, `${process.pid}-`));
      if (!this.current(r)) { await rm(r.dir, { recursive: true, force: true }); return; }
      await chmod(r.dir, 0o700);
      const serverStart = await identity(process.pid); this.check(r);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CONFIG_DIRS|XDG_DATA_DIRS|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|PULSE_SERVER|PULSE_SINK|PULSE_SOURCE|PULSE_COOKIE|PULSE_CLIENTCONFIG|PULSE_RUNTIME_PATH|PULSE_LATENCY_MSEC|PIPEWIRE_REMOTE|PIPEWIRE_RUNTIME_DIR|PIPEWIRE_CONFIG_DIR|PIPEWIRE_CONFIG_NAME|PIPEWIRE_CONFIG_PREFIX|PIPEWIRE_LATENCY|PIPEWIRE_QUANTUM|ALSA_CONFIG_PATH|ALSA_CONFIG_DIR|TMPDIR)$/.test(key)));
      const child = r.supervisor = fork(fileURLToPath(new URL('./helperProcess.ts', import.meta.url)), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...env, TARCSWEB_VOICE_PROFILE: join(r.dir, 'profile') } });
      child.on('error', () => { if (this.current(r)) this.failed(r, 'Voice helper supervisor failed.'); void this.stop(r); });
      child.on('exit', () => {
        if (r.dir) r.recovered = recoverOwned(r.dir, tuning().helperKillMs);
        if (this.current(r)) this.failed(r, 'Voice helper stopped unexpectedly.');
      });
      child.on('message', (m: any) => {
        if (m.type === 'owned') r.owned = m.owner;
        if (m.type === 'failed' && this.current(r)) { this.failed(r, 'Chrome stopped unexpectedly.'); void this.stop(r); }
      });
      child.send({ type: 'launch', command: chrome.command, args: chrome.args, flatpak: chrome.flatpak, dir: r.dir, flags: [...flags, `--user-data-dir=${join(r.dir, 'profile')}`, 'about:blank'], env, server: process.pid, serverStart, killMs: tuning().helperKillMs });
      this.check(r);
      let endpoint = '';
      while (!endpoint) {
        this.check(r);
        const data = await readFile(join(r.dir, 'profile', 'DevToolsActivePort'), 'utf8').catch(() => '');
        const [port, path] = data.trim().split('\n');
        if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port}${path}`;
        else await sleep(50);
      }
      const ws = await Cdp.open(endpoint, r.abort.signal, tuning().helperCommandMs, 'Voice helper stopped.');
      if (!this.current(r)) { ws.close(); return; }
      r.cdp = new Cdp(ws, (method, params) => {
        if (method === 'Page.frameNavigated' && !params.frame.parentId && params.frame.url.split('#')[0] !== `${this.origin}/voice-helper` && this.current(r)) { this.failed(r, 'The voice helper navigated away.'); void this.stop(r); }
      }, () => { if (this.current(r)) { this.failed(r, 'Chrome connection closed.'); void this.stop(r); } });
      try { await this.command(r, 'Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: this.origin }); }
      catch { this.check(r); await this.command(r, 'Browser.grantPermissions', { permissions: ['audioCapture'], origin: this.origin }); }
      this.check(r);
      const { targetInfos } = await this.command(r, 'Target.getTargets');
      const target = targetInfos.find((x: any) => x.type === 'page');
      if (!target) throw new Error('Chrome did not create the helper page.');
      const { sessionId } = await this.command(r, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await this.command(r, 'Page.enable', {}, sessionId); this.check(r);
      await this.command(r, 'Page.navigate', { url: `${this.origin}/voice-helper#${r.runId}:${r.token}` }, sessionId); this.check(r);
      while (!r.socket) { this.check(r); await sleep(50); }
    } finally { clearTimeout(deadline); }
  }
  private async command(r: Reservation, name: string, params = {}, session?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([r.cdp!.send(name, params, session), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome command timed out.')), tuning().helperCommandMs); })]); }
    finally { clearTimeout(timer); }
  }
  stop(r: Reservation): Promise<void> {
    if (r.stopped) return r.stopped;
    this.send(r, { type: 'helper-stop', runId: r.runId });
    r.token = ''; r.abort.abort();
    if (this.reservations.get(r.owner) === r) this.reservations.delete(r.owner);
    r.socket?.close();
    r.stopped = (async () => {
      await Promise.race([r.cdp?.send('Browser.close').catch(() => {}), sleep(tuning().helperCloseMs)]);
      r.cdp?.close();
      if (r.supervisor?.connected) {
        const exited = new Promise<void>((done) => r.supervisor!.once('exit', () => done()));
        r.supervisor.send({ type: 'stop' });
        await exited;
      } else if (r.dir && r.supervisor) await recoverOwned(r.dir, tuning().helperKillMs);
      else if (r.dir && !r.supervisor) await rm(r.dir, { recursive: true, force: true });
      await r.recovered;
    })();
    return r.stopped;
  }
  async close() { await Promise.all([...this.reservations.values()].map((r) => this.stop(r))); }
}
