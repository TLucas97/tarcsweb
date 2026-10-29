import { execFile, spawn } from 'node:child_process';

const APP_URL = 'http://localhost:24816/';
const APP_ARGS = ['run', 'com.google.Chrome'];

// Starts a detached program; resolves null once it runs, or the error.
function launch(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => done(`Could not open the app: ${e.message}`));
    child.on('spawn', () => {
      child.unref();
      done(null);
    });
  });
}

// flatpak run starts fine even when Chrome is not installed, so ask first.
const chromeFlatpak = () =>
  new Promise<boolean>((done) => execFile('flatpak', ['info', APP_ARGS[1]], { timeout: 5000 }, (err) => done(!err)));

// Opens the app at path: a Chrome app window on Linux (the default browser when Flatpak is missing), the default
// browser on Windows (WSL) and macOS. wsl is passed in, so this module stays free of async platform checks.
export async function openWindow(path = '/', wsl = false): Promise<string | null> {
  const url = new URL(path, APP_URL).href;
  if (wsl) return launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replaceAll("'", "''")}'`]);
  if (process.platform === 'darwin') return launch('open', [url]);
  return (await chromeFlatpak()) ? launch('flatpak', [...APP_ARGS, `--app=${url}`]) : launch('xdg-open', [url]);
}
