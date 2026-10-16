import { Check, CopyBtn } from './bits.tsx';
import { SignInFlow } from './Account.tsx';
import { checkAgain, useSetup } from './setup.ts';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

function Cmd({ text }: { text: string }) {
  return (
    <div className="cn-cmd">
      <code className="mono">{text}</code>
      <CopyBtn text={text} what="command" />
    </div>
  );
}

// Shown instead of the app while no session could start: what is missing and the command that fixes it.
export default function Connect() {
  const status = useSetup((s) => s.status)!;
  const checking = useSetup((s) => s.checking);
  const cli = status.cli;
  return (
    <main className="cn" aria-labelledby="cn-h">
      <div className="cn-col">
        <header>
          <h1 id="cn-h">Connect your Claude account</h1>
          <p className="cn-sub">tarcsweb runs on the claude command-line tool, with the account you sign in to there.</p>
        </header>

        <ol className="cn-steps">
          <li className="cn-step" data-done={!!cli}>
            <span className="cn-n" aria-hidden="true">{cli ? <Check /> : 1}</span>
            <div className="cn-b">
              <b>Install the claude CLI</b>
              {cli
                ? <small>Installed{cli.version ? ` · ${cli.version}` : ''}</small>
                : <><small>Run this in a terminal, then check again.</small><Cmd text={INSTALL} /></>}
            </div>
          </li>
          <li className="cn-step" data-done={status.loggedIn}>
            <span className="cn-n" aria-hidden="true">{status.loggedIn ? <Check /> : 2}</span>
            <div className="cn-b">
              <b>Sign in</b>
              {status.loggedIn
                ? <small>Signed in</small>
                : <><small>Opens your browser to sign in with your Claude account.</small><SignInFlow /></>}
            </div>
          </li>
        </ol>

        <div className="cn-acts">
          <button type="button" className="set-clear cn-check" onClick={checkAgain} disabled={checking} aria-busy={checking}>
            {checking && <span className="g spin"></span>}
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {status.error && <span className="set-err" role="status">Couldn't check: {status.error}</span>}
        </div>
      </div>
    </main>
  );
}
