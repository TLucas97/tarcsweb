#!/usr/bin/env node
// Installs or updates tarcsweb with the get.sh packed next to it; arguments go to get.sh (a version, --yes, --help).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.error(
    [
      'tarcsweb does not run on Windows directly yet. Install it inside WSL2:',
      '  1. In PowerShell:  wsl --install -d Ubuntu',
      '  2. In the Ubuntu terminal, with Node installed:  npx tarcsweb',
      'Then open http://localhost:24816 in your Windows browser.',
      'More in the README: https://github.com/TLucas97/tarcsweb#install',
    ].join('\n'),
  );
  process.exit(1);
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
