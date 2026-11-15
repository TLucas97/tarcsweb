import { execFileSync } from 'node:child_process';

export function run(command, args, options) {
  if (process.platform !== 'win32') return execFileSync(command, args, options);
  // Windows package-manager launchers are command scripts, not executables.
  return execFileSync(command, args.map(value => `"${value.replaceAll('"', '""')}"`), { ...options, shell: true });
}
