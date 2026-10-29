// Slash commands the app runs itself, for CLI commands the SDK does not run here; they never reach the model.
import { EFFORTS, type SessionSummary, type SlashItem } from '../../server/protocol.ts';
import { closeSession, isBusy, openNew, renameSession } from './actions.ts';
import { M, PM, applySettings } from './Menus.tsx';
import { toggleRemote } from './Remote.tsx';
import { openSettings } from './SettingsEntry.tsx';
import { send } from './socket.ts';
import { currentSummary, setPalette, useStore } from './store.ts';

// run returns why it could not run, shown as a notice. textFirst: a pick only types it, so it runs on send.
export type AppItem = SlashItem & { app: true; textFirst?: true; run: (args: string, s: SessionSummary) => string | void };

// Opens a composer popover through its own button; on narrow windows the folded chip set opens first.
function openPop(id: string) {
  const btn = document.querySelector<HTMLButtonElement>(`[popovertarget="${id}"]`);
  if (!btn) return 'Not available here';
  const set = btn.closest<HTMLElement>('.more-set');
  if (set && !btn.checkVisibility()) set.showPopover();
  btn.click();
}

const word = (args: string) => args.trim().toLowerCase();

const ITEMS: Omit<AppItem, 'app'>[] = [
  {
    name: 'rc', aliases: ['remote-control'], hint: '[on|off]', description: 'Turn Remote Control on or off for this session',
    run: (args, s) => {
      if (s.caps?.remote === false) return 'Remote Control works on Claude tabs only';
      const a = word(args);
      if (a && a !== 'on' && a !== 'off') return 'Use /rc, /rc on or /rc off';
      toggleRemote(s.id, a ? a === 'on' : !s.remote || s.remote.state === 'error');
    },
  },
  {
    name: 'model', hint: '[opus|sonnet|haiku|fable]', description: 'Switch the model, or open the model menu',
    run: (args, s) => {
      const a = word(args);
      if (!a || s.provider === 'codex') return openPop('modelPop');
      const m = M.find(([id, name]) => name.toLowerCase().includes(a) || id.includes(a));
      if (!m) return `No Claude model matches "${args.trim()}"`;
      applySettings({ model: m[0], ...(s.effort === 'ultra' ? { effort: 'max' as const } : {}) });
    },
  },
  {
    name: 'effort', hint: `[${EFFORTS.join('|')}]`, description: 'Set the effort, or open the model menu',
    run: (args, s) => {
      const a = word(args);
      if (!a || s.provider === 'codex') return openPop('modelPop');
      const e = EFFORTS.find((x) => x === a);
      if (!e) return `Effort is one of ${EFFORTS.join(', ')}`;
      applySettings({ effort: e });
    },
  },
  {
    name: 'mode', hint: '[ask|accept|plan|auto|bypass]', description: 'Set the permission mode, or open its menu',
    run: (args) => {
      const a = word(args);
      if (!a) return openPop('modePop');
      const m = PM.find(([id, label]) => id.toLowerCase() === a || label.toLowerCase().startsWith(a));
      if (!m) return 'Mode is one of ask, accept, plan, auto, bypass';
      applySettings({ mode: m[0] });
    },
  },
  { name: 'new', aliases: ['clear'], hint: '', description: 'Start a new session in this folder', run: (_a, s) => void openNew(s.cwd) },
  {
    name: 'rename', hint: '<name>', description: 'Rename this session',
    run: (args, s) => {
      const title = args.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!title) return 'Type the new name after /rename';
      renameSession(s.id, title);
    },
  },
  {
    name: 'handoff-now', hint: '', description: 'Write a handoff, then compact',
    run: (_a, s) => {
      if (s.caps?.handoff === false) return 'Handoff works on Claude tabs only';
      send({ type: 'handoff', sessionId: s.id });
    },
  },
  {
    name: 'reload', aliases: ['reload-plugins'], hint: '', description: 'Reload the session to pick up new instructions and settings',
    run: (_a, s) => (isBusy(s.id) ? 'Reload is available once it finishes' : void send({ type: 'reload', sessionId: s.id })),
  },
  { name: 'resume', hint: '', description: 'Open another session', run: () => setPalette('switch') },
  { name: 'mcp', hint: '', description: 'Show MCP servers', run: () => openPop('mcpPop') },
  { name: 'skills', hint: '', description: 'Open the skills library', run: () => openPop('skillsPop') },
  {
    name: 'settings', aliases: ['config'], hint: '', description: 'Open settings',
    run: () => openSettings(),
  },
  {
    name: 'close', aliases: ['exit', 'quit'], hint: '', description: 'Close this session; the history stays', textFirst: true,
    run: (_a, s) => (isBusy(s.id) ? 'It is busy; close it from its tab menu' : closeSession(s.id)),
  },
];

export const APP_COMMANDS: AppItem[] = ITEMS.map((i) => ({ ...i, app: true }));
// Names the app owns; an SDK command with one of them is left out of the menu.
export const APP_NAMES = new Set(APP_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));

// Commands with a required argument, or that close something, go in as text first; the rest run on pick.
export const needsArg = (c: AppItem) => c.hint.startsWith('<') || !!c.textFirst;

// "/name args" at the start of a message, when name is an app command.
export function appCommandOf(text: string): { item: AppItem; args: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const item = APP_COMMANDS.find((c) => c.name === m[1] || c.aliases?.includes(m[1]));
  return item ? { item, args: m[2] ?? '' } : null;
}

// Runs a command against the session on screen; problems show as a notice.
export function runApp(item: AppItem, args: string) {
  const s = currentSummary(useStore.getState());
  const why = s ? item.run(args, s) : 'Open a session first';
  if (!why) return;
  useStore.setState({ notice: why, noticeInfo: true });
  // A short shake on the composer answers "why didn't it run?" where the user typed; the notice gives the reason.
  const box = document.querySelector<HTMLElement>('.input');
  if (!box) return;
  box.classList.remove('nope');
  void box.offsetWidth;
  box.classList.add('nope');
  setTimeout(() => box.classList.remove('nope'), 700);
}
