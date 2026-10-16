import { create } from 'zustand';
import { send } from './socket.ts';
import type { CodexLoginFlow, CodexLoginState, CodexModel, CodexStatus, ConnectStatus, LoginState, ServerMessage, SettingsPatch, SettingsView } from '../../server/protocol.ts';

type Setup = {
  status: ConnectStatus | null; checking: boolean; login: LoginState; settings: SettingsView | null;
  codex: CodexStatus | null; codexChecking: boolean; codexLogin: CodexLoginState; codexModels: CodexModel[] | null; codexModelsError: string | null;
};
const IDLE: LoginState = { state: 'idle', url: null, error: null };
const CODEX_IDLE: CodexLoginState = { state: 'idle', flow: null, url: null, code: null, error: null };
export const useSetup = create<Setup>(() => ({
  status: null, checking: false, login: IDLE, settings: null, codex: null, codexChecking: false, codexLogin: CODEX_IDLE, codexModels: null, codexModelsError: null,
}));

// Ready when the CLI is signed in; unknown until the first status arrives.
export const isReady = (s: ConnectStatus | null) => !s || s.loggedIn;

const waiting = new Map<string, (error: string | null) => void>();
let seq = 0;

export type SetupMessage = Extract<ServerMessage, { type: 'connect-status' | 'settings' | 'login' | 'codex-status' | 'codex-login' | 'codex-models' }>;

export function applySetup(msg: SetupMessage) {
  if (msg.type === 'connect-status') return useSetup.setState({ status: msg.status, checking: false });
  if (msg.type === 'login') return useSetup.setState({ login: msg.login });
  if (msg.type === 'codex-status') {
    // A sign-in or sign-out changes the catalog, so the model menu asks again.
    const moved = useSetup.getState().codex?.signedIn !== msg.status.signedIn;
    return useSetup.setState({ codex: msg.status, codexChecking: false, ...(moved ? { codexModels: null, codexModelsError: null } : {}) });
  }
  if (msg.type === 'codex-login') return codexLoginMoved(msg.login);
  if (msg.type === 'codex-models') return useSetup.setState({ codexModels: msg.error ? null : msg.models, codexModelsError: msg.error });
  useSetup.setState({ settings: msg.settings });
  if (msg.reply) {
    waiting.get(msg.reply.id)?.(msg.reply.error);
    waiting.delete(msg.reply.id);
  }
}

export function checkAgain() {
  if (send({ type: 'connect-check' })) useSetup.setState({ checking: true });
}

// The server owns the flow and echoes every step; these only show the first step at once.
export function startLogin() {
  if (send({ type: 'login-start' })) useSetup.setState({ login: { state: 'starting', url: null, error: null } });
}
export const sendLoginCode = (code: string) => send({ type: 'login-code', code });
export const cancelLogin = () => send({ type: 'login-cancel' });
export function logout() {
  if (send({ type: 'logout' })) useSetup.setState({ login: { state: 'signing-out', url: null, error: null } });
}
// Called when the socket drops; on reconnect the server re-sends a flow that is still running.
export const resetLogin = () => useSetup.setState({ login: IDLE, codexLogin: CODEX_IDLE });

export function checkCodex() {
  if (send({ type: 'codex-check' })) useSetup.setState({ codexChecking: true });
}
export const loadCodexModels = () => send({ type: 'codex-models' });

// Only the window that clicked opens the sign-in page, and only once.
let openCodexPage = false;
export function startCodexLogin(flow: CodexLoginFlow) {
  if (!send({ type: 'codex-login-start', flow })) return;
  openCodexPage = flow === 'browser';
  useSetup.setState({ codexLogin: { ...CODEX_IDLE, state: 'starting', flow } });
}
export const cancelCodexLogin = () => send({ type: 'codex-login-cancel' });
export function codexLogout() {
  if (send({ type: 'codex-logout' })) useSetup.setState({ codexLogin: { ...CODEX_IDLE, state: 'signing-out' } });
}

function codexLoginMoved(login: CodexLoginState) {
  useSetup.setState({ codexLogin: login });
  if (login.state === 'idle') openCodexPage = false;
  if (!openCodexPage || login.state !== 'waiting' || !login.url) return;
  openCodexPage = false;
  // Still inside the click's activation window in most cases; the card keeps a link for when it is blocked.
  window.open(login.url, '_blank', 'noopener');
}

export const loadSettings = () => send({ type: 'settings-load' });

// Resolves with the server's error, or null once the file is written.
export function saveSettings(patch: SettingsPatch): Promise<string | null> {
  const id = `s${++seq}`;
  if (!send({ type: 'settings-set', id, patch })) return Promise.resolve('Not connected to the server');
  return new Promise((done) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      done('The server did not answer');
    }, 8000);
    waiting.set(id, (error) => {
      clearTimeout(timer);
      done(error);
    });
  });
}
