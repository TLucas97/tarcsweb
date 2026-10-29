import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FOLDER_SCRIPT as SCRIPT, HOOK_DIR } from './terminal.ts';
import { isWslHost } from './machine.ts';
import type { FolderMenuPlatform, FolderMenuView } from './protocol.ts';

// The file manager's right-click items (Settings › Folder menu). CW_FOLDER_MENU_HOME and CW_FOLDER_MENU_OS point
// checks at a throwaway folder and a forced platform, so the real menus stay untouched.
const HOME = process.env.CW_FOLDER_MENU_HOME || homedir();
const FORCED = process.env.CW_FOLDER_MENU_OS as FolderMenuPlatform | undefined;
// Desktop launchers do not load nvm, so the menus call this server's own Node by its full path.
const NODE = process.execPath;
// What marks a file or registry key as ours; anything without it is never overwritten or removed.
const MARK = 'tarcsweb folder menu';
const ITEMS = [
  { mode: 'new', label: 'New tarcsweb session here' },
  { mode: 'continue', label: 'Continue last tarcsweb session here' },
] as const;
const STEP_MS = 8000;

type File = { path: string; text: string; mode: number; utf16?: true };
type Plan = {
  note: string | null; files: File[];
  // Folders the files sit in that go too once empty (the macOS bundles), deepest first.
  dirs: string[];
  // Windows only: the Explorer verbs, imported from a .reg file and deleted key by key.
  keys: string[]; reg: string | null; regFile: string | null;
};

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<{ ok: boolean; out: string }>((done) =>
    execFile(cmd, args, { timeout: STEP_MS, cwd }, (err, out) => done({ ok: !err, out: String(out ?? '') })));

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Desktop Entry Exec quoting: escape inside double quotes, then the value's own backslash escaping, then %.
const execArg = (s: string) => `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`.replaceAll('\\', '\\\\').replaceAll('%', '%%');
const command = (mode: string, target: string) => `${sh(NODE)} ${sh(SCRIPT)} ${sh(HOOK_DIR)} ${mode} ${target}`;

async function detect(): Promise<FolderMenuPlatform | null> {
  if (FORCED && ['kde', 'gnome', 'wsl', 'mac'].includes(FORCED)) return FORCED;
  if (process.platform === 'darwin') return 'mac';
  if (process.platform !== 'linux') return null;
  if (await isWslHost()) return 'wsl';
  const desk = process.env.XDG_CURRENT_DESKTOP ?? '';
  return /kde/i.test(desk) ? 'kde' : /gnome|unity/i.test(desk) ? 'gnome' : null;
}

function kde(): Plan {
  // The launcher's icon: install.sh's themed one, else a stock terminal.
  const icon = [join(HOME, '.local/share/icons/hicolor/scalable/apps/tarcsweb.svg')].find((p) => existsSync(p)) ?? 'utilities-terminal';
  const exec = (mode: string) => `${execArg(NODE)} ${execArg(SCRIPT)} ${execArg(HOOK_DIR)} ${mode} %f`;
  const text = [
    `# ${MARK}: written by tarcsweb (Settings › Folder menu) and removed when it is turned off.`,
    '[Desktop Entry]',
    'Type=Service',
    // ServiceTypes for KF5, X-KDE-ServiceTypes for KF6.
    'ServiceTypes=KonqPopupMenu/Plugin',
    'X-KDE-ServiceTypes=KonqPopupMenu/Plugin',
    'MimeType=inode/directory;',
    'Actions=tarcswebNew;tarcswebContinue;',
    'X-KDE-Priority=TopLevel',
    ...ITEMS.flatMap((it) => [
      '',
      `[Desktop Action tarcsweb${it.mode === 'new' ? 'New' : 'Continue'}]`,
      `Name=${it.label}`,
      `Icon=${icon}`,
      `Exec=${exec(it.mode)}`,
    ]),
    '',
  ].join('\n');
  // KF6 skips service menus that are not executable.
  const files = [{ path: join(HOME, '.local/share/kio/servicemenus/tarcsweb-folder.desktop'), text, mode: 0o755 }];
  return { note: null, files, dirs: [], keys: [], reg: null, regFile: null };
}

