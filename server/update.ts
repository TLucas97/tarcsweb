import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateRun, UpdateStatus, UpdateStep } from './protocol.ts';

// Where releases come from. Renaming the repo is this line plus REPO_SLUG at the top of get.sh.
export const REPO_SLUG = 'TLucas97/tarcsweb';

const API = (process.env.TARCSWEB_API || 'https://api.github.com').replace(/\/+$/, '');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
const LOG_DIR = process.env.TARCSWEB_LOG_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tarcsweb');
const STATE_FILE = join(LOG_DIR, 'update-state');
const CACHE_FILE = join(LOG_DIR, 'update-check.json');
const EVERY_MS = 6 * 3600_000;
// "Check now" pressed again within this window answers from the cache; GitHub allows 60 unauthenticated calls an hour.
const MIN_GAP_MS = 30_000;
// A run whose state file has not moved for this long died without saying so.
const STALE_MS = 20 * 60_000;
const ACTIVE: UpdateStep[] = ['downloading', 'installing', 'checking', 'restarting'];
const STEPS: UpdateStep[] = [...ACTIVE, 'done', 'failed'];
const TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

type Semver = { n: number[]; pre: string | null };
const parse = (v: string): Semver | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
};

// a > b in semver order; a prerelease sorts before its release.
export function newer(a: string, b: string) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

// Only a release install running from <home>/current under the service can replace itself.
function installMode(): { home: string | null; why: string | null } {
  if (existsSync(join(ROOT, '.git'))) return { home: null, why: 'This copy is a git clone. Update it with git pull and scripts/update.sh.' };
  if (!existsSync(join(ROOT, '.tarcsweb-release'))) return { home: null, why: 'This copy was not installed from a release. Install it with the command in the README to get updates here.' };
  const home = dirname(dirname(ROOT));
  try {
    if (realpathSync(join(home, 'current')) !== realpathSync(ROOT)) return { home: null, why: `This copy is not the installed version in ${home}/current.` };
  } catch {
    return { home: null, why: `No ${home}/current link was found. Run the install command again.` };
  }
  if (!process.env.CW_DIST) return { home: null, why: 'This is a development server. Update it with git pull.' };
  return { home, why: null };
}

async function readRun(): Promise<UpdateRun | null> {
  const text = await readFile(STATE_FILE, 'utf8').catch(() => '');
  const [step, tag, at, message = ''] = text.replace(/\n$/, '').split('\t');
  if (!STEPS.includes(step as UpdateStep) || !TAG.test(tag ?? '') || !Number(at)) return null;
  const run: UpdateRun = { step: step as UpdateStep, tag, at: Number(at) * 1000, message: message.slice(0, 300) };
  if (ACTIVE.includes(run.step) && Date.now() - run.at > STALE_MS) return { ...run, step: 'failed', message: `The update stopped during the ${run.step} step` };
  return run;
}

