import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const target = process.argv[2] || host;
if (!target) throw new Error('Could not determine the Rust host target');
const ci = process.env.GITHUB_ACTIONS !== undefined;
const env = { ...process.env, CARGO_BUILD_JOBS: '6' };
if (ci) {
  delete env.TARCSWEB_SOURCE_DIR;
  delete env.TARCSWEB_BUILD_PATH;
} else {
  env.TARCSWEB_SOURCE_DIR = root;
  const appdir = process.env.APPDIR ? resolve(process.env.APPDIR) : null;
  env.TARCSWEB_BUILD_PATH = [dirname(process.execPath), ...(process.env.PATH || '').split(delimiter)]
    .filter((entry) => {
      if (!entry) return false;
      const path = resolve(entry);
      return !path.startsWith('/tmp/.mount_') && (!appdir || (path !== appdir && !path.startsWith(appdir + sep)));
    }).join(delimiter);
}
// CI passes missing Apple secrets as empty strings; Tauri would try to sign with them instead of ad-hoc ("-").
for (const key of Object.keys(env)) if (key.startsWith('APPLE_') && !env[key]) delete env[key];
const options = { cwd: root, stdio: 'inherit', env };
const config = ['--target', target, '--config', join(root, 'src-tauri/tauri.bundle.conf.json')];
const version = ci && process.env.RELEASE_TAG ? process.env.RELEASE_TAG.replace(/^v/, '') : undefined;
config.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: ci }, ...(version ? { version } : {}) }));
const args = process.argv.slice(3);
const at = args.findIndex((a) => a === '--bundles' || a === '-b');
// Without --bundles, Tauri builds the Linux formats listed in tauri.conf.json, AppImage included.
const linuxDefaults = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).bundle.targets.filter((t) => ['deb', 'rpm', 'appimage'].includes(t));
const bundles = at < 0 ? linuxDefaults : args[at + 1].split(',');
const rest = at < 0 ? args : args.toSpliced(at, 2);
console.log('Preparing desktop build');
execFileSync(process.execPath, [join(root, 'scripts/tauri/fetch-node.mjs'), target], options);
execFileSync(process.execPath, [join(root, 'scripts/tauri/stage.mjs'), target], options);

if (!target.includes('linux') || !bundles?.includes('appimage')) {
  run('npx', ['@tauri-apps/cli@2', 'build', ...config, ...args], options);
} else {
  const others = bundles.filter((b) => b !== 'appimage');
  run('npx', ['@tauri-apps/cli@2', 'build', ...config, ...(others.length ? ['--bundles', others.join(',')] : ['--no-bundle']), ...rest], options);
  // linuxdeploy rewrites the rpath of every ELF in the AppDir, which breaks the Claude Code binary (it segfaults).
  // So the AppImage is bundled without it, then repacked with the untouched binary.
  const arch = target.startsWith('aarch64') ? 'arm64' : 'x64';
  const sdk = join('node_modules', '@anthropic-ai', `claude-agent-sdk-linux-${arch}`);
  const binary = join(root, 'src-tauri', 'resources', 'app', sdk, 'claude');
  const aside = join(root, 'src-tauri', '.claude-aside');
  const out = join(root, 'src-tauri', 'target', target, 'release', 'bundle');
  await rm(join(out, 'appimage'), { recursive: true, force: true });
  await rm(join(out, 'appimage_deb'), { recursive: true, force: true });
  await rename(binary, aside);
  try {
    run('npx', ['@tauri-apps/cli@2', 'bundle', ...config, '--bundles', 'appimage', ...rest], options);
  } finally {
    await rename(aside, binary);
  }
  const dir = join(out, 'appimage');
  const image = execFileSync('find', [dir, '-maxdepth', '1', '-name', '*.AppImage'], { encoding: 'utf8' }).trim();
  const appDir = execFileSync('find', [dir, '-maxdepth', '1', '-name', '*.AppDir'], { encoding: 'utf8' }).trim();
  const placed = join(appDir, 'usr', 'lib', 'tarcsweb', 'app', sdk, 'claude');
  await copyFile(binary, placed);
  await chmod(placed, 0o755);
  await rm(image);
  const plugin = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tauri', 'linuxdeploy-plugin-appimage.AppImage');
  execFileSync(plugin, ['--appimage-extract-and-run', '--appdir', appDir], {
    cwd: dir, stdio: 'inherit', env: { ...env, ARCH: arch === 'arm64' ? 'aarch64' : 'x86_64', LDAI_OUTPUT: image },
  });
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    // Repacking replaces the signed bytes, so sign the final AppImage again.
    const signingEnv = { ...env };
    if (existsSync(signingEnv.TAURI_SIGNING_PRIVATE_KEY)) {
      signingEnv.TAURI_SIGNING_PRIVATE_KEY = readFileSync(signingEnv.TAURI_SIGNING_PRIVATE_KEY, 'utf8');
    }
    delete signingEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
    run('npx', ['@tauri-apps/cli@2', 'signer', 'sign', image], { ...options, env: signingEnv });
  }
}
