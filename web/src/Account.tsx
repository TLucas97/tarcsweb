import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ConnectStatus } from '../../server/protocol.ts';
import { cancelLogin, logout, sendLoginCode, startLogin, useSetup } from './setup.ts';

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

// The signed-in account, with a sign-out that asks first in place.
export function SignedIn({ status }: { status: ConnectStatus }) {
  const { state, error } = useSetup((s) => s.login);
  const [confirm, setConfirm] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = state === 'signing-out';
  // The asking button is replaced, so focus moves to the safe answer.
  useEffect(() => {
    if (confirm) cancelRef.current?.focus();
  }, [confirm]);
  return (
    <div className="acct">
      <div className="acct-row">
        <div className="acct-who">
          <span className="acct-email" title={status.email ?? undefined}>{status.email ?? 'Signed in'}</span>
          {status.plan && <span className="acct-plan">{status.plan}</span>}
        </div>
        {!confirm && (
          <button type="button" className="set-clear" onClick={() => setConfirm(true)} disabled={busy} aria-busy={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        )}
      </div>
      {confirm && (
        <div className="acct-ask" role="group" aria-label="Sign out">
          <div className="acct-q">
            <span>Sign out of Claude on this computer?</span>
            <small>This also signs out the claude CLI.</small>
          </div>
          {/* Cancel sits where Sign out was, so a double click does not confirm. */}
          <button type="button" className="set-btn danger" onClick={() => { setConfirm(false); logout(); }}>Sign out</button>
          <button type="button" className="set-clear" ref={cancelRef} onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
      {error && state === 'idle' && <p className="set-err" role="alert">{error}</p>}
    </div>
  );
}
