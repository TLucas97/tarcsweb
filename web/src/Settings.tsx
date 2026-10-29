import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { EFFORTS, type BrowserDefault, type ConfigLanguage, type Effort, type Mode, type Settings as SessionSettings, type SettingsPatch, type SettingsView } from '../../server/protocol.ts';
import { Check, Chev, CopyBtn, FOSI, MidCut, SPRING, XIcon, pref, reduceMotion, tilde, trapTab } from './bits.tsx';
import { onNotice, setDefaults, useStore } from './store.ts';
import { isBusy } from './actions.ts';
import { E, M, PM, roveMenu } from './Menus.tsx';
import { checkAgain, checkCodex, loadSettings, saveSettings, useSetup } from './setup.ts';
import { THEME_MODES, setThemeMode, useThemeMode, type ThemeMode } from './theme.ts';
import { setPref, usePref, useSavedPref, type PrefValue } from './prefs.ts';
import { useLite } from './perf.ts';
import { useDictation } from './dictation.ts';
import { setVoiceOn } from './Voice.tsx';
import { send } from './socket.ts';
import { CodexAccount, ExternalIcon, SignInFlow, SignedIn } from './Account.tsx';
import { checkUpdates, doneRun, failedRun, isActive, startUpdate, useUpdate } from './releases.ts';
import { UpdateSteps, busyText, notesUrl, useBusySessions } from './Update.tsx';
import { ESSENTIALS, READY, type Chapter } from './tour/chapters.ts';
import { playTour } from './tour/state.ts';
import { TourIcon } from './tour/Entry.tsx';
import { dropPreview, loadHooks, previewHooks, setHooks, useTerminal } from './terminal.ts';
import { loadFolderMenu, setFolderMenu, useFolderMenu } from './folderOpen.ts';

type Save = { saving: boolean; saved: boolean; error: string | null };

// Per-pane save state, so "Saved" and errors show next to what changed.
function useSave() {
  const [st, setSt] = useState<Save>({ saving: false, saved: false, error: null });
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = async (patch: SettingsPatch) => {
    clearTimeout(timer.current);
    setSt({ saving: true, saved: false, error: null });
    const error = await saveSettings(patch);
    setSt({ saving: false, saved: !error, error });
    if (!error) timer.current = window.setTimeout(() => setSt((s) => ({ ...s, saved: false })), 1600);
    return error;
  };
  return [st, save] as const;
}

const svg = (body: ReactNode) => () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
);
const AppearanceIcon = svg(<><circle cx="7" cy="7" r="5.2" /><path d="M7 1.8a5.2 5.2 0 0 1 0 10.4z" fill="currentColor" stroke="none" /></>);
const AccountIcon = svg(<path d="M7 6.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM2.6 12.2c.5-2.4 2.2-3.8 4.4-3.8s3.9 1.4 4.4 3.8" />);
const GlobeIcon = svg(<path d="M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 7 1.8zM1.8 7h10.4M7 1.8c1.4 1.5 2.1 3.2 2.1 5.2S8.4 10.7 7 12.2M7 1.8C5.6 3.3 4.9 5 4.9 7s.7 3.7 2.1 5.2" />);
const BellIcon = svg(<path d="M3.5 9.6V6.4a3.5 3.5 0 0 1 7 0v3.2l1.1 1.3H2.4zM5.8 12.4h2.4" />);
const UpdateIcon = svg(<path d="M11.7 6.3A4.8 4.8 0 0 0 3 4.3M2.3 7.7A4.8 4.8 0 0 0 11 9.7M3 1.8v2.5h2.5M11 12.2V9.7H8.5" />);
const ContextIcon = svg(<path d="M7 1.8v3.6M5.2 3.6 7 5.4l1.8-1.8M7 12.2V8.6M5.2 10.4 7 8.6l1.8 1.8M2.4 7h9.2" />);
const NewIcon = svg(<><rect x="1.8" y="1.8" width="10.4" height="10.4" rx="2.4" /><path d="M7 4.6v4.8M4.6 7h4.8" /></>);
const TerminalIcon = svg(<><rect x="1.8" y="2.4" width="10.4" height="9.2" rx="2" /><path d="M4.2 5.6 5.8 7 4.2 8.4M7.4 8.6h2.4" /></>);

const FolderIcon = svg(<path d="M1.8 4.2c0-.8.6-1.4 1.4-1.4h2.4l1.2 1.4h4c.8 0 1.4.6 1.4 1.4v4.8c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4zM5.4 8h3.2M7 6.4v3.2" />);

type PaneId = 'appearance' | 'account' | 'language' | 'sessions' | 'context' | 'notifications' | 'updates' | 'terminal' | 'folders' | 'tour';
const PANES: { id: PaneId; label: string; Icon: () => ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', Icon: AppearanceIcon },
  { id: 'account', label: 'Account', Icon: AccountIcon },
  { id: 'language', label: 'Language & voice', Icon: GlobeIcon },
  { id: 'sessions', label: 'New sessions', Icon: NewIcon },
  { id: 'context', label: 'Context', Icon: ContextIcon },
  { id: 'notifications', label: 'Notifications', Icon: BellIcon },
  { id: 'updates', label: 'Updates', Icon: UpdateIcon },
  { id: 'terminal', label: 'Terminal sessions', Icon: TerminalIcon },
  { id: 'folders', label: 'Folder menu', Icon: FolderIcon },
  { id: 'tour', label: 'Tour', Icon: TourIcon },
];
// Reopening lands on the pane used last, for as long as the page lives.
let lastPane: PaneId = 'appearance';

// Reserves the space of data that is still on its way, so nothing jumps when it lands.
const Sk = ({ w, h = 14 }: { w: number | string; h?: number }) => <span className="set-sk" style={{ width: w, height: h }} aria-hidden="true"></span>;

function PaneHead({ id, desc, side }: { id: PaneId; desc: string; side?: ReactNode }) {
  const p = PANES.find((x) => x.id === id)!;
  return (
    <header className="set-ph">
      <span className="set-pi"><p.Icon /></span>
      <div className="set-pt">
        <h2>{p.label}</h2>
        <p>{desc}</p>
      </div>
      {side && <div className="set-side">{side}</div>}
    </header>
  );
}

const SaveNote = ({ st }: { st: Save }) => <span className="set-ok" role="status">{st.saving ? 'Saving…' : st.saved ? 'Saved' : ''}</span>;

