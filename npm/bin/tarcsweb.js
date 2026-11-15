#!/usr/bin/env node
// Installs or updates tarcsweb with the get.sh packed next to it; arguments go to get.sh (a version, --yes, --help).
// On Windows it installs the desktop app from the GitHub release instead, since get.sh needs Linux, macOS or WSL2.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const RELEASES = 'https://github.com/TLucas97/tarcsweb/releases';
  const fail = (message) => {
    console.error(`${message}\nYou can also download tarcsweb-windows-x64.exe from ${RELEASES}/latest`);
    process.exit(1);
  };
  const args = process.argv.slice(2).filter((a) => a !== '--yes' && a !== '-y');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('npx tarcsweb [vX.Y.Z]\nOn Windows this installs the tarcsweb desktop app from the GitHub release (latest, or the version given).');
    process.exit(0);
  }
  const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
  const api = `https://api.github.com/repos/TLucas97/tarcsweb/releases/${tag ? `tags/${tag}` : 'latest'}`;
  const headers = { 'User-Agent': 'tarcsweb-npm', Accept: 'application/vnd.github+json' };
  const release = await fetch(api, { headers }).then((r) => (r.ok ? r.json() : fail(`Could not read the release (HTTP ${r.status}).`)), (e) => fail(`Could not reach GitHub: ${e.message}`));
  // Windows on ARM runs the x64 build through emulation.
  const asset = release.assets?.find((a) => a.name === 'tarcsweb-windows-x64.exe');
  if (!asset) fail(`Release ${release.tag_name} has no Windows installer yet. The installers are attached a few minutes after a release is published.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) fail('The release does not list a SHA-256 digest for the installer.');
  console.log(`Downloading tarcsweb ${release.tag_name} for Windows (${Math.round(asset.size / 1e6)} MB)...`);
  const data = Buffer.from(await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'tarcsweb-npm' } }).then((r) => (r.ok ? r.arrayBuffer() : fail(`Download failed (HTTP ${r.status}).`)), (e) => fail(`Download failed: ${e.message}`)));
  if (data.length !== asset.size || `sha256:${createHash('sha256').update(data).digest('hex')}` !== asset.digest.toLowerCase()) fail('The download does not match the release checksum.');
  const file = join(tmpdir(), `tarcsweb-${release.tag_name}-windows-x64.exe`);
  writeFileSync(file, data);
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  console.log('The installer is open. When it finishes, start tarcsweb from the Start menu and sign in under Settings > Account.');
  process.exit(0);
}

const getSh = fileURLToPath(new URL('../get.sh', import.meta.url));
// npx exports npm_config_prefix, which makes nvm refuse to install Node, so the installer gets no npm_* variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
const run = spawnSync('bash', [getSh, ...process.argv.slice(2)], { stdio: 'inherit', env });
if (run.error) {
  console.error(run.error.code === 'ENOENT' ? 'tarcsweb needs bash to install' : run.error.message);
  process.exit(1);
}
process.exit(run.status ?? 1);
