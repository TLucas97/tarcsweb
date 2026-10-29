import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import type { MachineFacts } from './protocol.ts';

// Constant per boot, so read once. Free memory is the only moving fact and is read per call.
type Fixed = Omit<MachineFacts, 'freeMemory'>;

const detectWsl = async () => {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return /microsoft/i.test(await readFile('/proc/version', 'utf8').catch(() => ''));
};

// 1 when the process is an x64 binary translated on Apple silicon.
const detectRosetta = () =>
  new Promise<boolean>((done) => {
    if (process.platform !== 'darwin') return done(false);
    execFile('sysctl', ['-n', 'sysctl.proc_translated'], { timeout: 2000 }, (err, out) => done(!err && out.trim() === '1'));
  });

async function readFixed(): Promise<Fixed> {
  const [wsl, rosetta] = await Promise.all([detectWsl(), detectRosetta()]);
  const total = os.totalmem();
  const limit = process.constrainedMemory();
  return {
    totalMemory: total,
    // 0 and values at or above the machine's RAM mean "no limit" (cgroup max shows up as a huge number).
    constrainedMemory: limit > 0 && limit < total ? limit : null,
    cpus: os.availableParallelism(),
    cpuModel: os.cpus()[0]?.model.trim() || null,
    platform: process.platform,
    arch: process.arch,
    wsl,
    rosetta,
  };
}

let fixed: Promise<Fixed> | null = null;
export const isWslHost = () => (fixed ??= readFixed()).then((f) => f.wsl);

export async function machineFacts(): Promise<MachineFacts> {
  const f = await (fixed ??= readFixed());
  const free = process.availableMemory();
  return { ...f, freeMemory: free > 0 ? free : null };
}

const SLOW_FS = new Set(['9p', 'drvfs']);
const WINDOWS_DRIVE = /^\/mnt\/[a-z](\/|$)/;
const CAP = 100;
const cache = new Map<string, Promise<boolean>>();

// Mount points escape space, tab, newline and backslash as octal.
const unescapeMount = (p: string) => p.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

async function onWindowsDrive(cwd: string): Promise<boolean> {
  const real = await realpath(cwd);
  if (!WINDOWS_DRIVE.test(real)) return false;
  const info = await readFile('/proc/self/mountinfo', 'utf8');
  let best = '';
  let type = '';
  for (const line of info.split('\n')) {
    const [head, tail] = line.split(' - ');
    if (!tail) continue;
    const mount = unescapeMount(head!.split(' ')[4] ?? '');
    const inside = real === mount || real.startsWith(mount === '/' ? '/' : mount + '/');
    if (inside && mount.length >= best.length) [best, type] = [mount, tail.split(' ')[0]!];
  }
  return SLOW_FS.has(type);
}

// True when the server runs in WSL and the folder sits on a Windows drive. Cached per folder.
export function slowWindowsFolder(cwd: string): Promise<boolean> {
  let hit = cache.get(cwd);
  if (!hit) {
    hit = isWslHost().then((wsl) => wsl && onWindowsDrive(cwd)).catch(() => false);
    cache.set(cwd, hit);
    if (cache.size > CAP) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