function gnome(): Plan {
  const files = ITEMS.map((it) => ({
    path: join(HOME, '.local/share/nautilus/scripts', it.label),
    mode: 0o755,
    text: [
      '#!/bin/sh',
      `# ${MARK}: written by tarcsweb (Settings › Folder menu) and removed when it is turned off.`,
      '# The first selected item, else the folder on screen (a file:// URI, which open-folder.mjs decodes).',
      'target=$(printf \'%s\\n\' "$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS" | head -n 1)',
      '[ -n "$target" ] || target=$NAUTILUS_SCRIPT_CURRENT_URI',
      `exec ${command(it.mode, '"$target"')}`,
      '',
    ].join('\n'),
  }));
  return { note: 'They show under Scripts in the right-click menu.', files, dirs: [], keys: [], reg: null, regFile: null };
}

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${MARK} -->\n<plist version="1.0">\n${body}\n</plist>\n`;

// An Automator Quick Action: Info.plist registers the service for folders in Finder, document.wflow runs one shell step.
function mac(): Plan {
  const files: File[] = [];
  const dirs: string[] = [];
  for (const it of ITEMS) {
    const bundle = join(HOME, 'Library/Services', `${it.label}.workflow`);
    dirs.push(join(bundle, 'Contents'), bundle);
    files.push({
      path: join(bundle, 'Contents/Info.plist'), mode: 0o644,
      text: plist(`<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict><key>default</key><string>${xml(it.label)}</string></dict>
			<key>NSMessage</key><string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
			<key>NSSendFileTypes</key>
			<array><string>public.folder</string></array>
		</dict>
	</array>
</dict>`),
    });
    // Fixed per item, so a reinstall writes the same bytes and the view can tell the files are current.
    const [a, b, c] = ['in', 'out', 'action'].map((n) => createHash('sha1').update(`${it.mode}:${n}`).digest('hex').toUpperCase())
      .map((h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`);
    files.push({
      path: join(bundle, 'Contents/document.wflow'), mode: 0o644,
      text: plist(`<dict>
	<key>AMApplicationBuild</key><string>523</string>
	<key>AMApplicationVersion</key><string>2.10</string>
	<key>AMDocumentVersion</key><string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
				<key>AMActionVersion</key><string>2.0.3</string>
				<key>AMApplication</key><array><string>Automator</string></array>
				<key>AMParameterProperties</key>
				<dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
				<key>AMProvides</key>
				<dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
				<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key><string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key><string>${xml(`for f in "$@"; do ${command(it.mode, '"$f"')}; break; done`)}</string>
					<key>CheckedForUserDefaultShell</key><true/>
					<key>inputMethod</key><integer>1</integer>
					<key>shell</key><string>/bin/sh</string>
					<key>source</key><string></string>
				</dict>
				<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key><string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key><false/>
				<key>CanShowWhenRun</key><true/>
				<key>Category</key><array><string>AMCategoryUtilities</string></array>
				<key>Class Name</key><string>RunShellScriptAction</string>
				<key>InputUUID</key><string>${a}</string>
				<key>Keywords</key><array><string>Shell</string><string>Script</string></array>
				<key>OutputUUID</key><string>${b}</string>
				<key>UUID</key><string>${c}</string>
				<key>UnlocalizedApplications</key><array><string>Automator</string></array>
				<key>arguments</key><dict/>
				<key>isViewVisible</key><true/>
				<key>location</key><string>309.000000:253.000000</string>
				<key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key><true/>
		</dict>
	</array>
	<key>connectors</key><dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key><integer>0</integer>
		<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>`),
    });
  }
  return {
    note: 'They show under Quick Actions when a folder is selected, not on the window background.',
    files, dirs, keys: [], reg: null, regFile: null,
  };
}

const ROOT = 'HKCU\\Software\\Classes\\Directory';
const regKeys = () => ['shell', 'Background\\shell'].flatMap((at) => ITEMS.map((it) => `${ROOT}\\${at}\\tarcsweb.${it.mode}`));
const regStr = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

// Explorer runs a hidden VBScript launcher (window style 0), so no console flashes; it calls wsl.exe into this distro.
async function wsl(): Promise<Plan> {
  const distro = process.env.WSL_DISTRO_NAME;
  if (!distro) throw new Error('WSL_DISTRO_NAME is not set, so the distro to call is unknown.');
  // Run from a Windows drive, so cmd.exe does not warn about a UNC working folder.
  const got = await run('cmd.exe', ['/d', '/c', 'echo %LOCALAPPDATA%'], '/mnt/c');
  const winBase = got.out.trim();
  if (!got.ok || !winBase || winBase.includes('%')) throw new Error('Could not find the Windows profile folder (LOCALAPPDATA).');
  const linBase = (await run('wslpath', ['-u', winBase])).out.trim();
  if (!linBase) throw new Error(`Could not map ${winBase} to a WSL path.`);
  const winVbs = `${winBase}\\tarcsweb\\open-folder.vbs`;
  const q = (s: string) => `""${s}""`;
  const vbs = [
    `' ${MARK}: written by tarcsweb (Settings > Folder menu) and removed when it is turned off.`,
    'If WScript.Arguments.Count < 2 Then WScript.Quit',
    'p = WScript.Arguments(1)',
    "' A trailing backslash (C:\\) would escape the closing quote.",
    'If Right(p, 1) = "\\" Then p = p & "\\"',
    `CreateObject("WScript.Shell").Run "wsl.exe -d ${q(distro)} -e ${q(NODE)} ${q(SCRIPT)} ${q(HOOK_DIR)} " & WScript.Arguments(0) & " """ & p & """", 0, False`,
    '',
  ].join('\r\n');
  const reg = [
    'Windows Registry Editor Version 5.00',
    ...['shell', 'Background\\shell'].flatMap((at) => ITEMS.flatMap((it) => {
      const key = `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\${at}\\tarcsweb.${it.mode}`;
      const arg = at === 'shell' ? '%1' : '%V';
      return ['', `[${key}]`, `@=${regStr(it.label)}`, `"tarcsweb"=${regStr(MARK)}`, '', `[${key}\\command]`, `@=${regStr(`wscript.exe "${winVbs}" ${it.mode} "${arg}"`)}`];
    })),
    '',
  ].join('\r\n');
  return {
    note: 'On Windows 11 they sit under Show more options.',
    files: [{ path: join(linBase, 'tarcsweb/open-folder.vbs'), text: vbs, mode: 0o644, utf16: true }],
    dirs: [join(linBase, 'tarcsweb')], keys: regKeys(), reg, regFile: `${winBase}\\tarcsweb\\folder-menu.reg`,
  };
}

