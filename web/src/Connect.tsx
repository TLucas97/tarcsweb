import type { ReactNode } from 'react';
import { Check, CopyBtn } from './bits.tsx';
import { CODEX_INSTALL, CodexSignIn, SignInFlow } from './Account.tsx';
import { checkAgain, checkCodex, useSetup } from './setup.ts';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

function Cmd({ text }: { text: string }) {
  return (
    <div className="cn-cmd">
      <code className="mono">{text}</code>
      <CopyBtn text={text} what="command" />
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="cn-step" data-done={done}>
      <span className="cn-n" aria-hidden="true">{done ? <Check /> : n}</span>
      <div className="cn-b">
        <b>{title}</b>
        {children}
      </div>
    </li>
  );
}

// Shown instead of the app while no session could start: what each agent is missing and the command that fixes it.
export default function Connect() {
  const status = useSetup((s) => s.status)!;
  const codex = useSetup((s) => s.codex);
  const checking = useSetup((s) => s.checking || s.codexChecking);
  const cli = status.cli;
  const error = status.error ?? codex?.error;
  const recheck = () => {
    checkAgain();
    checkCodex();
  };
  return (
    <main className="cn" aria-labelledby="cn-h">
      <div className="cn-col">
        <header>
          <h1 id="cn-h">Connect an account</h1>
          <p className="cn-sub">tarcsweb runs on Claude Code or Codex, with the account you sign in to there. Connect either one to start.</p>
        </header>

        <section className="cn-sec" aria-labelledby="cn-claude">
          <h2 id="cn-claude">Claude</h2>
          <ol className="cn-steps">
            <Step n={1} done={!!cli} title="Install the claude CLI">
              {cli
                ? <small>Installed{cli.version ? ` · ${cli.version}` : ''}</small>
                : <><small>Run this in a terminal, then check again.</small><Cmd text={INSTALL} /></>}
            </Step>
            <Step n={2} done={status.loggedIn} title="Sign in">
              {status.loggedIn
                ? <small>Signed in</small>
                : <><small>Opens your browser to sign in with your Claude account.</small><SignInFlow /></>}
            </Step>
          </ol>
        </section>

        <section className="cn-sec" aria-labelledby="cn-codex">
          <h2 id="cn-codex">Codex</h2>
          <ol className="cn-steps">
            <Step n={1} done={!!codex?.installed} title="Install the codex CLI">
              {!codex
                ? <small>Checking…</small>
                : codex.installed
                  ? <small>Installed{codex.version ? ` · ${codex.version}` : ''}</small>
                  : <><small>Run this in a terminal, then check again.</small><Cmd text={CODEX_INSTALL} /></>}
            </Step>
            <Step n={2} done={!!codex?.signedIn} title="Sign in">
              {codex?.signedIn
                ? <small>Signed in</small>
                : codex?.installed
                  ? <><small>Opens your browser to sign in with your ChatGPT account.</small><CodexSignIn /></>
                  : <small>Install the codex CLI first.</small>}
            </Step>
          </ol>
        </section>

        <div className="cn-acts">
          <button type="button" className="set-clear cn-check" onClick={recheck} disabled={checking} aria-busy={checking}>
            {checking && <span className="g spin"></span>}
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {error && <span className="set-err" role="status">Couldn't check: {error}</span>}
        </div>
      </div>
    </main>
  );
}
