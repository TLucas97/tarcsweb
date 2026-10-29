import { create } from 'zustand';
import type { DiffDetail, PastSession, ServerMessage, TerminalHooksView, TerminalSession } from '../../server/protocol.ts';
import { send } from './socket.ts';

// claude sessions running in a terminal (known through the hooks), and the Settings switch that installs those hooks.
type Preview = { on: boolean; diff: DiffDetail | null; base: string; error: string | null };
type Terminal = { sessions: TerminalSession[]; hooks: TerminalHooksView | null; preview: Preview | null };
export const useTerminal = create<Terminal>(() => ({ sessions: [], hooks: null, preview: null }));

// The saved title when the transcript list has one, else what the hook knew, else the folder.
export const terminalName = (t: TerminalSession, past: PastSession[]) =>
  past.find((p) => p.id === t.id)?.name ?? t.name ?? (t.cwd.split('/').filter(Boolean).pop() || 'home');

// Open asks across terminal sessions, oldest first.
export const terminalAsks = (sessions: TerminalSession[]) =>
  sessions.flatMap((s) => s.asks.map((ask) => ({ session: s, ask }))).sort((a, b) => a.ask.at - b.ask.at);

export type TerminalMessage =Extract<ServerMessage, { type: 'terminal' | 'terminal-hooks' | 'terminal-hooks-preview' }>;
type SetReply = { error: string | null; backup: string | null };
const waiting = new Map<string, (r: SetReply) => void>();
let seq = 0;

export function applyTerminal(msg: TerminalMessage) {
  if (msg.type === 'terminal') return useTerminal.setState({ sessions: msg.sessions });
  if (msg.type === 'terminal-hooks-preview') {
    const { type: _t, ...preview } = msg;
    return useTerminal.setState({ preview });
  }
  useTerminal.setState({ hooks: msg.hooks });
  if (msg.reply) {
    waiting.get(msg.reply.req)?.(msg.reply);
    waiting.delete(msg.reply.req);
  }
}

export const loadHooks = () => send({ type: 'terminal-hooks-load' });

export function previewHooks(on: boolean) {
  useTerminal.setState({ preview: null });
  return send({ type: 'terminal-hooks-preview', on });
}

export const dropPreview = () => useTerminal.setState({ preview: null });

// Resolves with the server's error (null once written) and the backup it made.
export function setHooks(on: boolean, base: string): Promise<SetReply> {
  const req = `t${++seq}`;
  if (!send({ type: 'terminal-hooks-set', on, base, req })) return Promise.resolve({ error: 'Not connected to the server', backup: null });
  return new Promise((done) => {
    const timer = setTimeout(() => {
      waiting.delete(req);
      done({ error: 'The server did not answer', backup: null });
    }, 8000);
    waiting.set(req, (r) => {
      clearTimeout(timer);
      done(r);
    });
  });
}
