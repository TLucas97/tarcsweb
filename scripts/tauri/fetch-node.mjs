import { createHash } from 'node:crypto';
import { chmod, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2];
const platforms = {
  'x86_64-unknown-linux-gnu': ['linux', 'x64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64'],
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-pc-windows-msvc': ['win', 'x64'],
  'aarch64-pc-windows-msvc': ['win', 'arm64'],
};
if (!platforms[target]) throw new Error('Pass a supported Rust target triple');
const [platform, arch] = platforms[target];
const version = process.env.TARCSWEB_NODE_VERSION;
if (version && !/^v?26\.\d+\.\d+$/.test(version)) throw new Error('TARCSWEB_NODE_VERSION must be a Node 26 release');
const base = `https://nodejs.org/dist/${version ? `v${version.replace(/^v/, '')}` : 'latest-v26.x'}`;
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
const extension = platform === 'win' ? 'zip' : 'tar.xz';
const match = sums.match(new RegExp(`^([a-f0-9]{64})\\s+(node-v26\\.\\d+\\.\\d+-${platform}-${arch}\\.${extension.replace('.', '\\.')})$`, 'm'));
if (!match) throw new Error(`No official Node 26 archive for ${target}`);
const [, expected, filename] = match;
const scratch = join(root, 'src-tauri', '.node-download', target);
await mkdir(scratch, { recursive: true });
try {
  const archive = await download(`${base}/${filename}`);
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Node archive SHA256 mismatch');
  const archivePath = join(scratch, filename);
  await writeFile(archivePath, archive);
  const folder = filename.replace(/\.(zip|tar\.xz)$/, '');
  const executable = platform === 'win' ? `${folder}/node.exe` : `${folder}/bin/node`;
  execFileSync('tar', ['-xf', archivePath, '-C', scratch, executable], { stdio: 'inherit' });
  const destination = join(root, 'src-tauri', 'binaries', `tarcsweb-node-${target}${platform === 'win' ? '.exe' : ''}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(scratch, executable), destination);
  if (platform !== 'win') await chmod(destination, 0o755);
  console.log(`Verified ${filename}; wrote ${destination}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
