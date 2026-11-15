import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Owner = { server: number; serverStart: string; supervisor: number; supervisorStart: string; chrome: number; chromeStart: string; profile: string; flatpak?: boolean; instance?: string };
export async function identity(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/stat`, 'utf8').then((s) => {
    const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? '' : fields[19];
  }, () => '');
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function hasProfile(args: string, flag: string) {
  // Chrome can rewrite argv as one space-separated process title.
  return args.split('\0').some((arg) => arg === flag || ` ${arg} `.includes(` ${flag} `));
}
async function matchesProfile(pid: number, profile: string) {
  const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  if (hasProfile(args, `--user-data-dir=${profile}`)) return true;
  const env = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
  return env.split('\0').includes(`TARCSWEB_VOICE_PROFILE=${profile}`);
}
async function groupAlive(pid: number) {
  const entries = await readdir('/proc');
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[2] === String(pid) && fields[0] !== 'Z') return true;
  }
  return false;
}
export async function cleanupOwned(dir: string, owner: Owner, killMs: number, targets?: Map<number, string>) {
  const members = new Map<number, string>();
  for (let attempt = 0; ; attempt++) {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === owner.supervisor) continue;
      const pid = Number(entry), start = await identity(pid);
      if (start && await matchesProfile(pid, owner.profile)) members.set(pid, start);
    }
    if (owner.chrome || members.size || attempt === 4) break;
    await wait(500);
  }
  targets ??= members;
  if (!owner.chrome) {
    for (const [pid, start] of members) await cleanupOwned(dir, { ...owner, chrome: pid, chromeStart: start }, killMs, targets);
    if (!members.size) console.error('Voice helper cleanup skipped: launch ownership could not be recovered.');
    return;
  }
  const current = await identity(owner.chrome);
  if (current && current !== owner.chromeStart) return;
  if (current) {
    if (!await matchesProfile(owner.chrome, owner.profile)) return;
  } else if (await groupAlive(owner.chrome)) {
    let proven = false;
    for (const [pid] of members) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[2] === String(owner.chrome) && fields[0] !== 'Z') proven = true;
    }
    if (!proven) { console.error('Voice helper cleanup skipped: group ownership could not be proved.'); return; }
  }
  if (owner.instance && /^\d+$/.test(owner.instance)) {
    await new Promise<void>((done) => execFile('flatpak', ['kill', owner.instance!], { timeout: killMs }, () => done()));
  }
  const signal = async (sig: NodeJS.Signals) => {
    const stat = await readFile(`/proc/${owner.chrome}/stat`, 'utf8').catch(() => '');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] !== 'Z' && fields[19] === owner.chromeStart) {
      try { process.kill(owner.chrome, sig); } catch {}
      try { process.kill(-Number(fields[2]), sig); } catch {}
    } else if (!await identity(owner.chrome)) { try { process.kill(-owner.chrome, sig); } catch {} }
  };
  await signal('SIGTERM');
  const until = Date.now() + killMs;
  while ((await identity(owner.chrome) === owner.chromeStart || await groupAlive(owner.chrome)) && Date.now() < until) await wait(50);
  if (await identity(owner.chrome) === owner.chromeStart || await groupAlive(owner.chrome)) await signal('SIGKILL');
  for (let i = 0; i < 30 && (await identity(owner.chrome) === owner.chromeStart || await groupAlive(owner.chrome)); i++) await wait(50);
  if (owner.flatpak || owner.instance) {
    const instances = await new Promise<string | null>((done) => execFile('flatpak', ['ps', '--columns=instance'], { timeout: killMs }, (err, out) => done(err ? null : out)));
    if (!owner.instance || instances === null || instances.split(/\s+/).includes(owner.instance)) {
      console.error('Voice helper cleanup failed: Flatpak instance termination was not confirmed.');
      return;
    }
  }
  for (const [pid, start] of targets) if (await identity(pid) === start) return;
  for (const entry of await readdir('/proc')) {
    const pid = Number(entry);
    if (pid > 0 && pid !== owner.supervisor && await identity(pid) && await matchesProfile(pid, owner.profile)) return;
  }
  if (await identity(owner.chrome) !== owner.chromeStart && !await groupAlive(owner.chrome)) await rm(dir, { recursive: true, force: true });
}
export async function recoverOwned(dir: string, killMs: number) {
  const owner: Owner | null = await readFile(join(dir, 'owner.json'), 'utf8').then(JSON.parse, () => null).catch(() => null);
  if (!owner || owner.profile !== join(dir, 'profile')) return;
  await cleanupOwned(dir, owner, killMs);
}
export async function sweepHelpers(root: string) {
  for (const entry of await readdir(root).catch(() => [])) {
    const dir = join(root, entry);
    const owner: Owner | null = await readFile(join(dir, 'owner.json'), 'utf8').then(JSON.parse, () => null).catch(() => null);
    if (!owner || owner.profile !== join(dir, 'profile')) continue;
    if (await identity(owner.server) === owner.serverStart || await identity(owner.supervisor) === owner.supervisorStart) continue;
    await cleanupOwned(dir, owner, 1500);
  }
}

async function supervise() {
  const send = (message: object) => { if (process.connected) process.send?.(message); };
  let owner: Owner | undefined;
  let stopping = false;
  let launch: Promise<void> = Promise.resolve();
  let killMs = 1500;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await launch;
    if (owner) await cleanupOwned(join(owner.profile, '..'), owner, killMs);
    process.exit(0);
  };
  process.on('disconnect', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  process.on('message', (m: any) => {
    if (m.type === 'stop') return void stop();
    if (m.type !== 'launch' || owner || stopping) return;
    launch = (async () => {
      killMs = m.killMs;
      const args = m.flatpak
        ? ['run', '--die-with-parent', '--instance-id-fd=3', `--filesystem=${m.dir}`, '--socket=pulseaudio', m.flatpak, ...m.flags]
        : [...m.args, ...m.flags];
      owner = { server: m.server, serverStart: m.serverStart, supervisor: process.pid, supervisorStart: await identity(process.pid), chrome: 0, chromeStart: '', profile: join(m.dir, 'profile'), flatpak: !!m.flatpak };
      const record = async () => {
        await writeFile(join(m.dir, 'owner.next'), JSON.stringify(owner), { mode: 0o600 });
        await rename(join(m.dir, 'owner.next'), join(m.dir, 'owner.json'));
      };
      await record();
      const chrome = spawn(m.command, args, { detached: true, env: { ...m.env, TARCSWEB_VOICE_PROFILE: owner.profile }, stdio: ['ignore', 'ignore', 'ignore', ...(m.flatpak ? ['pipe' as const] : [])] });
      chrome.on('error', () => { send({ type: 'failed' }); void stop(); });
      chrome.on('exit', () => { send({ type: 'failed' }); void stop(); });
      if (!chrome.pid) return;
      owner.chrome = chrome.pid;
      owner.chromeStart = await identity(chrome.pid);
      if (m.flatpak) {
        let instance = '';
        chrome.stdio[3]?.on('data', (data: Buffer) => { instance += data; });
        chrome.stdio[3]?.on('end', () => {
          if (/^\d+$/.test(instance.trim())) { owner!.instance = instance.trim(); void launch.then(record); }
        });
      }
      await record();
      send({ type: 'owned', owner });
    })().catch(() => { send({ type: 'failed' }); void stop(); });
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void supervise();
