import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CodexLimitWindow, CodexStatus, ConnectStatus } from '../../server/protocol.ts';
import { CopyBtn } from './bits.tsx';
import { cancelCodexLogin, cancelLogin, checkCodex, codexLogout, logout, sendLoginCode, startCodexLogin, startLogin, useSetup } from './setup.ts';

export const ExternalIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9" /></svg>
);

// The browser half of `claude auth login`: the CLI opens the page, the user pastes back the code it shows.
function CodeForm({ url, error, verifying }: { url: string | null; error: string | null; verifying: boolean }) {
  const id = useId();
  const [code, setCode] = useState('');
  const [empty, setEmpty] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (verifying) return;
    if (!code.trim()) return setEmpty(true);
    sendLoginCode(code.trim());
  };
  const msg = empty ? 'Paste the code first' : error;
  return (
    <div className="si">
      <div className="si-head">
        <b>Finish signing in in your browser</b>
        <button type="button" className="set-clear" onClick={cancelLogin}>Cancel</button>
      </div>
      {url && (
        <p className="set-hint">
          Browser didn't open? <a className="si-link" href={url} target="_blank" rel="noreferrer">Open sign-in page<ExternalIcon /></a>
        </p>
      )}
      <form className="si-form" onSubmit={submit} noValidate>
        <label htmlFor={id}>Paste the code shown after signing in</label>
        <div className="set-row">
          <input
            id={id} className="set-in mono" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus value={code} readOnly={verifying}
            aria-invalid={!!msg} aria-describedby={msg ? `${id}-msg` : undefined} onChange={(e) => { setCode(e.target.value); setEmpty(false); }}
          />
          <button type="submit" className="set-btn" disabled={verifying} aria-busy={verifying}>
            {verifying && <span className="g spin"></span>}
            {verifying ? 'Checking…' : 'Continue'}
          </button>
        </div>
        {msg && <p id={`${id}-msg`} className="set-err" role="alert">{msg}</p>}
      </form>
    </div>
  );
}

// Sign in from the app; the server runs the CLI and every open window follows along.
export function SignInFlow() {
  const { state, url, error } = useSetup((s) => s.login);
  if (state === 'waiting' || state === 'verifying') return <CodeForm url={url} error={error} verifying={state === 'verifying'} />;
  const starting = state === 'starting';
  return (
    <div className="si">
      <div className="si-acts">
        <button type="button" className="set-btn" onClick={startLogin} disabled={state !== 'idle'} aria-busy={starting}>
          {starting && <span className="g spin"></span>}
          {starting ? 'Opening sign-in…' : 'Sign in with Claude'}
        </button>
        {starting && <button type="button" className="set-clear" onClick={cancelLogin}>Cancel</button>}
      </div>
      {error && state === 'idle' && <p className="set-err" role="alert">{error}</p>}
    </div>
  );
}

export function SignedIn({ status }: { status: ConnectStatus }) {
  const { state, error } = useSetup((s) => s.login);
  return (
    <AccountCard
      email={status.email} plan={status.plan} busy={state === 'signing-out'} error={state === 'idle' ? error : null}
      product="Claude" cli="claude" onSignOut={logout}
    />
  );
}

type CardProps = {
  email: string | null; plan: string | null; busy: boolean; error: string | null;
  product: string; cli: string; onSignOut: () => void; children?: ReactNode;
};

