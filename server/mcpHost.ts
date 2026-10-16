import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonTransport, type RpcMessage } from './mcpHttp.ts';

// The app's tools served over HTTP to Codex threads. Each tab gets a bearer token (kept only hashed) that maps every call back to it.
export const TOOL_SERVERS = ['app', 'visual', 'replay', 'agents-panel'];
// Above the longest blocking tool: ask_round waits for the user. Interrupts and closing the tab end it sooner.
const TOOL_TIMEOUT_SEC = 24 * 3600;
const BODY_MAX = 16 << 20;
// Codex opens one MCP session per server per thread start or resume.
const SESSIONS_MAX = 16;

type Server = { connect: (t: JsonTransport) => Promise<void>; close: () => Promise<void> };
// A fresh server instance per MCP session; null for a name this tab does not serve.
export type ServerFactory = (name: string) => Server | null;
type Live = { name: string; t: JsonTransport; s: Server };
type Grant = { make: ServerFactory; sessions: Map<string, Live> };
export type ToolGrant = { config: Record<string, unknown>; revoke: () => void };

const grants = new Map<string, Grant>();
let base = '';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function setToolBase(port: number) {
  base = `http://127.0.0.1:${port}/mcp`;
}

function drop(g: Grant, sid: string) {
  const live = g.sessions.get(sid);
  if (!live) return;
  g.sessions.delete(sid);
  void live.s.close().catch(() => {});
}

// The thread config entries for Codex (one dotted key per server, so the user's own mcp_servers stay) and the revoke switch.
export function grantTools(make: ServerFactory): ToolGrant {
  const token = randomBytes(32).toString('base64url');
  const key = hash(token);
  const g: Grant = { make, sessions: new Map() };
  grants.set(key, g);
  const config = Object.fromEntries(TOOL_SERVERS.map((name) => [`mcp_servers.${name}`, {
    url: `${base}/${name}`, http_headers: { Authorization: `Bearer ${token}` }, tool_timeout_sec: TOOL_TIMEOUT_SEC, default_tools_approval_mode: 'approve',
  }]));
  return {
    config,
    revoke: () => {
      grants.delete(key);
      for (const sid of [...g.sessions.keys()]) drop(g, sid);
    },
  };
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((done, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > BODY_MAX) {
        fail(new Error('too large'));
        req.destroy();
      } else parts.push(b);
    });
    req.on('end', () => done(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

// Always true: the request was ours, answered or not.
const reply = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  if (res.headersSent || res.destroyed) return true;
  if (body === undefined) res.writeHead(status, headers).end();
  else res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  return true;
};
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

// Handles /mcp/<server>; false for any other path.
export async function serveTools(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const name = /^\/mcp\/([\w-]+)$/.exec((req.url ?? '').split('?')[0])?.[1];
  if (!name) return false;
  const auth = req.headers.authorization ?? '';
  const g = auth.startsWith('Bearer ') ? grants.get(hash(auth.slice(7).trim())) : undefined;
  if (!g) return reply(res, 401, rpcError(-32001, 'Unauthorized'));
  if (!TOOL_SERVERS.includes(name)) return reply(res, 404, rpcError(-32601, `No server ${name}`));
  const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
  if (req.method === 'DELETE') {
    if (g.sessions.get(sid)?.name === name) drop(g, sid);
    return reply(res, 200);
  }
  // No server-to-client stream: everything this server says answers a POST.
  if (req.method !== 'POST') return reply(res, 405, undefined, { allow: 'POST, DELETE' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return reply(res, 400, rpcError(-32700, 'Parse error'));
  }
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[];
  if (!messages.length || messages.some((m) => !m || typeof m !== 'object')) return reply(res, 400, rpcError(-32600, 'Invalid request'));

  let live: Live | undefined;
  if (messages.some((m) => m.method === 'initialize')) {
    const s = g.make(name);
    if (!s) return reply(res, 404, rpcError(-32601, `No server ${name}`));
    const t = new JsonTransport();
    await s.connect(t);
    live = { name, t, s };
    g.sessions.set(t.sessionId, live);
    if (g.sessions.size > SESSIONS_MAX) drop(g, g.sessions.keys().next().value!);
  } else {
    live = g.sessions.get(sid);
    // 404 tells the client to initialize again (a restarted server forgot its sessions).
    if (!live || live.name !== name) return reply(res, 404, rpcError(-32001, 'Session not found'));
  }

  let out: RpcMessage[];
  try {
    out = await live.t.post(messages, res);
  } catch (e) {
    return reply(res, 404, rpcError(-32001, e instanceof Error ? e.message : String(e)));
  }
  const headers = { 'mcp-session-id': live.t.sessionId };
  if (!out.length) return reply(res, 202, undefined, headers);
  return reply(res, 200, Array.isArray(parsed) ? out : out[0], headers);
}
