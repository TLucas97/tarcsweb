import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// The app's tools served over HTTP to Codex threads. Each tab gets a bearer token (kept only hashed) that maps every call back to it.
export const TOOL_SERVERS = ['app', 'visual', 'replay', 'agents-panel'];
// Above the longest blocking tool: ask_round waits for the user. Interrupts and closing the tab end it sooner.
const TOOL_TIMEOUT_SEC = 24 * 3600;
const BODY_MAX = 16 << 20;
// Codex opens one MCP session per server per thread start or resume.
const SESSIONS_MAX = 16;

type Server = { connect: (t: Transport) => Promise<void>; close: () => Promise<void> };
// A fresh server instance per MCP session; null for a name this tab does not serve.
export type ServerFactory = (name: string) => Server | null;
type Live = { name: string; t: StreamableHTTPServerTransport; s: Server };
type Grant = { make: ServerFactory; sessions: Map<string, Live>; names: string[] };
export type ToolGrant = { config: Record<string, unknown>; revoke: () => void };
type RpcId = string | number;
type RpcMessage = { jsonrpc: '2.0'; id?: RpcId | null; method?: string };

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
export function grantTools(make: ServerFactory, names = TOOL_SERVERS): ToolGrant {
  const token = randomBytes(32).toString('base64url');
  const key = hash(token);
  const g: Grant = { make, sessions: new Map(), names };
  grants.set(key, g);
  const config = Object.fromEntries(names.map((name) => [`mcp_servers.${name}`, {
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

function open(g: Grant, name: string, s: Server): Live {
  const live: Live = {
    name, s,
    // JSON answers only: everything this server says answers a POST.
    t: new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        g.sessions.set(sid, live);
        if (g.sessions.size > SESSIONS_MAX) drop(g, g.sessions.keys().next().value!);
      },
      onsessionclosed: (sid) => drop(g, sid),
    }),
  };
  return live;
}

// Handles /mcp/<server>; false for any other path.
export async function serveTools(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const name = /^\/mcp\/([\w-]+)$/.exec((req.url ?? '').split('?')[0])?.[1];
  if (!name) return false;
  const auth = req.headers.authorization ?? '';
  const g = auth.startsWith('Bearer ') ? grants.get(hash(auth.slice(7).trim())) : undefined;
  if (!g) return reply(res, 401, rpcError(-32001, 'Unauthorized'));
  if (!g.names.includes(name)) return reply(res, 404, rpcError(-32601, `No server ${name}`));
  // No standalone server-to-client stream.
  if (req.method !== 'POST' && req.method !== 'DELETE') return reply(res, 405, undefined, { allow: 'POST, DELETE' });

  let parsed: unknown;
  let messages: RpcMessage[] = [];
  if (req.method === 'POST') {
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, rpcError(-32700, 'Parse error'));
    }
    messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[];
    if (!messages.length || messages.some((m) => !m || typeof m !== 'object')) return reply(res, 400, rpcError(-32600, 'Invalid request'));
  }

  let live: Live;
  if (messages.some((m) => m.method === 'initialize')) {
    const s = g.make(name);
    if (!s) return reply(res, 404, rpcError(-32601, `No server ${name}`));
    live = open(g, name, s);
    await s.connect(live.t);
  } else {
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    const found = g.sessions.get(sid);
    // 404 tells the client to initialize again (a restarted server forgot its sessions).
    if (!found || found.name !== name) return reply(res, 404, rpcError(-32001, 'Session not found'));
    live = found;
  }

  // A client that hangs up gave up on its calls, so a blocking tool stops waiting.
  const asked = messages.filter((m) => typeof m.method === 'string' && m.id !== undefined && m.id !== null);
  const gone = () => {
    if (res.writableFinished) return;
    for (const m of asked) live.t.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: m.id!, reason: 'The client closed the request' } });
  };
  res.once('close', gone);
  try {
    await live.t.handleRequest(req, res, parsed);
  } catch (e) {
    reply(res, 500, rpcError(-32603, e instanceof Error ? e.message : String(e)));
  }
  // An initialize the transport refused leaves a server no session points to.
  if (!live.t.sessionId) void live.s.close().catch(() => {});
  return true;
}