// A signed-in account, with a sign-out that asks first in place.
function AccountCard({ email, plan, busy, error, product, cli, onSignOut, children }: CardProps) {
  const [confirm, setConfirm] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The asking button is replaced, so focus moves to the safe answer.
  useEffect(() => {
    if (confirm) cancelRef.current?.focus();
  }, [confirm]);
  return (
    <div className="acct">
      <div className="acct-row">
        <div className="acct-who">
          <span className="acct-email" title={email ?? undefined}>{email ?? 'Signed in'}</span>
          {plan && <span className="acct-plan">{plan}</span>}
        </div>
        {!confirm && (
          <button type="button" className="set-clear" onClick={() => setConfirm(true)} disabled={busy} aria-busy={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        )}
      </div>
      {children}
      {confirm && (
        <div className="acct-ask" role="group" aria-label="Sign out">
          <div className="acct-q">
            <span>Sign out of {product} on this computer?</span>
            <small>This also signs out the {cli} CLI.</small>
          </div>
          {/* Cancel sits where Sign out was, so a double click does not confirm. */}
          <button type="button" className="set-btn danger" onClick={() => { setConfirm(false); onSignOut(); }}>Sign out</button>
          <button type="button" className="set-clear" ref={cancelRef} onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="set-err" role="alert">{error}</p>}
    </div>
  );
}

const CODEX_INSTALL = 'npm install -g @openai/codex';

// Codex signs in through its app-server: a browser page whose callback lands on this machine, or a one-time code for remote ones.
function CodexSignIn() {
  const { state, flow, url, code, error } = useSetup((s) => s.codexLogin);
  if (state === 'waiting' && flow === 'device' && url && code) {
    return (
      <div className="si">
        <div className="si-head">
          <b>Enter this code on the sign-in page</b>
          <button type="button" className="set-clear" onClick={cancelCodexLogin}>Cancel</button>
        </div>
        <div className="set-topic acct-cmd">
          <code className="mono">{code}</code>
          <CopyBtn text={code} what="code" />
        </div>
        <a className="si-link" href={url} target="_blank" rel="noreferrer">Open sign-in page<ExternalIcon /></a>
      </div>
    );
  }
  if (state === 'waiting') {
    return (
      <div className="si">
        <div className="si-head">
          <b>Finish signing in in your browser</b>
          <button type="button" className="set-clear" onClick={cancelCodexLogin}>Cancel</button>
        </div>
        {url && (
          <p className="set-hint">
            Browser didn't open? <a className="si-link" href={url} target="_blank" rel="noreferrer">Open sign-in page<ExternalIcon /></a>
          </p>
        )}
      </div>
    );
  }
  const starting = state === 'starting';
  return (
    <div className="si">
      <div className="si-acts">
        <button type="button" className="set-btn" onClick={() => startCodexLogin('browser')} disabled={state !== 'idle'} aria-busy={starting}>
          {starting && <span className="g spin"></span>}
          {starting ? (flow === 'device' ? 'Getting a code…' : 'Opening sign-in…') : 'Sign in with ChatGPT'}
        </button>
        {starting
          ? <button type="button" className="set-clear" onClick={cancelCodexLogin}>Cancel</button>
          : <button type="button" className="set-clear" onClick={() => startCodexLogin('device')} disabled={state !== 'idle'}>Use a code instead</button>}
      </div>
      <p className="set-hint">Use a code when tarcsweb runs on another computer: you sign in from any browser.</p>
      {error && state === 'idle' && <p className="set-err" role="alert">{error}</p>}
    </div>
  );
}

const windowName = (mins: number | null) =>
  mins === null ? 'Usage' : mins >= 10_080 ? 'Weekly' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
const RESET = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;

function LimitLine({ w }: { w: CodexLimitWindow }) {
  return (
    <p className="set-hint">
      {windowName(w.windowMins)} limit: {Math.round(w.usedPercent)}% used{w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString(undefined, RESET)}` : ''}
    </p>
  );
}

// The Codex half of the Account pane, from the status the server read through `account/read`.
export function CodexAccount({ status }: { status: CodexStatus }) {
  const checking = useSetup((s) => s.codexChecking);
  const login = useSetup((s) => s.codexLogin);
  const recheck = (
    <button type="button" className="set-clear" onClick={checkCodex} disabled={checking} aria-busy={checking}>{checking ? 'Checking…' : 'Check again'}</button>
  );
  if (!status.installed) {
    return (
      <>
        <div className="set-acct">
          <span className="set-state">Not installed</span>
          {recheck}
        </div>
        <p className="set-hint">Install the codex CLI in a terminal, then check again.</p>
        <div className="set-topic acct-cmd">
          <code className="mono">{CODEX_INSTALL}</code>
          <CopyBtn text={CODEX_INSTALL} what="command" />
        </div>
      </>
    );
  }
  const warn = !status.versionOk && (
    <p className="set-hint" role="status">
      codex-cli {status.version ?? '(unknown version)'} is untested here. tarcsweb is built for {status.testedVersion}.x, so some features may not work.
    </p>
  );
  if (status.signedIn) {
    const l = status.limits;
    return (
      <>
        <AccountCard
          email={status.email} plan={status.plan} busy={login.state === 'signing-out'} error={login.state === 'idle' ? login.error : null}
          product="Codex" cli="codex" onSignOut={codexLogout}
        >
          {l?.primary && <LimitLine w={l.primary} />}
          {l?.secondary && <LimitLine w={l.secondary} />}
        </AccountCard>
        {warn}
      </>
    );
  }
  return (
    <>
      <div className="set-acct">
        <span className="set-state">Not signed in</span>
        {recheck}
      </div>
      <CodexSignIn />
      {warn}
      {status.error && <p className="set-err" role="status">Couldn't check: {status.error}</p>}
    </>
  );
}
