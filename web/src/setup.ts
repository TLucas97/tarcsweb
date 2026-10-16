import { create } from 'zustand';
import { send } from './socket.ts';
import type { ConnectStatus, LoginState, ServerMessage, SettingsPatch, SettingsView } from '../../server/protocol.ts';

type Setup = { status: ConnectStatus | null; checking: boolean; login: LoginState; settings: SettingsView | null };
const IDLE: LoginState = { state: 'idle', url: null, error: null };
export const useSetup = create<Setup>(() => ({ status: null, checking: false, login: IDLE, settings: null }));

// Ready when the CLI is signed in; unknown until the first status arrives.
export const isReady = (s: ConnectStatus | null) => !s || s.loggedIn;

const waiting = new Map<string, (error: string | null) => void>();
let seq = 0;

export function applySetup(msg: Extract<ServerMessage, { type: 'connect-status' | 'settings' | 'login' }>) {
  if (msg.type === 'connect-status') return useSetup.setState({ status: msg.status, checking: false });
  if (msg.type === 'login') return useSetup.setState({ login: msg.login });
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
export const resetLogin = () => useSetup.setState({ login: IDLE });

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