const plan = async (p: FolderMenuPlatform): Promise<Plan> => (p === 'kde' ? kde() : p === 'gnome' ? gnome() : p === 'mac' ? mac() : wsl());

const encode = (f: File) => (f.utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.text, 'utf16le')]) : Buffer.from(f.text));
const decode = (b: Buffer) => (b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8'));

// ours: has the mark; current: matches what would be written now (same Node, same repo path).
async function fileState(f: File) {
  const b = await readFile(f.path).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (b === null) return { exists: false, ours: false, current: false };
  return { exists: true, ours: decode(b).includes(MARK), current: b.equals(encode(f)) };
}

// Registry entries carry a tarcsweb value; a key without it belongs to something else.
async function keyState(key: string) {
  if (!(await run('reg.exe', ['query', key])).ok) return { exists: false, ours: false, current: false };
  const ours = (await run('reg.exe', ['query', key, '/v', 'tarcsweb'])).ok;
  return { exists: true, ours, current: ours };
}

async function states(p: Plan) {
  const files = await Promise.all(p.files.map(async (f) => ({ name: f.path, ...(await fileState(f)) })));
  const keys = await Promise.all(p.keys.map(async (k) => ({ name: k, ...(await keyState(k)) })));
  return [...files, ...keys];
}

const NONE: Omit<FolderMenuView, 'error'> = { platform: null, where: '', installed: false, partial: false, entries: [], note: null };

const WHERE: Record<FolderMenuPlatform, string> = { kde: 'Dolphin', gnome: 'Files (Nautilus)', wsl: 'Windows Explorer', mac: 'Finder' };

export async function folderMenuView(): Promise<FolderMenuView> {
  const platform = await detect();
  if (!platform) return { ...NONE, error: null };
  try {
    const p = await plan(platform);
    const st = await states(p);
    const ours = st.filter((s) => s.ours);
    return {
      platform, where: WHERE[platform], note: p.note, entries: st.map((s) => s.name), error: null,
      installed: ours.length > 0, partial: ours.length > 0 && !st.every((s) => s.current),
    };
  } catch (e) {
    return { ...NONE, platform, where: WHERE[platform], error: (e as Error).message };
  }
}

async function install(p: Plan) {
  const st = await states(p);
  const foreign = st.find((s) => s.exists && !s.ours);
  if (foreign) throw new Error(`${foreign.name} already exists and was not made by tarcsweb, so nothing was written.`);
  for (const f of p.files) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, encode(f), { mode: f.mode });
    await chmod(f.path, f.mode);
  }
  if (!p.reg || !p.regFile) return;
  const regPath = join(dirname(p.files[0]!.path), 'folder-menu.reg');
  await writeFile(regPath, encode({ path: regPath, text: p.reg, mode: 0o644, utf16: true }));
  const done = await run('reg.exe', ['import', p.regFile]);
  await unlink(regPath).catch(() => {});
  if (!done.ok) throw new Error('reg.exe could not add the Explorer menu items.');
}

async function uninstall(p: Plan) {
  for (const k of p.keys) if ((await keyState(k)).ours && !(await run('reg.exe', ['delete', k, '/f'])).ok) throw new Error(`Could not remove ${k}.`);
  for (const f of p.files) if ((await fileState(f)).ours) await unlink(f.path);
  // rmdir only removes empty folders, so anything else put in a bundle stays.
  for (const d of p.dirs) await rmdir(d).catch(() => {});
}

let chain: Promise<unknown> = Promise.resolve();

// Resolves with the error, null once done. Turning on rewrites only our own entries; off removes only those.
export function setFolderMenu(on: boolean): Promise<string | null> {
  const job = chain.then(async () => {
    try {
      const platform = await detect();
      if (!platform) return 'This desktop has no supported file manager menu.';
      const p = await plan(platform);
      await (on ? install(p) : uninstall(p));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  chain = job;
  return job;
}
