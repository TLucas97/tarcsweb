// Linux /proc reads for the run bar: a run's process tree, its memory and listening ports, and who holds a port.
import { readFileSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';

const PAGE_MB = 4096 / 1048576;
// Processes walked per tree, so a fork bomb in a dev script cannot stall the tick.
const TREE_MAX = 64;

const text = (path: string) => readFile(path, 'utf8').catch(() => null);

const ticksOf = (s: string | null) => (s ? (s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null) : null);

// The process start time in clock ticks: a pid reused by another program reads differently.
export async function startTicks(pid: number) {
  return ticksOf(await text(`/proc/${pid}/stat`));
}

// Sync on purpose: one procfs read on Start and Stop clicks and at boot, never on a streaming path.
export function startTicksSync(pid: number) {
  try {
    return ticksOf(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

export async function tree(root: number) {
  const out = [root];
  for (let i = 0; i < out.length && out.length < TREE_MAX; i++) {
    const tasks = await readdir(`/proc/${out[i]}/task`).catch(() => [] as string[]);
    for (const t of tasks) {
      const kids = await text(`/proc/${out[i]}/task/${t}/children`);
      for (const k of kids?.split(' ') ?? []) if (k.trim()) out.push(Number(k));
    }
  }
  return out.slice(0, TREE_MAX);
}

export async function memoryMb(pids: number[]) {
  let pages = 0;
  for (const p of pids) pages += Number((await text(`/proc/${p}/statm`))?.split(' ')[1] ?? 0);
  return pages ? Math.round(pages * PAGE_MB) : null;
}

// Listening TCP sockets: inode → port.
export async function listening() {
  const out = new Map<string, number>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (await text(f))?.split('\n').slice(1) ?? []) {
      const c = line.trim().split(/\s+/);
      if (c[3] === '0A' && c[9]) out.set(c[9], parseInt(c[1]!.split(':')[1]!, 16));
    }
  }
  return out;
}

async function sockets(pid: number) {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  const out: string[] = [];
  for (const fd of fds) {
    const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    if (link.startsWith('socket:[')) out.push(link.slice(8, -1));
  }
  return out;
}

export async function portsOf(pids: number[], listen: Map<string, number>) {
  const ports = new Set<number>();
  for (const p of pids) for (const inode of await sockets(p)) {
    const port = listen.get(inode);
    if (port) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export async function nameOf(pid: number) {
  const cmd = (await text(`/proc/${pid}/cmdline`))?.split('\0').filter(Boolean) ?? [];
  const exe = cmd[0]?.split('/').pop() ?? (await text(`/proc/${pid}/comm`))?.trim() ?? 'unknown';
  return [exe, ...cmd.slice(1, 3)].join(' ').slice(0, 80);
}

// The process listening on port, read only on a click: it walks every process's open files.
export async function holderOf(port: number) {
  const listen = await listening();
  const inodes = new Set([...listen].filter(([, p]) => p === port).map(([i]) => i));
  if (!inodes.size) return null;
  for (const d of await readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if ((await sockets(pid)).some((i) => inodes.has(i))) return { pid, name: await nameOf(pid) };
  }
  // Held by a process this user cannot read, such as docker-proxy.
  return { pid: 0, name: 'another user\'s process' };
}

export async function parentOf(pid: number) {
  const s = await text(`/proc/${pid}/stat`);
  return s ? Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) : 0;
}
