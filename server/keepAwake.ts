import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

// Keeps the screen on and the machine out of sleep while a child process holds the OS inhibitor.
// Each holder exits on its own when this server dies, so a crash never leaves the machine awake.
const WHY = 'Agents are running';

function has(bin: string) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
}

function holder(): [string, string[]] | null {
  const pid = String(process.pid);
  const wait = ['tail', `--pid=${pid}`, '-f', '/dev/null'];
  if (process.platform === 'darwin') return ['caffeinate', ['-d', '-i', '-w', pid]];
  if (process.platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, held while this PowerShell thread lives.
    const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(0x80000003) | Out-Null; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep 20 }`;
    return ['powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps]];
  }
  if (process.platform !== 'linux') return null;
  // KDE ignores logind idle inhibitors for the screen, so it gets its own tool.
  if (has('kde-inhibit')) return ['kde-inhibit', ['--power', '--screenSaver', ...wait]];
  if (has('systemd-inhibit')) return ['systemd-inhibit', ['--what=idle:sleep', '--who=tarcsweb', `--why=${WHY}`, '--mode=block', ...wait]];
  return null;
}

let child: ChildProcess | null = null;
// undefined until looked up; null caches "no inhibitor on this machine".
let cmd: [string, string[]] | null | undefined;

export function setKeepAwake(on: boolean) {
  if (!on) {
    if (!child) return;
    const c = child;
    child = null;
    // The holder runs in its own process group, so its tail child goes too.
    try { process.platform === 'win32' ? c.kill() : process.kill(-c.pid!); } catch { /* already gone */ }
    return;
  }
  if (child) return;
  if (cmd === undefined) cmd = holder();
  if (!cmd) return;
  const c = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  // A failed spawn may emit 'error' without 'exit'; clearing child lets the next call retry.
  c.on('error', (e) => {
    console.warn(`[keep-awake] ${cmd![0]}: ${e.message}`);
    if (child === c) child = null;
  });
  c.on('exit', () => { if (child === c) child = null; });
  c.unref();
  child = c;
}
