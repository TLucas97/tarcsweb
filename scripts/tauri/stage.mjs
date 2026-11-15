import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2];
const platforms = {
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
};
if (!platforms[target]) throw new Error('Pass a supported Rust target triple');
const stage = join(root, 'src-tauri', 'resources', 'app');
const scratch = join(root, 'src-tauri', '.sdk-download');
const options = { cwd: root, stdio: 'inherit' };
run('npx', ['--no-install', 'vite', 'build', '--outDir', join(root, 'dist')], options);
await rm(stage, { recursive: true, force: true });
try {
  // A separate install never touches the repo's node_modules; hoisted gives real folders, no links, on every OS.
  await mkdir(stage, { recursive: true });
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(join(root, f), join(stage, f));
  run('pnpm', ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'], { cwd: stage, stdio: 'inherit' });
  for (const entry of await readdir(stage)) {
    if (entry !== 'node_modules') await rm(join(stage, entry), { recursive: true, force: true });
  }
  await cp(join(root, 'server'), join(stage, 'server'), { recursive: true });
  // The server imports shared UI schemas.
  await cp(join(root, 'web/src'), join(stage, 'web/src'), { recursive: true });
  await cp(join(root, 'mods'), join(stage, 'mods'), { recursive: true });
  await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
  await copyFile(join(root, 'package.json'), join(stage, 'package.json'));
  const manifest = JSON.parse(await readFile(join(stage, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  const name = `@anthropic-ai/claude-agent-sdk-${platforms[target]}`;
  const version = manifest.optionalDependencies[name];
  if (!version) throw new Error(`SDK does not declare ${name}`);
  const metadataResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (!metadataResponse.ok) throw new Error(`SDK metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const tarballResponse = await fetch(metadata.dist.tarball);
  if (!tarballResponse.ok) throw new Error(`SDK archive: HTTP ${tarballResponse.status}`);
  const archive = Buffer.from(await tarballResponse.arrayBuffer());
  const [algorithm, expected] = metadata.dist.integrity.split('-');
  if (algorithm !== 'sha512' || createHash('sha512').update(archive).digest('base64') !== expected) throw new Error('SDK archive integrity mismatch');
  await mkdir(scratch, { recursive: true });
  const archivePath = join(scratch, 'sdk.tgz');
  await writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', scratch], { stdio: 'inherit' });
  // The SDK finds the binary in its platform package, so it ships once, there.
  const packagePath = join(stage, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platforms[target]}`);
  await rm(packagePath, { recursive: true, force: true });
  await cp(join(scratch, 'package'), packagePath, { recursive: true });
  console.log(`Staged ${target} app at ${stage}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
