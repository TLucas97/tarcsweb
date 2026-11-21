import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { saveSettings } from './settings.ts';
import { isWslHost } from './machine.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REBUILD_SOURCE, shellAuthorized, shellSend } from './shell.ts';
import type { DesktopInstallState, DesktopInstallMessage, DesktopShellBuild, DesktopShellMessage, DesktopShellStatus } from './protocol.ts';

const run = promisify(execFile);
type Asset = { name: string; size: number; browser_download_url: string; digest?: string | null };
type Release = { assets: Asset[] };
type Platform = NonNullable<DesktopInstallState['platform']>;
type Target = { platform: Platform; name: string };

export class DesktopInstall {
  private state: DesktopInstallState = { phase: 'checking' };
  private listeners = new Set<(m: DesktopInstallMessage | DesktopShellMessage) => void>();
  private release: { until: number; value: Promise<Release> } | null = null;
  private busy = false;
  // Inside the desktop app: its build and the rebuild status the shell last reported.
  private shellBuild: DesktopShellBuild | null = null;
  private shellStatus: DesktopShellStatus = { phase: 'idle' };
  private shellSeq = 0;

  private powershell(command: string) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { timeout: 10_000 });
  }

  subscribe(send: (m: DesktopInstallMessage | DesktopShellMessage) => void) {
    this.listeners.add(send);
    return () => { this.listeners.delete(send); };
  }

  private emitShell() {
    if (!this.shellBuild) return;
    for (const send of this.listeners) send({ type: 'desktop-shell', build: this.shellBuild, status: this.shellStatus });
  }

  // A Chrome window the desktop app opened gets the shell's build in place of the install offer.
  async shellInfo() {
    const git = (args: string[]) => run('git', args, { cwd: REBUILD_SOURCE!, timeout: 5000 }).then((r) => r.stdout.trim(), () => null);
    const [commit, porcelain] = REBUILD_SOURCE ? await Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['status', '--porcelain'])]) : [null, null];
    this.shellBuild = { version: process.env.CW_APP_VERSION || '', commit, dirty: !!porcelain, canRebuild: !!REBUILD_SOURCE };
    this.emitShell();
  }

  shellRebuild() {
    if (!REBUILD_SOURCE || this.shellStatus.phase === 'building' || this.shellStatus.phase === 'restarting') return;
    this.shellStatus = { phase: 'building' };
    this.shellSeq = 0;
    this.emitShell();
    shellSend({ cmd: 'rebuild' });
  }

  // The shell posts each update event here so a Chrome window sees the rebuild's progress and errors.
  async serveShellUpdate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.url ?? '').split('?')[0] !== '/api/shell/update') return false;
    if (!shellAuthorized(req) || req.method !== 'POST') {
      res.writeHead(401).end();
      return true;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        res.writeHead(413).end();
        return true;
      }
    }
    let s: { phase?: unknown; message?: unknown; logPath?: unknown; seq?: unknown };
    try {
      s = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    // Older shells send no seq; seq 1 is a freshly started shell, so it starts a new count.
    const seq = Number.isSafeInteger(s.seq) ? s.seq as number : null;
    const stale = seq !== null && seq !== 1 && seq <= this.shellSeq;
    if (seq !== null && !stale) this.shellSeq = seq;
    if (!stale && (s.phase === 'building' || s.phase === 'restarting' || s.phase === 'failed')) {
      this.shellStatus = { phase: s.phase, ...(typeof s.message === 'string' ? { message: s.message } : {}), ...(typeof s.logPath === 'string' ? { logPath: s.logPath } : {}) };
      this.emitShell();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return true;
  }

  private emit(state = this.state) {
    this.state = state;
    for (const send of this.listeners) send({ type: 'desktop-install', state, dismissed: config.desktopInstallDismissed });
  }

  private async target(): Promise<Target | null> {
    if (process.env.CW_SHELL === 'tauri') return null;
    if (await isWslHost()) return { platform: 'wsl', name: 'tarcsweb-windows-x64.exe' };
    if (process.platform === 'linux') return { platform: 'linux', name: `tarcsweb-linux-${process.arch}.AppImage` };
    if (process.platform === 'darwin') return { platform: 'macos', name: `tarcsweb-macos-${process.arch}.dmg` };
    return null;
  }

  private latest(): Promise<Release> {
    if (this.release && this.release.until > Date.now()) return this.release.value;
    const base = process.env.CW_DESKTOP_RELEASE_API || 'https://api.github.com/repos/TLucas97/tarcsweb';
    const value = (async () => {
      const response = await fetch(`${base.replace(/\/$/, '')}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tarcsweb' }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return { assets: [] };
      if (!response.ok) throw new Error(`Could not check the desktop release (HTTP ${response.status}).`);
      const data = await response.json() as Release;
      if (!Array.isArray(data.assets) || !data.assets.every((a) => a && typeof a.name === 'string'
        && Number.isSafeInteger(a.size) && a.size > 0 && typeof a.browser_download_url === 'string'
        && (a.digest == null || typeof a.digest === 'string'))) throw new Error('The desktop release data is invalid.');
      return data;
    })();
    this.release = { until: Date.now() + 5 * 60_000, value };
    void value.catch(() => { if (this.release?.value === value) this.release = null; });
    return value;
  }

  async status() {
    if (this.busy || this.state.phase === 'done') return this.emit();
    this.emit({ phase: 'checking' });
    try {
      const target = await this.target();
      const release = await this.latest();
      const asset = release.assets.find((a) => a.name === target?.name);
      this.emit(asset && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest))
        ? { phase: 'unavailable', message: 'The desktop installer has no valid SHA-256 checksum for verification.' }
        : target && asset
        ? { phase: 'ready', platform: target.platform }
        : { phase: 'unavailable', message: 'The latest release has no desktop installer for this platform.' });
    } catch (e) {
      this.emit({ phase: 'failed', message: `${(e as Error).message} Try again.` });
    }
  }

  async dismiss() {
    try {
      const error = await saveSettings({ desktopInstallDismissed: true });
      if (error) throw new Error(error);
      this.emit();
    } catch {
      this.emit({ phase: 'failed', message: 'Could not save this choice. Try again.' });
    }
  }

  async install() {
    if (this.busy) return;
    this.busy = true;
    let partial: string | undefined;
    const changed = new Map<string, Buffer | null>();
    let dismissed: boolean | undefined;
    const prepare = async (path: string, data: string) => {
      changed.set(path, await readFile(path).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }));
      await writeFile(path, data);
    };
    try {
      const target = await this.target();
      const asset = (await this.latest()).assets.find((a) => a.name === target?.name);
      if (!target || !asset) {
        this.emit({ phase: 'unavailable', message: 'The latest release has no desktop installer for this platform.' });
        return;
      }
      if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
        this.emit({ phase: 'unavailable', message: 'The desktop installer has no valid SHA-256 checksum for verification.' });
        return;
      }
      this.emit({ phase: 'downloading', progress: 0, platform: target.platform });
      const home = process.env.CW_DESKTOP_HOME || homedir();
      const dataHome = process.env.XDG_DATA_HOME || join(home, '.local/share');
      let folder = target.platform === 'linux' ? join(dataHome, 'tarcsweb/desktop') : join(home, 'Downloads');
      if (target.platform === 'wsl') {
        const { stdout } = await this.powershell('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($env:USERPROFILE)');
        folder = (await run('wslpath', ['-u', `${stdout.trim()}\\Downloads`], { timeout: 10_000 })).stdout.trim();
      }
      await mkdir(folder, { recursive: true });
      const file = join(folder, asset.name);
      partial = `${file}.part`;
      const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'tarcsweb' }, signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Could not download the installer (HTTP ${response.status}).`);
      const hash = createHash('sha256');
      const handle = await open(partial, 'w', 0o600);
      let bytes = 0;
      let percent = -1;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > asset.size) throw new Error('The installer size does not match the release.');
          hash.update(chunk);
          await handle.writeFile(chunk);
          const next = Math.floor(bytes * 100 / asset.size);
          if (percent !== next) {
            percent = next;
            this.emit({ phase: 'downloading', progress: percent, platform: target.platform });
          }
        }
      } finally { await handle.close(); }
      if (bytes !== asset.size) throw new Error('The installer download is incomplete.');
      if (asset.digest.toLowerCase() !== `sha256:${hash.digest('hex')}`) throw new Error('The installer checksum does not match the release.');
      await rename(partial, file);
      partial = undefined;
      this.emit({ phase: 'opening', platform: target.platform });
      if (target.platform === 'linux') {
        await chmod(file, 0o755);
        const applications = join(dataHome, 'applications');
        await mkdir(applications, { recursive: true });
        const entry = join(applications, 'cweb.desktop');
        const old = await readFile(entry, 'utf8').catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        const escaped = file.replace(/[%\\"`$]/g, (c) => c === '%' ? '%%' : `\\${c}`);
        const main = old?.split(/\r?\n\[/)[0];
        const owned = main?.match(/^Name=(.*)$/m)?.[1] === 'tarcsweb'
          && [ `${join(home, '.local/bin/cweb-tray')} app`, `"${join(home, '.local/bin/cweb-tray')}" app` ].includes(main?.match(/^Exec=(.*)$/m)?.[1] || '');
        const icon = owned ? main?.match(/^Icon=(.*)$/m)?.[1] || 'tarcsweb' : 'tarcsweb';
        await prepare(join(applications, 'tarcsweb.desktop'), `[Desktop Entry]\nType=Application\nName=tarcsweb\nExec="${escaped}"\nIcon=${icon}\nTerminal=false\nCategories=Development;\n`);
        if (owned && old !== null) {
          const backup = `${entry}.before-desktop`;
          const previous = await readFile(backup, 'utf8').catch((e) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
          // A different backup cannot restore this entry, so leave it visible.
          if (previous === null || previous === old) {
            if (previous === null) await prepare(backup, old);
            const hidden = old.replace(/^NoDisplay=.*(?:\r?\n|$)/gm, '').replace('[Desktop Entry]', '[Desktop Entry]\nNoDisplay=true');
            await prepare(entry, hidden);
          }
        }
        dismissed = config.desktopInstallDismissed;
        const error = await saveSettings({ desktopInstallDismissed: true });
        if (error) throw new Error(error);
        // Launch can stop this server through takeover; all preparation must be saved first.
        await new Promise<void>((resolve, reject) => {
          const child = spawn(file, [], { detached: true, stdio: 'ignore', env: process.env });
          const timer = setTimeout(() => { child.unref(); resolve(); }, 1000);
          child.once('error', (e) => { clearTimeout(timer); reject(e); });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`The desktop app could not start (${signal || `exit ${code}`}). Check AppImage support and try again.`));
          });
        });
      } else if (target.platform === 'macos') {
        await run('open', [file], { timeout: 10_000 });
      } else {
        const windows = (await run('wslpath', ['-w', file], { timeout: 10_000 })).stdout.trim();
        const { stdout } = await this.powershell('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($env:APPDATA)');
        const appData = (await run('wslpath', ['-u', `${stdout.trim()}\\dev.tarcsweb.app`], { timeout: 10_000 })).stdout.trim();
        await mkdir(appData, { recursive: true });
        const marker = join(appData, 'attach-wsl');
        const created = await open(marker, 'wx').catch((e) => {
          if (e.code === 'EEXIST') return null;
          throw e;
        });
        try {
          if (created) await created.close();
          await this.powershell(`Start-Process -FilePath '${windows.replace(/'/g, "''")}' -ErrorAction Stop`);
        } catch (e) {
          if (created) await rm(marker, { force: true });
          throw e;
        }
      }
      if (target.platform !== 'linux') {
        const error = await saveSettings({ desktopInstallDismissed: true });
        if (error) throw new Error(error);
      }
      this.emit({ phase: 'done', platform: target.platform, message: target.platform === 'linux'
        ? 'Open tarcsweb from your app launcher.' : target.platform === 'macos'
          ? 'Drag tarcsweb to Applications, then open it.' : 'Follow the installer, then open tarcsweb from the Start menu.' });
    } catch (e) {
      if (partial) await rm(partial, { force: true }).catch(() => {});
      let restoration = '';
      try {
        for (const [path, data] of [...changed].reverse()) {
          if (data === null) await rm(path, { force: true });
          else await writeFile(path, data);
        }
        if (dismissed !== undefined) {
          const error = await saveSettings({ desktopInstallDismissed: dismissed });
          if (error) throw new Error(error);
        }
      } catch (restore) { restoration = ` Could not restore the previous launcher state: ${(restore as Error).message}`; }
      this.emit({ phase: 'failed', message: `${(e as Error).message}${restoration} Try again.` });
    } finally { this.busy = false; }
  }
}