function Field({ label, hint, children }: { label: string; hint?: string; children: (labelId: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="set-f">
      <div className="set-l"><span id={id}>{label}</span>{hint && <small>{hint}</small>}</div>
      {children(id)}
    </div>
  );
}

type Tile<T> = { v: T; name: string; preview: ReactNode };

// A radio group drawn as preview cards; a click applies at once, arrows move and apply too.
function Tiles<T extends string | boolean>({ labelledBy, value, options, disabled, onPick }: { labelledBy: string; value: T; options: Tile<T>[]; disabled?: boolean; onPick: (v: T) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.v === value);
    const next = options[(i + step + options.length) % options.length].v;
    onPick(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-v="${String(next)}"]`)?.focus();
  };
  // Long lists wrap in rows of three.
  return (
    <div className="set-tiles" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} style={{ '--n': options.length > 4 ? 3 : options.length } as CSSProperties}>
      {options.map((o) => (
        <button
          key={String(o.v)} type="button" role="radio" className="set-tile" data-v={String(o.v)} aria-checked={o.v === value}
          tabIndex={o.v === value ? 0 : -1} disabled={disabled} onClick={() => o.v !== value && onPick(o.v)}
        >
          <span className="set-pv" aria-hidden="true">{o.preview}</span>
          <span className="set-tn">{o.name}<span className="set-ck"><Check /></span></span>
        </button>
      ))}
    </div>
  );
}

// A radio group drawn as segments; it applies on click, arrows move and apply too.
function Seg<T extends string>({ labelledBy, value, options, onPick }: { labelledBy: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o[0] === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length][0];
    onPick(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-v="${next}"]`)?.focus();
  };
  return (
    <div className="set-seg" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {options.map(([v, n]) => (
        <button
          key={v} type="button" role="radio" data-v={v} aria-checked={v === value} tabIndex={v === value ? 0 : -1}
          onClick={() => v !== value && onPick(v)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// Shows the saved view at once; the server's reply replaces it, which also undoes a refused change.
const optimistic = (patch: Partial<SettingsView>) => useSetup.setState((s) => (s.settings ? { settings: { ...s.settings, ...patch } } : s));

// A toggle that applies on click; the label is clickable too, so the whole text is a target.
function Switch({ label, hint, on, disabled, busy, onFlip }: { label: string; hint?: string; on: boolean; disabled?: boolean; busy?: boolean; onFlip: () => void }) {
  const id = useId();
  return (
    <div className="set-swrow">
      <div className="set-l">
        <label htmlFor={id}>{label}</label>
        {hint && <small id={`${id}-h`}>{hint}</small>}
      </div>
      <button
        id={id} type="button" role="switch" className="set-sw" aria-checked={on} aria-busy={busy} disabled={disabled}
        aria-describedby={hint ? `${id}-h` : undefined} onClick={onFlip}
      >
        <i></i>
      </button>
    </div>
  );
}

// A small window in a fixed palette, so each theme previews itself whatever theme is on.
const Win = ({ t }: { t: 'light' | 'dark' }) => <span className="pv-win" data-t={t}><b></b><i></i><i></i><i></i><em></em></span>;
const THEME_PV: Record<ThemeMode, ReactNode> = {
  system: <><Win t="light" /><span className="pv-half"><Win t="dark" /></span></>,
  light: <Win t="light" />,
  dark: <Win t="dark" />,
};

// id, name, and the face each option is drawn in.
type Face<T> = [T, string, string];
const FONTS: Face<PrefValue<'font'>>[] = [
  ['lexend', 'Lexend', 'var(--font-lexend)'],
  ['noto-serif', 'Noto Serif', 'var(--font-noto-serif)'],
  ['dyslexic', 'OpenDyslexic', 'var(--font-dyslexic)'],
  ['roboto-mono', 'Roboto Mono', 'var(--font-roboto-mono)'],
  ['roboto-slab', 'Roboto Slab', 'var(--font-roboto-slab)'],
  ['bebas', 'Bebas Neue', 'var(--font-bebas)'],
  ['jetbrains-mono', 'JetBrains Mono', 'var(--font-jetbrains-mono)'],
  ['fira-code', 'Fira Code', 'var(--font-fira-code)'],
  ['bricolage', 'Bricolage Grotesque', 'var(--font-bricolage)'],
  ['maven', 'Maven Pro', 'var(--font-maven)'],
];
const MSG_FONTS: Face<PrefValue<'msgFont'>>[] = [['app', 'Same as app', 'var(--sans)'], ...FONTS];

// A compact font picker: the button and every option are drawn in their own face.
function FontPick<T extends string>({ labelledBy, value, options, onPick }: { labelledBy: string; value: T; options: Face<T>[]; onPick: (v: T) => void }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const p = pop.current!;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const r = btn.current!.getBoundingClientRect();
      p.style.left = `${r.left}px`;
      p.style.top = `${r.bottom + 6}px`;
      p.style.width = `${r.width}px`;
    };
    const toggled = (e: Event) => {
      const on = (e as ToggleEvent).newState === 'open';
      setOpen(on);
      if (on) p.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    };
    p.addEventListener('beforetoggle', place);
    p.addEventListener('toggle', toggled);
    return () => {
      p.removeEventListener('beforetoggle', place);
      p.removeEventListener('toggle', toggled);
    };
  }, []);
  const [, name, face] = options.find((o) => o[0] === value) ?? options[0];
  return (
    <>
      <button ref={btn} type="button" className="set-fp" popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${labelledBy} ${id}-v`}>
        <span id={`${id}-v`} style={{ fontFamily: face }}>{name}</span><Chev />
      </button>
      <div className="pop mpop ctx set-fpop" id={id} popover="auto" ref={pop} role="menu" aria-labelledby={labelledBy} onKeyDown={roveMenu}>
        {options.map(([v, n, f]) => (
          <button
            key={v} type="button" className="mi" role="menuitemradio" aria-checked={v === value}
            onClick={() => {
              pop.current!.hidePopover();
              if (v !== value) onPick(v);
            }}
          >
            <span className="nm2" style={{ fontFamily: f }}>{n}</span>
            <span className="side"><span className="ck"><Check /></span></span>
          </button>
        ))}
      </div>
    </>
  );
}
const SIZES: Tile<PrefValue<'textScale'>>[] = [
  { v: 's', name: 'Small', preview: <span className="pv-aa" style={{ fontSize: 18 }}>Aa</span> },
  { v: 'm', name: 'Medium', preview: <span className="pv-aa" style={{ fontSize: 21 }}>Aa</span> },
  { v: 'l', name: 'Large', preview: <span className="pv-aa" style={{ fontSize: 24 }}>Aa</span> },
  { v: 'xl', name: 'Extra large', preview: <span className="pv-aa" style={{ fontSize: 28 }}>Aa</span> },
];
const BACKDROPS: Tile<PrefValue<'backdrop'>>[] = [
  { v: true, name: 'Animated grid', preview: <span className="pv-grid"><i></i></span> },
  { v: false, name: 'Plain', preview: <span className="pv-plain"></span> },
];

const REPLY_HINT: Record<PrefValue<'replyStyle'>, string> = {
  stretch: 'Short answers. Click an underlined phrase to grow it in place.',
  summary: 'Full answers, with a TL;DR on top of long ones.',
};

// Open sessions whose reload waits for their reply or agents to end; the server refuses a reload while busy.
const restyle = new Set<string>();
const restyleSubs = new Set<() => void>();
let restyleRev = 0;
let unwatchRestyle: (() => void) | null = null;
// The server's reply notice names no session, so one reload goes out at a time and an id leaves only once confirmed.
let restyleAsking: string | null = null;
// Refused while they looked idle here (a handoff, say); retried once their state changes.
const restyleHeld = new Set<string>();
const RELOAD_REFUSED = /^(?:Session is busy|Agents are still running)/;

function flushRestyle() {
  const open = new Set(useStore.getState().roster.map((r) => r.id));
  let changed = false;
  for (const id of restyle) {
    if (!open.has(id)) {
      restyle.delete(id);
      restyleHeld.delete(id);
      if (restyleAsking === id) restyleAsking = null;
      changed = true;
    } else if (!restyleAsking && !restyleHeld.has(id) && !isBusy(id) && send({ type: 'reload', sessionId: id })) restyleAsking = id;
  }
  if (!restyle.size && unwatchRestyle) {
    unwatchRestyle();
    unwatchRestyle = null;
  }
  if (changed) {
    restyleRev++;
    for (const fn of restyleSubs) fn();
  }
}

function restyleReply(message: string) {
  const id = restyleAsking;
  if (!id || (message !== 'Session reloaded' && !RELOAD_REFUSED.test(message))) return;
  restyleAsking = null;
  if (message === 'Session reloaded') {
    restyle.delete(id);
    restyleRev++;
    for (const fn of restyleSubs) fn();
  } else restyleHeld.add(id);
  flushRestyle();
}

function watchRestyle() {
  const offRoster = useStore.subscribe((s, old) => {
    // A lost socket loses the reply too; the reload goes again after hello.
    if (!s.connected) restyleAsking = null;
    if (s.roster === old.roster) return;
    for (const id of restyleHeld) {
      const now = s.roster.find((r) => r.id === id);
      const was = old.roster.find((r) => r.id === id);
      if (now?.state !== was?.state || now?.background !== was?.background) restyleHeld.delete(id);
    }
    flushRestyle();
  });
  const offNotice = onNotice(restyleReply);
  return () => {
    offRoster();
    offNotice();
  };
}

// The prompt changes with it, so every open session reloads to pick it up: idle ones now, busy ones once they go idle.
function pickReplyStyle(v: PrefValue<'replyStyle'>) {
  setPref('replyStyle', v);
  for (const r of useStore.getState().roster) restyle.add(r.id);
  restyleHeld.clear();
  restyleRev++;
  unwatchRestyle ??= watchRestyle();
  flushRestyle();
  for (const fn of restyleSubs) fn();
}

const onRestyle = (fn: () => void) => {
  restyleSubs.add(fn);
  return () => void restyleSubs.delete(fn);
};

// True while the current session's new reply style waits for its reply to end.
function useRestylePending() {
  const current = useStore((s) => s.current);
  useSyncExternalStore(onRestyle, () => restyleRev);
  return !!current && restyle.has(current);
}

// Stored in this browser; the server only hears the reply style, and owns Lite mode.
function AppearancePane() {
  const mode = useThemeMode();
  const font = usePref('font');
  const msgFont = usePref('msgFont');
  const size = usePref('textScale');
  // Lite turns these off but they keep showing the saved choice, which comes back when Lite is off.
  const backdrop = useSavedPref('backdrop');
  const reply = usePref('replyStyle');
  const replyLater = useRestylePending();
  const ripple = useSavedPref('clickRipple');
  const cursor = usePref('cursor');
  const lite = useLite();
  const s = useSetup((x) => x.settings);
  const [st, save] = useSave();
  // No optimistic flip: the server broadcasts the new profile to every window, this one included.
  const flipLite = () => {
    if (!st.saving) void save({ perf: lite ? 'standard' : 'lite' });
  };
  return (
    <>
      <PaneHead id="appearance" desc="How tarcsweb looks in this browser." side={<SaveNote st={st} />} />
      <div className="set-card">
        <Switch
          label="Lite mode"
          hint={s?.perfForced ? 'Set by CW_PROFILE when the server started.' : 'Turns off extras so the app stays fast on slower machines. Applies to every window.'}
          on={lite} disabled={s?.perfForced} busy={st.saving} onFlip={flipLite}
        />
      </div>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
      <Field label="Theme" hint={THEME_MODES.find((m) => m[0] === mode)![2]}>
        {(id) => <Tiles labelledBy={id} value={mode} onPick={setThemeMode} options={THEME_MODES.map(([v, name]) => ({ v, name, preview: THEME_PV[v] }))} />}
      </Field>
      <Field label="Font" hint="Messages covers replies, your messages and the composer. Code stays monospace.">
        {(id) => (
          <div className="set-fonts">
            <div className="set-fl"><span id={`${id}-app`}>App</span><FontPick labelledBy={`${id}-app`} value={font} onPick={(v) => setPref('font', v)} options={FONTS} /></div>
            <div className="set-fl"><span id={`${id}-msg`}>Messages</span><FontPick labelledBy={`${id}-msg`} value={msgFont} onPick={(v) => setPref('msgFont', v)} options={MSG_FONTS} /></div>
          </div>
        )}
      </Field>
      <Field label="Text size" hint="Conversation, composer and reader.">
        {(id) => <Tiles labelledBy={id} value={size} onPick={(v) => setPref('textScale', v)} options={SIZES} />}
      </Field>
      <Field label="Background" hint={lite ? (backdrop ? 'A still grid in Lite.' : 'Off in Lite') : backdrop ? 'A faint grid that lights up under the mouse.' : 'Just the theme color. Nothing runs behind the app.'}>
        {(id) => <Tiles labelledBy={id} value={backdrop} disabled={lite} onPick={(v) => setPref('backdrop', v)} options={BACKDROPS} />}
      </Field>
      <Field label="Replies" hint={REPLY_HINT[reply]}>
        {(id) => (
          <div className="set-row set-mid">
            <Seg<PrefValue<'replyStyle'>> labelledBy={id} value={reply} options={[['stretch', 'Stretch'], ['summary', 'Summary']]} onPick={pickReplyStyle} />
            <span className="set-note" role="status">{replyLater ? 'Applies after the current reply' : ''}</span>
          </div>
        )}
      </Field>
      <div className="set-card">
        <Switch
          label="Click ripple" hint={lite ? 'Off in Lite' : 'A faint ring where you click. Buttons and links get a warmer one, and close buttons a ring that shrinks.'}
          on={ripple} disabled={lite} onFlip={() => setPref('clickRipple', !ripple)}
        />
        <Switch
          label="App cursor" hint="Swaps the system cursors (arrow, link hand, text, drag, resize) for a set in the app's colors."
          on={cursor} onFlip={() => setPref('cursor', !cursor)}
        />
      </div>
    </>
  );
}

function AccountPane() {
  const status = useSetup((x) => x.status);
  const checking = useSetup((x) => x.checking);
  const codex = useSetup((x) => x.codex);
  const connected = useStore((x) => x.connected);
  // The first look starts Codex's app-server; later opens use the status the server cached.
  useEffect(() => {
    if (connected && !useSetup.getState().codex) checkCodex();
  }, [connected]);
  return (
    <>
      <PaneHead id="account" desc="The Claude and Codex accounts used on this computer." />
      <section className="set-grp" aria-labelledby="set-acct-claude">
        <h3 id="set-acct-claude">Claude</h3>
        <div className="set-card">
          {!status ? (
            <div className="set-skrow tall"><Sk w="46%" /><Sk w={64} h={24} /></div>
          ) : status.loggedIn ? <SignedIn status={status} /> : (
            <>
              <div className="set-acct">
                <span className="set-state">Not signed in</span>
                <button type="button" className="set-clear" onClick={checkAgain} disabled={checking} aria-busy={checking}>{checking ? 'Checking…' : 'Check again'}</button>
              </div>
              <SignInFlow />
              {status.error && <p className="set-err" role="status">Couldn't check: {status.error}</p>}
            </>
          )}
        </div>
      </section>
      <section className="set-grp" aria-labelledby="set-acct-codex">
        <h3 id="set-acct-codex">Codex</h3>
        <div className="set-card">
          {codex ? <CodexAccount status={codex} /> : <div className="set-skrow tall"><Sk w="46%" /><Sk w={64} h={24} /></div>}
        </div>
      </section>
    </>
  );
}

// The voice switch is the same as the speaker button in the composer; null means Kokoro is not installed.
function LanguagePane({ s }: { s: SettingsView | null }) {
  const [st, save] = useSave();
  const voice = useStore((x) => x.voiceOn);
  // The server refuses recaps in Lite; the saved switch stays as it was.
  const lite = useLite();
  const dictation = usePref('voiceInput');
  const dict = useDictation();
  const pick = (language: ConfigLanguage) => {
    optimistic({ language });
    void save({ language });
  };
  return (
    <>
      <PaneHead id="language" desc="Generated text, recaps read aloud, and voice input." side={<SaveNote st={st} />} />
      <Field label="Generated text" hint="Summaries, recaps and notifications. The interface stays in English.">
        {(id) => s
          ? <Seg<ConfigLanguage> labelledBy={id} value={s.language} options={[['en', 'English'], ['pt-BR', 'Português (Brasil)']]} onPick={pick} />
          : <Sk w={250} h={36} />}
      </Field>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
      <div className="set-card">
        <Switch
          label="Listen button on replies" hint={voice === null ? undefined : lite ? 'Off in Lite' : 'Reads a short recap of a reply aloud, in the language above.'}
          on={voice === true} disabled={voice === null || lite} onFlip={() => voice !== null && !lite && setVoiceOn(!voice)}
        />
        {voice === null && <p className="set-hint">Not installed. Run ./install.sh again and answer yes to voice.</p>}
      </div>
      <div className="set-card">
        <Switch
          label="Voice input (hold Space)" hint="Hold Space in the message box and talk, or click the mic to start and again to stop. Transcribed by Claude Code's voice mode, in the language above. Saved in this browser."
          on={dictation} onFlip={() => setPref('voiceInput', !dictation)}
        />
        {dictation && dict.engine === 'unavailable' && dict.reason && <p className="set-hint">{dict.reason}.</p>}
      </div>
    </>
  );
}

// Bypass is never offered: a new session must not start running everything unasked.
const NEW_MODES = PM.filter(([m]) => m !== 'bypassPermissions');
const BROWSER_OPTIONS: [BrowserDefault, string][] = [['ask', 'Ask'], ['background', 'Always background'], ['chrome', 'Always my Chrome']];
const BROWSER_HINT: Record<BrowserDefault, string> = {
  ask: 'The first browser task asks',
  background: 'The Browser panel, with no window',
  chrome: 'Your Chrome, through Claude in Chrome',
};

// What "+" and a new folder open with; saved to the config file, so every window and browser shares it.
function NewSessionsPane({ s }: { s: SettingsView | null }) {
  const [st, save] = useSave();
  const d = s?.defaults;
  const pick = (patch: Partial<SessionSettings>) => {
    if (!d || st.saving) return;
    const next = { ...d, ...patch };
    // Bypass is not offered here, so a hand-set one becomes Ask on the first change.
    if (next.mode === 'bypassPermissions') next.mode = 'default';
    optimistic({ defaults: next });
    void save({ defaults: next }).then((error) => {
      if (error) return optimistic({ defaults: d });
      setDefaults(next);
      // Other windows of this browser pick it up through the storage event (actions.ts).
      pref.set('newDefaults', next);
    });
  };
  const pickBrowser = (browserDefault: BrowserDefault) => {
    if (!s || st.saving) return;
    const prev = s.browserDefault;
    optimistic({ browserDefault });
    void save({ browserDefault }).then((error) => error && optimistic({ browserDefault: prev }));
  };
  const models: [string, string][] = M.map(([id, name]) => [id, name]);
  if (d && !models.some(([id]) => id === d.model)) models.push([d.model, d.model]);
  const mode = NEW_MODES.find(([m]) => m === d?.mode);
  return (
    <>
      <PaneHead id="sessions" desc="What a new session starts with. Each tab can still change its own." side={<SaveNote st={st} />} />
      {s && !d ? <p className="set-hint">Restart tarcsweb to edit these here.</p> : (
        <>
          <Field label="Permission mode" hint={d ? mode?.[2] ?? 'Bypass, set by hand in the config file. Any change here replaces it with Ask.' : undefined}>
            {(id) => d ? <Seg<Mode> labelledBy={id} value={d.mode} options={NEW_MODES.map(([m, n]): [Mode, string] => [m, n])} onPick={(v) => pick({ mode: v })} /> : <Sk w={320} h={36} />}
          </Field>
          <Field label="Model" hint={d ? M.find(([id]) => id === d.model)?.[2] : undefined}>
            {(id) => d ? <Seg<string> labelledBy={id} value={d.model} options={models} onPick={(v) => pick({ model: v })} /> : <Sk w={320} h={36} />}
          </Field>
          <Field label="Effort" hint={d ? E[d.effort] : undefined}>
            {(id) => d ? <Seg<Effort> labelledBy={id} value={d.effort} options={EFFORTS.map((e): [Effort, string] => [e, e])} onPick={(v) => pick({ effort: v })} /> : <Sk w={280} h={36} />}
          </Field>
        </>
      )}
      {(!s || s.browserDefault) && (
        <Field label="Browser for agents" hint={s?.browserDefault ? BROWSER_HINT[s.browserDefault] : undefined}>
          {(id) => s?.browserDefault ? <Seg<BrowserDefault> labelledBy={id} value={s.browserDefault} options={BROWSER_OPTIONS} onPick={pickBrowser} /> : <Sk w={360} h={36} />}
        </Field>
      )}
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
    </>
  );
}

const HANDOFF_SIZES = [200_000, 350_000, 500_000, 750_000];
const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// A size set by hand in config.json shows as one more segment, so it stays picked.
function ContextPane({ s }: { s: SettingsView | null }) {
  const [st, save] = useSave();
  const at = s?.handoffAt ?? null;
  const sizes = at !== null && !HANDOFF_SIZES.includes(at) ? [...HANDOFF_SIZES, at].sort((a, b) => a - b) : HANDOFF_SIZES;
  const pick = (v: string) => {
    const handoffAt = v === 'off' ? null : Number(v);
    optimistic({ handoffAt });
    void save({ handoffAt: handoffAt ?? false });
  };
  const hint = at === null
    ? "No handoff. Claude Code's own auto-compact runs when the context is nearly full."
    : `When a turn ends past ${tokens(at)} tokens, Claude writes a handoff note and the session compacts with it. Models with a smaller context window use their own auto-compact.`;
  const notes = s?.youShouldKnow ?? true;
  const flipNotes = () => {
    if (st.saving) return;
    optimistic({ youShouldKnow: !notes });
    void save({ youShouldKnow: !notes });
  };
  return (
    <>
      <PaneHead id="context" desc="When a long session hands off and compacts, and who watches it." side={<SaveNote st={st} />} />
      <div className="set-card">
        <Switch label="Clean up inactive session groups" hint="Remove group summaries after 30 days of inactivity. A notice appears after 23 days. Conversations and worktrees are kept." on={s?.groupAutoCleanup ?? true} disabled={!s} busy={st.saving} onFlip={() => { const groupAutoCleanup = !s?.groupAutoCleanup; optimistic({ groupAutoCleanup }); void save({ groupAutoCleanup }); }} />
      </div>
      <Field label="Handoff and compact at" hint={s ? hint : undefined}>
        {(id) => s
          ? <Seg<string> labelledBy={id} value={at === null ? 'off' : String(at)} options={[...sizes.map((n): [string, string] => [String(n), tokens(n)]), ['off', 'Off']]} onPick={pick} />
          : <Sk w={300} h={36} />}
      </Field>
      <div className="set-card">
        <Switch
          label="Side notes (You should know)"
          hint="A side agent reads the session and adds heads-up notes about things you or Claude might miss. It uses your plan's usage. Applies to new sessions, or after Reload on a tab."
          on={notes} disabled={!s} busy={st.saving} onFlip={flipNotes}
        />
      </div>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
    </>
  );
}

type Perm = NotificationPermission | 'unsupported';
const PERM_TEXT: Record<Perm, string> = {
  granted: 'Browser permission: allowed.',
  default: 'Browser permission: not asked yet. Turning this on asks for it.',
  denied: "Browser permission: blocked. Allow notifications for this site in the browser's site settings, then turn this on.",
  unsupported: 'This browser has no desktop notifications.',
};
const readPerm = (): Perm => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

// On asks the browser for permission when it has not been given yet; off only stops the notices here.
function DesktopNotices() {
  const want = usePref('desktopNotify');
  const [perm, setPerm] = useState<Perm>(readPerm);
  const [asking, setAsking] = useState(false);
  // The permission can change in the browser's site settings while this is open.
  useEffect(() => {
    let st: PermissionStatus | null = null;
    let live = true;
    const sync = () => setPerm(readPerm());
    void navigator.permissions?.query({ name: 'notifications' }).then((s) => {
      // Settings may have closed before the query resolved.
      if (!live) return;
      st = s;
      s.addEventListener('change', sync);
    }, () => {});
    return () => {
      live = false;
      st?.removeEventListener('change', sync);
    };
  }, []);
  const on = want && perm === 'granted';
  const flip = async () => {
    if (on) return setPref('desktopNotify', false);
    if (perm !== 'granted') {
      setAsking(true);
      const p = await Notification.requestPermission().catch(() => readPerm());
      setAsking(false);
      setPerm(p);
      if (p !== 'granted') return;
    }
    setPref('desktopNotify', true);
  };
  return (
    <div className="set-card">
      <Switch
        label="Desktop notifications" hint="While this window is in the background: a session finishes or needs you, an agent fails, or all of a session's agents end."
        on={on} busy={asking} disabled={asking || perm === 'unsupported' || perm === 'denied'} onFlip={() => void flip()}
      />
      <p className="set-hint" role="status">{PERM_TEXT[perm]}</p>
    </div>
  );
}

// On makes a random topic on the server and applies at once; the topic is shown here only.
function NotificationsPane({ s }: { s: SettingsView | null }) {
  const [st, save] = useSave();
  const [want, setWant] = useState<boolean | null>(null);
  const on = want ?? !!s?.ntfy;
  const flip = async () => {
    if (st.saving) return;
    setWant(!on);
    await save({ ntfy: !on });
    setWant(null);
  };
  const ntfy = s?.ntfy;
  const hum = useSavedPref('soundHum');
  const voice = useSavedPref('soundVoice');
  const fx = useSavedPref('soundFx');
  const volume = usePref('soundVolume');
  const lite = useLite();
  return (
    <>
      <PaneHead id="notifications" desc="Sounds and desktop notices in this browser, and pushes to your phone through ntfy." side={<SaveNote st={st} />} />
      <div className="set-card">
        <Switch
          label="Hum while agents work" hint={lite ? 'Off in Lite' : 'A quiet hum during long turns.'}
          on={hum} disabled={lite} onFlip={() => setPref('soundHum', !hum)}
        />
        <Switch
          label="Robot voice" hint={lite ? 'Off in Lite' : 'A short spoken line when work finishes or needs you.'}
          on={voice} disabled={lite} onFlip={() => setPref('soundVoice', !voice)}
        />
        <Switch
          label="Other sound effects" hint={lite ? 'Off in Lite' : 'Message sent, the needs-you chime, and clicks on the robot.'}
          on={fx} disabled={lite} onFlip={() => setPref('soundFx', !fx)}
        />
      </div>
      {(hum || voice || fx) && !lite && (
        <Field label="Sound volume">
          {(id) => <Seg<PrefValue<'soundVolume'>> labelledBy={id} value={volume} options={[['low', 'Low'], ['mid', 'Medium'], ['high', 'High']]} onPick={(v) => setPref('soundVolume', v)} />}
        </Field>
      )}
      <DesktopNotices />
      <div className="set-card">
        {s ? (
          <>
            <Switch label="Push to my phone" hint="When a session waits for you, or a long turn ends." on={on} busy={st.saving} onFlip={flip} />
            {ntfy && on && (
              <div className="set-ntfy">
                <p className="set-hint">Install the ntfy app on your phone and subscribe to this topic:</p>
                <div className="set-topic">
                  <code className="mono">{ntfy.topic}</code>
                  <CopyBtn text={ntfy.topic} what="topic" />
                </div>
                <a className="si-link" href={`${ntfy.server}/${ntfy.topic}`} target="_blank" rel="noreferrer">Open on your phone<ExternalIcon /></a>
              </div>
            )}
          </>
        ) : <div className="set-skrow"><Sk w="52%" /><Sk w={34} h={20} /></div>}
      </div>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
    </>
  );
}

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

// Releases only: the version line with Check now, then whatever the latest release asks for.
function UpdatesPane() {
  const s = useUpdate((x) => x.status);
  const home = useStore((x) => x.home);
  const busy = useBusySessions();
  if (!s) {
    return (
      <>
        <PaneHead id="updates" desc="New versions of tarcsweb, from tested releases only." />
        <div className="set-card"><div className="set-skrow tall"><Sk w="44%" /><Sk w={84} h={24} /></div></div>
      </>
    );
  }
  const active = isActive(s.run) ? s.run : null;
  const failed = failedRun(s);
  const done = doneRun(s);
  const latest = s.latest;
  const line = s.checking ? 'Checking for updates…'
    : s.checkError ?? (s.available && latest ? `${latest.tag} is available` : s.checkedAt ? `Up to date · checked ${ago(s.checkedAt)}` : 'Not checked yet');
  return (
    <>
      <PaneHead id="updates" desc="New versions of tarcsweb, from tested releases only." />
      <div className="set-card">
        <div className="upd-ver">
          <div className="set-l">
            <span>tarcsweb <span className="mono">v{s.current}</span></span>
            <small role="status">{line}</small>
          </div>
          <button type="button" className="set-clear" onClick={checkUpdates} disabled={s.checking || !!active} aria-busy={s.checking}>
            {s.checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      {active ? (
        <div className="set-card" role="status" aria-busy="true">
          <span className="upd-title">Updating to {active.tag}</span>
          <UpdateSteps step={active.step} />
          <p className="set-hint">This page reconnects by itself after the restart.</p>
        </div>
      ) : done ? (
        <div className="set-card">
          <span className="upd-title">Updated to {done.tag}</span>
          <a className="si-link upd-notes" href={notesUrl(s, done.tag)} target="_blank" rel="noreferrer">What's new<ExternalIcon /></a>
        </div>
      ) : s.available && latest ? (
        <div className="set-card">
          <span className="upd-title">{latest.tag} is available</span>
          {s.canUpdate ? (
            <>
              <div className="upd-row">
                <button type="button" className="set-btn" onClick={() => startUpdate(latest.tag)}>{failed ? 'Try again' : `Update to ${latest.tag}`}</button>
                <a className="si-link upd-notes" href={latest.url} target="_blank" rel="noreferrer">What's new<ExternalIcon /></a>
              </div>
              {failed && <p className="set-err" role="alert">The last try failed: {failed.message || 'it stopped early.'} You're still on v{s.current}.</p>}
              <p className="set-hint">
                {busy ? `${busyText(busy)} ` : ''}It downloads, installs and test-starts the release, then restarts the app. If a step fails, you stay on v{s.current}.
                {failed && <> Details are in <span className="mono">{tilde(s.log, home)}</span>.</>}
              </p>
            </>
          ) : (
            <>
              <a className="si-link upd-notes" href={latest.url} target="_blank" rel="noreferrer">What's new<ExternalIcon /></a>
              <p className="set-hint">{s.why}</p>
            </>
          )}
        </div>
      ) : !s.canUpdate && s.why ? <p className="set-hint">{s.why}</p> : null}
    </>
  );
}

// The switch shows the exact change to Claude Code's settings.json first; nothing is written until Apply.
function TerminalPane() {
  const hooks = useTerminal((x) => x.hooks);
  const preview = useTerminal((x) => x.preview);
  // The state the switch is asking for while its change waits for Apply.
  const [want, setWant] = useState<boolean | null>(null);
  const [st, setSt] = useState<{ saving: boolean; error: string | null; backup: string | null }>({ saving: false, error: null, backup: null });
  useEffect(() => {
    loadHooks();
    return dropPreview;
  }, []);
  const on = hooks?.installed ?? false;
  const shown = want !== null && preview?.on === want ? preview : null;
  const flip = () => {
    if (st.saving || want !== null) return;
    setSt({ saving: false, error: null, backup: null });
    if (previewHooks(!on)) setWant(!on);
    else setSt({ saving: false, error: 'Not connected to the server', backup: null });
  };
  const cancel = () => {
    setWant(null);
    dropPreview();
  };
  const apply = async () => {
    if (!shown || want === null) return;
    setSt({ saving: true, error: null, backup: null });
    const r = await setHooks(want, shown.base);
    setSt({ saving: false, ...r });
    if (!r.error) cancel();
  };
  return (
    <>
      <PaneHead id="terminal" desc="Follow claude sessions you run in a terminal, and answer their permission asks here." />
      <div className="set-card">
        {hooks ? (
          <Switch
            label="Connect terminal sessions" on={want ?? on} busy={st.saving || (want !== null && !shown)} disabled={!!hooks.error || st.saving}
            hint="Adds hooks to Claude Code's settings.json. An ask waits up to 2 minutes for you here; then the terminal asks as usual."
            onFlip={flip}
          />
        ) : <div className="set-skrow"><Sk w="52%" /><Sk w={34} h={20} /></div>}
        {hooks?.partial && want === null && <p className="set-hint">Some of the hooks are missing. Turn this off and on again to restore them.</p>}
        {hooks?.error && <p className="set-err" role="alert">{hooks.error}</p>}
        {shown && (
          <div className="tm-confirm" role="group" aria-label="Review the change">
            {shown.error ? <p className="set-err" role="alert">{shown.error}</p> : shown.diff ? (
              <>
                <p className="set-hint">{want ? 'This adds' : 'This removes'} these lines in <span className="mono">{shown.diff.path}</span>. A backup is saved next to it first.</p>
                <div className="frame dframe tm-diff">
                  <div className="fh">
                    <span className="mono add">+{shown.diff.add}</span>
                    <span className="mono rm">−{shown.diff.rm}</span>
                  </div>
                  <div className="diff mono">
                    {shown.diff.lines.map(([k, t], i) => (
                      <div key={i} className={k === '-' ? 'm' : k === '+' ? 'p' : 'c'}>{k === ' ' ? '  ' : `${k} `}{t}</div>
                    ))}
                    {shown.diff.more > 0 && <div className="c">  … {shown.diff.more} more lines</div>}
                  </div>
                </div>
              </>
            ) : <p className="set-hint">settings.json already matches. Nothing to write.</p>}
            <div className="set-row">
              {!shown.error && (
                <button type="button" className="set-btn" disabled={st.saving} aria-busy={st.saving} onClick={() => void apply()}>
                  {shown.diff ? (want ? 'Add hooks' : 'Remove hooks') : 'Done'}
                </button>
              )}
              <button type="button" className="set-clear" disabled={st.saving} onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}
        {st.backup && <p className="set-hint">Backup saved: <span className="mono">{st.backup}</span></p>}
      </div>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
    </>
  );
}

// The switch first lists the exact files and registry keys it touches; nothing is written until Apply.
function FolderMenuPane() {
  const menu = useFolderMenu((x) => x.menu);
  const home = useStore((x) => x.home);
  // The state the switch is asking for while its change waits for Apply.
  const [want, setWant] = useState<boolean | null>(null);
  const [st, setSt] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  useEffect(() => {
    loadFolderMenu();
  }, []);
  const on = menu?.installed ?? false;
  const flip = () => {
    if (st.saving || want !== null) return;
    setSt({ saving: false, error: null });
    setWant(!on);
  };
  const apply = async () => {
    if (want === null) return;
    setSt({ saving: true, error: null });
    const error = await setFolderMenu(want);
    setSt({ saving: false, error });
    if (!error) setWant(null);
  };
  return (
    <>
      <PaneHead id="folders" desc="Right-click a folder in your file manager to start a session there, or continue the last one." />
      <div className="set-card">
        {menu ? (
          <Switch
            label="Add to the folder menu" on={want ?? on} busy={st.saving} disabled={!menu.platform || !!menu.error || st.saving}
            hint={menu.platform
              ? `Adds “New tarcsweb session here” and “Continue last tarcsweb session here” to ${menu.where}.`
              : 'Not available on this desktop. It works in Dolphin, GNOME Files, Windows Explorer (with tarcsweb in WSL) and Finder.'}
            onFlip={flip}
          />
        ) : <div className="set-skrow"><Sk w="52%" /><Sk w={34} h={20} /></div>}
        {menu?.note && <p className="set-hint">{menu.note}</p>}
        {menu?.partial && want === null && <p className="set-hint">Some items are missing or out of date. Turn this off and on again to restore them.</p>}
        {menu?.error && <p className="set-err" role="alert">{menu.error}</p>}
        {want !== null && menu && (
          <div className="tm-confirm" role="group" aria-label="Review the change">
            <p className="set-hint">{want ? 'This creates:' : 'This removes, where tarcsweb made them:'}</p>
            <div className="frame dframe tm-diff">
              <div className="diff mono">
                {menu.entries.map((e) => <div key={e} className={want ? 'p' : 'm'}>{want ? '+ ' : '− '}{tilde(e, home)}</div>)}
              </div>
            </div>
            <div className="set-row">
              <button type="button" className="set-btn" disabled={st.saving} aria-busy={st.saving} onClick={() => void apply()}>
                {want ? 'Add items' : 'Remove items'}
              </button>
              <button type="button" className="set-clear" disabled={st.saving} onClick={() => setWant(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {st.error && <p className="set-err" role="alert">{st.error}</p>}
    </>
  );
}

function TourGroup({ label, list }: { label: string; list: Chapter[] }) {
  if (!list.length) return null;
  return (
    <div className="set-f">
      <div className="set-l"><span>{label}</span></div>
      <div className="set-card tour-list">
        {list.map((c, i) => (
          <button key={c.id} type="button" className="tour-row" onClick={() => playTour(list, i)}>
            <span className="tour-ri"><TourIcon /></span>
            <span className="tour-rt"><b>{c.title}</b><span>{c.blurb}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TourPane() {
  return (
    <>
      <PaneHead id="tour" desc="Short clips that show what you can do here." side={<button type="button" className="set-btn" onClick={() => playTour()}>Start tour</button>} />
      <TourGroup label="The essentials" list={ESSENTIALS} />
      <TourGroup label="More" list={READY.filter((c) => !c.essential)} />
    </>
  );
}

// Lays the dialog (centered at rect `to`) over rect `at` with one uniform scale, so its corners never stretch; `t` < 1 stops partway.
function over(to: DOMRect, at: DOMRect, t = 1) {
  const k = Math.max(at.width / to.width, at.height / to.height, 0.03);
  const dx = at.left + at.width / 2 - (to.left + to.width / 2);
  const dy = at.top + at.height / 2 - (to.top + to.height / 2);
  return `translate(${dx * t}px,${dy * t}px) scale(${1 + (k - 1) * t})`;
}
const liveRect = (el: Element | null) => {
  const r = el?.isConnected ? el.getBoundingClientRect() : null;
  return r && r.width ? r : null;
};

const OUT = 'cubic-bezier(.23,1,.32,1)';

// Grows out of the gear like the focus view and the Work sheet, and springs back into it.
// It starts halfway out with its content drawn and a fast ease-out, so the first frame already reads as the dialog.
function openFx(d: HTMLElement, origin: Element | null): Animation[] {
  const fade = (ms: number) => d.parentElement!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: OUT, pseudoElement: '::before' });
  if (reduceMotion()) return [d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease' }), fade(120)];
  const at = liveRect(origin);
  const to = d.getBoundingClientRect();
  const from = at ? over(to, at, 0.5) : 'translateY(6px) scale(.97)';
  return [d.animate([{ transform: from, opacity: 0.6 }, { opacity: 1, offset: 0.35 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: OUT }), fade(180)];
}

function closeFx(d: HTMLElement, origin: Element | null, running: Animation[]): Promise<unknown> {
  const wrap = d.firstElementChild!;
  // Start from wherever the opening is now, so an early Esc reverses smoothly.
  const cs = getComputedStyle(d);
  const now = { transform: cs.transform, opacity: cs.opacity };
  const layer = d.parentElement!;
  const bd = getComputedStyle(layer, '::before').opacity;
  const inner = getComputedStyle(wrap).opacity;
  for (const a of running) a.cancel();
  const at = liveRect(origin);
  const o: KeyframeAnimationOptions = { duration: SPRING.ms, easing: SPRING.easing, fill: 'forwards' };
  if (reduceMotion() || !at) {
    const q = { duration: 120, easing: 'ease', fill: 'forwards' } as const;
    layer.animate([{ opacity: bd }, { opacity: 0 }], { ...q, pseudoElement: '::before' });
    return d.animate([{ opacity: now.opacity }, { opacity: 0 }], q).finished;
  }
  const to = d.getBoundingClientRect();
  wrap.animate([{ opacity: inner }, { opacity: 0 }], { duration: 90, easing: FOSI, fill: 'forwards' });
  layer.animate([{ opacity: bd }, { opacity: 0 }], { ...o, pseudoElement: '::before' });
  return d.animate([{ transform: now.transform, opacity: 1 }, { opacity: 1, offset: 0.7 }, { transform: over(to, at), opacity: 0 }], o).finished;
}

export default function Settings({ origin, onClose }: { origin: RefObject<HTMLElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settings = useSetup((x) => x.settings);
  const status = useSetup((x) => x.status);
  const home = useStore((x) => x.home);
  const repo = useUpdate((x) => x.status?.repo ?? null);
  const hooks = useTerminal((x) => x.hooks);
  const [pane, setPaneState] = useState<PaneId>(lastPane);
  // The pane slides in only on a switch; on open it arrives with the dialog.
  const [switched, setSwitched] = useState(false);
  const anims = useRef<Animation[]>([]);
  const closing = useRef(false);
  const downOnBackdrop = useRef(false);
  const setPane = (p: PaneId) => {
    lastPane = p;
    setPaneState(p);
    setSwitched(true);
  };

  const requestClose = () => {
    const d = ref.current!;
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      if (d.parentElement!.contains(document.activeElement)) origin.current?.focus({ preventScroll: true });
      onClose();
    };
    closeFx(d, origin.current, anims.current).then(done, done);
  };

  // Layout effect: the dialog opens before the first paint instead of one frame after it.
  useLayoutEffect(() => {
    const d = ref.current!;
    // A top-layer popover, not showModal: a modal makes the page behind inert, which restyles the whole document first (~50 ms at 1x).
    d.parentElement!.showPopover();
    anims.current = openFx(d, origin.current);
    d.querySelector<HTMLElement>('.set-tab[aria-selected="true"]')?.focus({ preventScroll: true });
    loadSettings();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keeps the app's global keys (Esc stops a turn) away from the dialog.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      requestClose();
    } else if (e.key === 'Tab') trapTab(e);
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = PANES.findIndex((p) => p.id === pane);
    const next = PANES[(i + step + PANES.length) % PANES.length].id;
    setPane(next);
    tabsRef.current!.querySelector<HTMLElement>(`#set-tab-${next}`)?.focus();
  };

  const foot = pane === 'appearance'
    ? <span>Saved in this browser only</span>
    : pane === 'updates'
      ? repo ? <span>Releases from <a className="si-link" href={`https://github.com/${repo}/releases`} target="_blank" rel="noreferrer">github.com/{repo}</a></span> : <Sk w={240} h={12} />
    : pane === 'tour'
      ? <span>Arrow keys move between clips</span>
    : pane === 'terminal'
      ? hooks ? <span>Hooks live in <MidCut text={tilde(hooks.path, home)} className="mono" /></span> : <Sk w={260} h={12} />
    : pane === 'folders'
      ? <span>Needs tarcsweb running when you click</span>
    : pane === 'account'
      ? !status ? <Sk w={220} h={12} /> : <span>Shared with the claude CLI{status.cli?.version && <> · <span className="mono">claude {status.cli.version}</span></>}</span>
      : settings ? <span>Saved to <MidCut text={tilde(settings.path, home)} className="mono" /></span> : <Sk w={260} h={12} />;

  return (
    // A popover's ::backdrop lets clicks through, so this layer is the backdrop and its ::before the scrim.
    <div
      className="set-layer" popover="manual" onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
        // Keeps focus inside, so keys pressed while it closes stay away from the page.
        if (downOnBackdrop.current) e.preventDefault();
      }}
      onClick={(e) => e.target === e.currentTarget && downOnBackdrop.current && requestClose()}
    >
      {/* A click on plain text focuses the dialog, so keys never fall through to the page's global handlers. */}
      <div className="set" ref={ref} role="dialog" aria-modal="true" aria-labelledby="set-title" tabIndex={-1}>
        <div className="set-wrap">
          <nav className="set-nav" aria-label="Settings sections">
            <h1 id="set-title">Settings</h1>
            <div className="set-tabs" role="tablist" aria-orientation="vertical" ref={tabsRef} onKeyDown={onTabKey}>
              <span className="hl" aria-hidden="true"></span>
              {PANES.map(({ id, label, Icon }) => (
                <button
                  key={id} id={`set-tab-${id}`} type="button" role="tab" className="set-tab" aria-selected={id === pane} aria-controls="set-pane"
                  tabIndex={id === pane ? 0 : -1} onClick={() => setPane(id)}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </nav>
          <div className="set-main">
            <div className={switched ? 'set-pane in' : 'set-pane'} id="set-pane" role="tabpanel" aria-labelledby={`set-tab-${pane}`} key={pane}>
              {pane === 'appearance' && <AppearancePane />}
              {pane === 'account' && <AccountPane />}
              {pane === 'language' && <LanguagePane s={settings} />}
              {pane === 'sessions' && <NewSessionsPane s={settings} />}
              {pane === 'context' && <ContextPane s={settings} />}
              {pane === 'notifications' && <NotificationsPane s={settings} />}
              {pane === 'updates' && <UpdatesPane />}
              {pane === 'terminal' && <TerminalPane />}
              {pane === 'folders' && <FolderMenuPane />}
              {pane === 'tour' && <TourPane />}
            </div>
            <div className="set-foot">{foot}</div>
          </div>
          <button type="button" className="set-x" aria-label="Close" title="Close (esc)" onClick={requestClose}><XIcon /></button>
        </div>
      </div>
    </div>
  );
}
