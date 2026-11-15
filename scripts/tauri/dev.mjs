import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isolated = join(homedir(), '.cache', 'tarcsweb-tauri-dev');
const binary = join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'tarcsweb.exe' : 'tarcsweb');
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', () => reject(new Error('Port 24846 is occupied; stop the previous test instance first')));
  probe.listen(24846, '127.0.0.1', resolve);
});
await new Promise(resolve => probe.close(resolve));
await mkdir(join(isolated, 'cache'), { recursive: true });
async function copyOnce(source, destination) {
  try {
    await stat(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await copyFile(source, destination);
    } catch (copyError) {
      if (copyError.code !== 'ENOENT') throw copyError;
      await writeFile(destination, '{}\n', { mode: 0o600 });
    }
  }
}
await copyOnce(process.env.CW_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tarcsweb/config.json'), join(isolated, 'config.json'));
await copyOnce(process.env.CW_CLAUDE_SETTINGS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), join(isolated, 'claude-settings.json'));
async function newest(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.mtimeMs;
    let modified = info.mtimeMs;
    for (const entry of await readdir(path)) modified = Math.max(modified, await newest(join(path, entry)));
    return modified;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
const clientInputs = ['web', 'vite.config.ts', 'package.json', 'pnpm-lock.yaml'];
const clientTime = Math.max(...await Promise.all(clientInputs.map(path => newest(join(root, path)))));
if (clientTime > await newest(join(root, 'dist/index.html'))) {
  console.log('Building the client into the worktree dist directory');
  run('npx', ['--no-install', 'vite', 'build', '--outDir', join(root, 'dist')], { cwd: root, stdio: 'inherit' });
}
const rustInputs = ['src', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'capabilities', 'permissions', 'splash', 'icons'];
const rustTime = Math.max(...await Promise.all(rustInputs.map(path => newest(join(root, 'src-tauri', path)))));
if (rustTime > await newest(binary)) {
  console.log('Building the debug Tauri binary with six Cargo jobs');
  execFileSync('cargo', ['build', '-j', '6'], { cwd: join(root, 'src-tauri'), stdio: 'inherit' });
}
const child = spawn(binary, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    TARCSWEB_PORT: '24846',
    TARCSWEB_APP_DIR: root,
    CW_CONFIG: join(isolated, 'config.json'),
    CW_CACHE: join(isolated, 'cache'),
    CW_CLAUDE_SETTINGS: join(isolated, 'claude-settings.json'),
  },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', code => { process.exitCode = code ?? 1; });
