import { useState, type ReactNode } from 'react';
import type { BrowserClaudeSetup, BrowserClientMessage } from '../../../server/protocol.ts';
import { Check, XIcon } from '../bits.tsx';

const EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const STORE_URL = `https://chromewebstore.google.com/detail/claude/${EXT}`;
const SIGNIN_URL = `chrome-extension://${EXT}/sidepanel.html`;
// The step the owner dismissed the card at; it comes back once the setup moves to another step.
const DISMISS_KEY = 'cw-brw-claude-setup';

export type SetupStep = 'extension' | 'host' | 'signin';

export const setupStep = (c: BrowserClaudeSetup): SetupStep | null => (!c.extension ? 'extension' : !c.host ? 'host' : !c.signedIn ? 'signin' : null);

export function dismissedStep() {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function dismissStep(step: SetupStep | null) {
  try {
    if (step) localStorage.setItem(DISMISS_KEY, step);
    else localStorage.removeItem(DISMISS_KEY);
  } catch {}
}

type Props = {
  c: BrowserClaudeSetup; step: SetupStep; live: boolean; windowOpen: boolean; windowError: string | null;
  send: (m: BrowserClientMessage) => void; onDismiss: () => void;
};

type Action = { label: string; run: () => void; window?: boolean };

export function ClaudeSetup({ c, step, live, windowOpen, windowError, send, onDismiss }: Props) {
  // The checked stamp seen when Check again was pressed; a new one means the answer came.
  const [asked, setAsked] = useState<number | null>(null);
  const checking = asked === c.checked;
  const open = (url: string) => send({ type: 'tab-open', url });
  // Chrome's own dialogs (Add extension, the sign-in page) never reach the panel, so these steps use a real window.
  const desk: Action | null = c.desktop ? { label: windowOpen ? 'Window open' : 'Open setup window', run: () => send({ type: 'setup-window', open: true }), window: true } : null;
  const hint = desk ? "A Chrome window opens on your desktop with this browser's profile. Close it when you're done." : null;
  const steps: { key: string; done: boolean; title: string; body: ReactNode; hint?: string | null; action: Action | null }[] = [
    {
      key: 'extension', done: c.extension, title: 'Add the Claude extension',
      body: desk ? 'Add it from the Chrome Web Store, in the setup window.' : 'Add it from the Chrome Web Store, in this browser.',
      hint, action: desk ?? { label: 'Open Web Store', run: () => open(STORE_URL) },
    },
    {
      key: 'host', done: c.host, title: 'Connect Claude Code',
      body: c.flatpak ? (
        <>This browser is Flatpak Chrome, which <code className="mono">/chrome</code> does not set up. Install Google Chrome from your distribution, set <code className="mono">browser.bin</code> to it in the config, run <code className="mono">/chrome</code> once in Claude Code, then restart the app.</>
      ) : (
        <>Run <code className="mono">/chrome</code> once in Claude Code in a terminal, then check again.</>
      ),
      action: null,
    },
    {
      key: 'signin', done: c.signedIn, title: 'Sign in',
      body: !c.extension ? 'Once the extension is added, sign in to Claude there.' : desk ? 'Sign in to Claude in the extension, in the setup window.' : 'Sign in to Claude in the extension, in this browser.',
      hint: c.extension ? hint : null,
      action: !c.extension ? null : desk ?? { label: 'Open sign-in', run: () => open(SIGNIN_URL) },
    },
    {
      key: 'select', done: false, title: 'Pick this browser',
      body: 'The first time, ask your agent to select the Browser panel in Claude in Chrome. Claude Code keeps that choice for all its sessions, terminal ones too.',
      action: null,
    },
  ];

  return (
    <section className="brw-setup" aria-label="Set up Claude in Chrome">
      <div className="brw-setup-head">
        <b>Set up Claude in Chrome here</b>
        <button type="button" className="brw-x" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><XIcon /></button>
      </div>
      <p>Agents can then use Claude in Chrome in this browser. Playwright and DevTools work without it.</p>
      <ol>
        {steps.map((s, i) => {
          const now = s.key === step;
          return (
            <li key={s.key} className={now ? 'now' : s.done ? 'done' : ''} aria-current={now ? 'step' : undefined}>
              <i role={s.done ? 'img' : undefined} aria-label={s.done ? 'Done' : undefined}>{s.done ? <Check /> : i + 1}</i>
              <b>{s.title}</b>
              {!s.done && <span>{s.body}</span>}
              {!s.done && now && s.hint && <span>{s.hint}</span>}
              {!s.done && s.action && (s.action.window ? (
                <button type="button" className={now ? 'set-btn' : 'brw-link'} disabled={windowOpen} onClick={s.action.run}>{s.action.label}</button>
              ) : (
                <button type="button" className={now ? 'set-btn' : 'brw-link'} disabled={!live} title={live ? undefined : 'Start the browser first'} onClick={s.action.run}>
                  {s.action.label}
                </button>
              ))}
            </li>
          );
        })}
      </ol>
      {windowError && !windowOpen && <p className="brw-setup-err" role="alert">{windowError}</p>}
      <div className="brw-setup-foot">
        <button
          type="button" className="brw-link" aria-busy={checking}
          onClick={() => {
            setAsked(c.checked);
            send({ type: 'claude-check' });
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </section>
  );
}
