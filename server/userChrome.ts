import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type UserChrome = { name: string; command: string; args: string[]; flatpak?: string };
let chrome: UserChrome | null = null;
let finding: Promise<UserChrome | null> | undefined;
export const userChrome = () => chrome;
export function findUserChrome(): Promise<UserChrome | null> {
  return finding ??= discover().then((found) => (chrome = found));
}

async function discover(): Promise<UserChrome | null> {
  if (process.platform === 'linux') {
    const flatpak = await new Promise<boolean>((done) => execFile('flatpak', ['info', 'com.google.Chrome'], { timeout: 3000 }, (err) => done(!err)));
    if (flatpak) return { name: 'Google Chrome (Flatpak)', command: 'flatpak', args: ['run', 'com.google.Chrome'], flatpak: 'com.google.Chrome' };
    for (const [bin, name] of [['google-chrome', 'Google Chrome'], ['google-chrome-stable', 'Google Chrome'], ['chromium', 'Chromium'], ['chromium-browser', 'Chromium']]) {
      for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const command = join(dir, bin);
        if (existsSync(command)) return { name, command, args: [] };
      }
    }
  }
  const apps = process.platform === 'win32'
    ? [['Google Chrome', 'Google/Chrome/Application/chrome.exe'], ['Chromium', 'Chromium/Application/chrome.exe'], ['Microsoft Edge (fallback)', 'Microsoft/Edge/Application/msedge.exe']]
    : [['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'], ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'], ['Microsoft Edge (fallback)', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']];
  const roots = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((v): v is string => !!v)
    : process.platform === 'darwin' ? ['/Applications', join(homedir(), 'Applications')] : [];
  for (const [name, app] of apps) for (const root of roots) {
    const command = join(root, app);
    if (existsSync(command)) return { name, command, args: [] };
  }
  return null;
}