async function writeState(step: UpdateStep, tag: string, message = '') {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(`${STATE_FILE}.tmp`, `${step}\t${tag}\t${Math.floor(Date.now() / 1000)}\t${message}\n`);
  await rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

const firstLine = (s: string) => s.trim().split('\n')[0].slice(0, 200);

class Updater {
  status: UpdateStatus;
  private home: string | null;
  private listeners = new Set<(s: UpdateStatus) => void>();
  private running: Promise<void> | null = null;
  private etag: string | null = null;
  private retryAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const mode = installMode();
    this.home = mode.home;
    this.status = {
      current: VERSION, repo: REPO_SLUG, latest: null, available: false, canUpdate: !!mode.home, why: mode.why,
      checking: false, checkedAt: null, checkError: null, run: null, log: join(LOG_DIR, 'update.log'),
    };
  }

  subscribe(fn: (s: UpdateStatus) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // A fresh object per change, so index.ts serializes each broadcast once.
  private emit(patch: Partial<UpdateStatus> = {}) {
    const next = { ...this.status, ...patch };
    next.available = !!next.latest && newer(next.latest.version, next.current);
    this.status = next;
    for (const fn of this.listeners) fn(next);
  }

  async start() {
    this.syncRun(await readRun());
    try {
      const c = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as { etag?: unknown; latest?: UpdateStatus['latest']; checkedAt?: unknown };
      if (c.latest && TAG.test(c.latest.tag) && /^https?:\/\//.test(c.latest.url)) {
        this.etag = typeof c.etag === 'string' ? c.etag : null;
        this.emit({ latest: c.latest, checkedAt: typeof c.checkedAt === 'number' ? c.checkedAt : null });
      }
    } catch {}
    // Boot checks for release servers only: the boot check of a new version sets this to 0.
    if (process.env.TARCSWEB_UPDATE_CHECK === '0') return;
    void this.check();
    setInterval(() => void this.check(), EVERY_MS).unref();
  }

  check(manual = false): Promise<void> {
    if (this.running) return this.running;
    const now = Date.now();
    if ((manual && this.status.checkedAt && now - this.status.checkedAt < MIN_GAP_MS) || now < this.retryAt) {
      this.emit();
      return Promise.resolve();
    }
    this.emit({ checking: true });
    this.running = this.fetchLatest().then((patch) => {
      this.running = null;
      this.emit({ ...patch, checking: false });
    });
    return this.running;
  }

  // Never throws: offline and rate limits become a quiet checkError and the cached release stays.
  private async fetchLatest(): Promise<Partial<UpdateStatus>> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': `tarcsweb/${VERSION}` };
    // A 304 answer does not count against GitHub's rate limit.
    if (this.etag && this.status.latest) headers['if-none-match'] = this.etag;
    try {
      const res = await fetch(`${API}/repos/${REPO_SLUG}/releases/latest`, { headers, signal: AbortSignal.timeout(15_000) });
      const now = Date.now();
      if (res.status === 304) return { checkedAt: now, checkError: null };
      if (res.status === 404) return { latest: null, checkedAt: now, checkError: 'No release has been published yet.' };
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        this.retryAt = reset > now ? Math.min(reset, now + 3600_000) : now + 3600_000;
        return { checkError: "GitHub's hourly limit for update checks was reached. It checks again later." };
      }
      if (!res.ok) return { checkError: `GitHub answered ${res.status}. It checks again later.` };
      const j = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof j.tag_name === 'string' ? j.tag_name : '';
      if (!TAG.test(tag)) return { checkError: `The latest release has an unexpected tag (${tag.slice(0, 40)}).` };
      const url = typeof j.html_url === 'string' && /^https?:\/\//.test(j.html_url) ? j.html_url : `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
      const latest = { tag, version: tag.slice(1), url };
      this.etag = res.headers.get('etag');
      void mkdir(LOG_DIR, { recursive: true })
        .then(() => writeFile(CACHE_FILE, JSON.stringify({ etag: this.etag, latest, checkedAt: now })))
        .catch(() => {});
      return { latest, checkedAt: now, checkError: null };
    } catch {
      return { checkError: 'Could not reach GitHub to check for updates.' };
    }
  }

  // Starts self-update.sh outside this service, so restarting the service does not kill it. Returns why it can't.
  update(tag: string): string | null {
    const s = this.status;
    if (!this.home) return s.why ?? 'This copy cannot update itself.';
    if (!s.latest || s.latest.tag !== tag || !s.available) return `${tag} is not a newer release.`;
    if (s.run && ACTIVE.includes(s.run.step)) return 'An update is already running.';
    const script = join(ROOT, 'scripts/self-update.sh');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: homedir(),
      CW_PORT: process.env.CW_PORT || '24817',
      TARCSWEB_LOG_DIR: LOG_DIR,
      ...(process.env.TARCSWEB_API ? { TARCSWEB_API: process.env.TARCSWEB_API } : {}),
      ...(process.env.TARCSWEB_NO_SYSTEMD ? { TARCSWEB_NO_SYSTEMD: process.env.TARCSWEB_NO_SYSTEMD } : {}),
    };
    const failed = (why: string) => void writeState('failed', tag, why).then(() => this.poll(0));
    // The state file is written first, so a reader never sees the previous run's result as this one's.
    void writeState('downloading', tag)
      .then(() => {
        // INVOCATION_ID is set by systemd for its services; a plain process (tests, dev) spawns detached instead.
        if (process.env.INVOCATION_ID && process.env.TARCSWEB_NO_SYSTEMD !== '1') {
          const args = ['--user', '--collect', '--quiet', `--unit=tarcsweb-update-${Date.now()}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), 'bash', script, tag];
          execFile('systemd-run', args, { timeout: 20_000 }, (err) => err && failed(`Could not start the updater: ${firstLine(err.message)}`));
        } else {
          const child = spawn('bash', [script, tag], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
          child.on('error', (err) => failed(`Could not start the updater: ${firstLine(err.message)}`));
          // An early exit (lock held, bad install) leaves no state of its own.
          child.on('exit', (code) => code && void readRun().then((r) => r?.step === 'downloading' && failed(`The updater exited early (code ${code}); see update.log`)));
          child.unref();
        }
        this.poll(500);
      })
      .catch((err) => this.emit({ run: { step: 'failed', tag, at: Date.now(), message: `Could not write ${STATE_FILE}: ${firstLine(String(err))}` } }));
    this.emit({ run: { step: 'downloading', tag, at: Date.now(), message: '' } });
    return null;
  }

  // Follows the state file once a second while a run is active; it stops by itself when the run ends.
  private poll(ms: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      this.syncRun(await readRun());
    }, ms);
  }

  private syncRun(run: UpdateRun | null) {
    const old = this.status.run;
    if (run?.step !== old?.step || run?.tag !== old?.tag || run?.message !== old?.message) this.emit({ run });
    if (run && ACTIVE.includes(run.step)) this.poll(1000);
  }

  // Read on shutdown: a restart for an update must not send the pages `bye`, which closes app windows.
  restarting() {
    try {
      const [step, , at] = readFileSync(STATE_FILE, 'utf8').split('\t');
      return step === 'restarting' && Date.now() - Number(at) * 1000 < 10 * 60_000;
    } catch {
      return false;
    }
  }
}

export const updater = new Updater();
