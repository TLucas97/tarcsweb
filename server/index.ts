import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionManager } from './sessions.ts';
import { findDirs, listDirs } from './dirs.ts';
import { serveFile } from './files.ts';
import { staticServer } from './static.ts';
import { listTree, readTree } from './tree.ts';
import { oneLine } from './session.ts';
import { config } from './config.ts';
import { connect } from './connect.ts';
import { login } from './login.ts';
import { codex } from './codex/client.ts';
import { codexAccount } from './codex/account.ts';
import { stt } from './stt.ts';
import { checkPatch, saveSettings, settingsView } from './settings.ts';
import { updater } from './update.ts';
import { sweepCold } from './coldLog.ts';
import { search } from './search/index.ts';
import { AiSearch } from './search/ai.ts';
import { EFFORTS, IMAGE_MIMES, MODEL_IDS, MODES, REPLY_STYLES, type ClientMessage, type ServerMessage, type WatchTimelineMessage } from './protocol.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.CW_PORT) || 24817;
const ALLOWED_ORIGINS = new Set(
  (process.env.CW_ORIGINS ?? 'http://localhost:24816,http://127.0.0.1:24816,http://localhost:4173,http://127.0.0.1:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const serverId = randomUUID();
const manager = new SessionManager();
// Production: this server also hosts the built client, on the page's own port.
const serveStatic = process.env.CW_DIST ? staticServer(process.env.CW_DIST) : null;

// Host names this server answers to, so a rebound DNS name cannot reach the files.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...[...ALLOWED_ORIGINS].map((o) => new URL(o).host)]);

const http = createServer((req, res) => {
  if (!HOSTS.has(req.headers.host ?? '')) return void res.writeHead(403).end();
  manager.voice
    .serve(req, res)
    .then((handled) => handled || serveFile(req, res))
    .then((handled) => handled || (serveStatic?.(req, res) ?? false))
    .then((handled) => {
      if (!handled) res.writeHead(404).end();
    })
    .catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 40 << 20 });

// This socket drives a coding agent, so only the local web UI may open it.
http.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  const origin = req.headers.origin;
  if (path !== '/ws' || !origin || !ALLOWED_ORIGINS.has(origin) || !HOSTS.has(req.headers.host ?? '')) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// A live event object reaches every client watching its session; it is serialized once.
const wire = new WeakMap<object, string>();

function sendTo(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState !== ws.OPEN) return;
  let json = wire.get(msg);
  if (json === undefined) wire.set(msg, (json = JSON.stringify(msg)));
  ws.send(json);
}

function sendRaw(ws: WebSocket, json: string) {
  if (ws.readyState === ws.OPEN) ws.send(json);
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const short = (v: unknown, max: number) => str(v) && v.length <= max;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validStyle = (v: unknown) => v === undefined || REPLY_STYLES.includes(v as never);
const shortList = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === 'string' && s.length <= 300);
const validSeen = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && shortList((v as { opened?: unknown }).opened) && shortList((v as { unopened?: unknown }).unopened));
const validSettings = (m: Record<string, unknown>) =>
  MODES.includes(m.mode as never) && MODEL_IDS.includes(m.model as string) && EFFORTS.includes(m.effort as never);

// A question's answers, or how a plan ends; a plan can never approve back into plan mode.
function validReply(r: unknown) {
  if (!r || typeof r !== 'object') return false;
  const { answers, mode, feedback, always } = r as Record<string, unknown>;
  if (always !== undefined && always !== true) return false;
  if (answers !== undefined && (!answers || typeof answers !== 'object' || Object.entries(answers).length > 4 || !Object.values(answers).every((a) => short(a, 4000)))) return false;
  if (mode !== undefined && (!MODES.includes(mode as never) || mode === 'plan')) return false;
  return feedback === undefined || short(feedback, 10_000);
}

// One ask_round answer: an option index or null, and a note that may be empty.
function validPick(p: unknown) {
  if (!p || typeof p !== 'object') return false;
  const { option, note } = p as Record<string, unknown>;
  return (option === null || (Number.isInteger(option) && (option as number) >= 0 && (option as number) < 4)) && typeof note === 'string' && note.length <= 4000;
}

// Images and PDFs arrive as base64; text files as their text.
function validUpload(f: unknown) {
  if (!f || typeof f !== 'object') return false;
  const u = f as Record<string, unknown>;
  if (!short(u.name, 300) || typeof u.data !== 'string' || !u.data) return false;
  if (u.kind === 'image') return IMAGE_MIMES.includes(u.mime as string) && u.data.length <= 7_000_000;
  if (u.kind === 'pdf') return u.mime === 'application/pdf' && u.data.length <= 30_000_000;
  return u.kind === 'text' && typeof u.mime === 'string' && u.data.length <= 2_000_000;
}

function parse(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
    switch (m.type) {
      case 'hello':
        return typeof m.afterSeq === 'number' && (m.sessionId === null || str(m.sessionId)) ? m : null;
      case 'send': {
        const pastes = m.pastes === undefined ? [] : m.pastes;
        if (!Array.isArray(pastes) || pastes.length > 20 || !pastes.every((p: unknown) => typeof p === 'string' && p.length <= 2_000_000)) return null;
        const files = m.files === undefined ? [] : m.files;
        const thumbs = m.thumbs === undefined ? [] : m.thumbs;
        if (!Array.isArray(files) || files.length > 10 || !files.every(validUpload)) return null;
        if (!Array.isArray(thumbs) || !thumbs.every((t: unknown) => t === null || (typeof t === 'string' && t.startsWith('data:image/') && t.length <= 200_000))) return null;
        if (m.id !== undefined && !(typeof m.id === 'string' && UUID.test(m.id))) return null;
        if (!validStyle(m.style) || !validSeen(m.seen)) return null;
        return str(m.sessionId) && typeof m.text === 'string' && (m.text.trim() || pastes.length || files.length) ? m : null;
      }
      case 'permission-answer':
        return str(m.sessionId) && str(m.id) && typeof m.allow === 'boolean' && (m.reply === undefined || validReply(m.reply)) ? m : null;
      case 'reload':
      case 'warm':
        return str(m.sessionId) && validStyle(m.style) ? m : null;
      case 'interrupt':
      case 'handoff':
        return str(m.sessionId) ? m : null;
      case 'remote-control':
        return str(m.sessionId) && typeof m.on === 'boolean' ? m : null;
      case 'list-past':
        return m;
      case 'open':
        return str(m.cwd) && validSettings(m) ? m : null;
      case 'resume':
        return str(m.id) ? m : null;
      case 'set-mode':
        return str(m.sessionId) && MODES.includes(m.mode) ? m : null;
      case 'set-mcp': {
        const s = m.servers;
        const serversOk = s === undefined || (!!s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length <= 200 && Object.entries(s).every(([k, v]) => short(k, 200) && typeof v === 'boolean'));
        return str(m.sessionId) && Array.isArray(m.keys) && m.keys.length <= 50 && m.keys.every((k: unknown) => short(k, 100)) && serversOk ? m : null;
      }
      case 'mcp-status':
        return str(m.sessionId) ? m : null;
      case 'mcp-auth':
      case 'mcp-reconnect':
        return str(m.sessionId) && short(m.server, 200) ? m : null;
      case 'set-model':
        return str(m.sessionId) && MODEL_IDS.includes(m.model) && EFFORTS.includes(m.effort) ? m : null;
      case 'close':
        return str(m.sessionId) ? m : null;
      case 'rename':
        return str(m.id) && short(m.title, 200) && m.title.trim() ? m : null;
      case 'archive':
        return str(m.id) && typeof m.archived === 'boolean' ? m : null;
      case 'delete':
        return str(m.id) ? m : null;
      case 'list-dirs':
        return short(m.path, 4096) ? m : null;
      case 'find-dirs':
        return short(m.query, 200) ? m : null;
      case 'search':
        return short(m.query, 200) && (m.cwd === undefined || short(m.cwd, 4096)) ? m : null;
      case 'search-ai':
        return short(m.query, 300) && m.query.trim().length >= 2 && (m.cwd === undefined || short(m.cwd, 4096)) ? m : null;
      case 'search-ai-stop':
        return m;
      case 'stop-task':
        return str(m.sessionId) && short(m.taskId, 200) ? m : null;
      case 'agent-message':
        return str(m.sessionId) && short(m.agentId, 200) && short(m.text, 20_000) && m.text.trim() ? m : null;
      case 'watch-log':
        return str(m.sessionId) && (m.taskId === null || short(m.taskId, 200)) ? m : null;
      case 'dismiss':
        return str(m.sessionId) && short(m.id, 400) ? m : null;
      case 'map-open':
        return str(m.sessionId) ? m : null;
      case 'choice-answer':
        return str(m.sessionId) && short(m.id, 200) && ((Number.isInteger(m.index) && m.index >= 0 && m.index < 6) || short(m.text, 4000)) ? m : null;
      case 'round-answer':
        return str(m.sessionId) && short(m.id, 200) && Array.isArray(m.answers) && m.answers.length >= 1 && m.answers.length <= 5 && m.answers.every(validPick) ? m : null;
      case 'unqueue':
        return str(m.sessionId) && short(m.id, 200) && (m.then === 'remove' || m.then === 'now') ? m : null;
      case 'replay-load':
        return str(m.sessionId) && short(m.id, 200) ? m : null;
      case 'changes-load':
        return str(m.sessionId) && short(m.id, 400) && short(m.path, 4096) ? m : null;
      case 'agent-load':
        return str(m.sessionId) && short(m.id, 400) ? m : null;
      case 'watch-load':
        return str(m.sessionId) && (m.before === undefined || (Number.isInteger(m.before) && m.before >= 0)) ? m : null;
      case 'history-load':
        return str(m.sessionId) && Number.isInteger(m.before) && (m.until === undefined || Number.isInteger(m.until)) && (m.id === undefined || short(m.id, 400)) ? m : null;
      case 'history-find':
        return str(m.sessionId) && short(m.query, 200) && m.query.trim() ? m : null;
      case 'tree-list':
      case 'tree-read':
        return str(m.sessionId) && typeof m.path === 'string' && m.path.length <= 4096 ? m : null;
      case 'voice-set':
        return typeof m.on === 'boolean' ? m : null;
      case 'voice-recap':
        return str(m.sessionId) && short(m.reply, 200) && typeof m.prompt === 'string' && m.prompt.length <= 20_000 && short(m.text, 200_000) ? m : null;
      case 'replay-voice':
        return str(m.sessionId) && short(m.id, 200) ? m : null;
      case 'connect-check':
      case 'login-start':
      case 'login-cancel':
      case 'logout':
      case 'settings-load':
      case 'stt-warm':
      case 'codex-check':
      case 'codex-login-cancel':
      case 'codex-logout':
      case 'codex-models':
        return m;
      case 'codex-login-start':
        return m.flow === 'browser' || m.flow === 'device' ? m : null;
      case 'stt-start':
      case 'stt-stop':
      case 'stt-cancel':
        return Number.isSafeInteger(m.take) && m.take > 0 ? m : null;
      case 'login-code':
        return short(m.code, 2048) ? m : null;
      case 'update-check':
        return m;
      case 'update':
        return short(m.tag, 64) ? m : null;
      // The patch itself is checked when handled, so a bad value gets its reason back.
      case 'settings-set':
        return short(m.id, 64) && m.patch && typeof m.patch === 'object' ? m : null;
      case 'ui-press':
        return str(m.sessionId) && short(m.plugin, 256) && (m.key === null || short(m.key, 256)) && Array.isArray(m.path) && m.path.length <= 64
          && m.path.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0) && (m.href === undefined || short(m.href, 2048)) ? m : null;
      case 'ui-prompt-answer': {
        const a = m.answer;
        if (!a || typeof a !== 'object') return null;
        const ok = (a.text === undefined || (typeof a.text === 'string' && a.text.length <= 1_000_000)) && (a.cursor === undefined || Number.isInteger(a.cursor))
          && (a.filled === undefined || typeof a.filled === 'boolean') && (a.shown === undefined || typeof a.shown === 'boolean');
        return str(m.sessionId) && short(m.id, 64) && ok ? m : null;
      }
      case 'explain': {
        const turns = m.turns;
        const turnOk = (t: unknown) => !!t && typeof t === 'object' && short((t as { text?: unknown }).text, 20_000) && typeof (t as { question?: unknown }).question === 'string' && (t as { question: string }).question.length <= 4000;
        if (!Array.isArray(turns) || turns.length > 50 || !turns.every(turnOk)) return null;
        return str(m.sessionId) && short(m.thread, 64) && (m.deep === undefined || typeof m.deep === 'boolean') && typeof m.excerpt === 'string' && m.excerpt.length <= 100_000 && typeof m.question === 'string' && m.question.length <= 4000 && (m.excerpt.trim() || m.question.trim()) ? m : null;
      }
    }
  } catch {}
  return null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const LOG_POLL_MS = 1000;

wss.on('connection', (ws) => {
  let unsubscribe: (() => void) | null = null;
  let logTimer: ReturnType<typeof setTimeout> | null = null;
  const stopLog = () => {
    if (logTimer) clearTimeout(logTimer);
    logTimer = null;
  };
  // Polls one task's output while this client shows it; after the task ends it reads once more and stops.
  const watchLog = (sessionId: string, taskId: string) => {
    stopLog();
    const tick = async () => {
      const r = await manager.get(sessionId)?.readLog(taskId, true);
      if (!r || ws.readyState !== ws.OPEN) return;
      sendTo(ws, { type: 'proc-log', sessionId, taskId, text: r.text, truncated: r.truncated, source: r.source, ...(r.path ? { path: r.path } : {}) });
      if (logTimer && !r.ended) logTimer = setTimeout(tick, LOG_POLL_MS);
    };
    logTimer = setTimeout(tick, 0);
  };
  const sendRoster = () => sendTo(ws, { type: 'sessions', open: manager.roster() });
  const sendPast = async () => {
    try {
      sendTo(ws, { type: 'past', ...(await manager.pastSessions()), home: homedir() });
    } catch (err) {
      sendTo(ws, { type: 'notice', message: `Could not list sessions: ${errText(err)}` });
    }
  };
  // Session edits are optimistic in the client; the fresh list afterwards settles any mismatch.
  const mutate = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      sendTo(ws, { type: 'notice', message: `${what} failed: ${errText(err)}` });
    }
    await sendPast();
  };
  const offRoster = manager.onRoster(sendRoster);
  sendRoster();
  const aiSearch = new AiSearch();
  const offLimits = manager.onLimits((limits) => sendTo(ws, { type: 'limits', limits }));
  const limits = manager.currentLimits();
  if (limits) sendTo(ws, { type: 'limits', limits });
  const offVoice = manager.voice.subscribe((m) => sendTo(ws, m));
  sendTo(ws, { type: 'voice-on', on: manager.voice.on });
  const offStt = stt.subscribe((m, to) => (!to || to === ws) && sendTo(ws, m));
  const offConnect = connect.subscribe((status) => sendTo(ws, { type: 'connect-status', status }));
  if (connect.status) sendTo(ws, { type: 'connect-status', status: connect.status });
  if (login.state.state !== 'idle') sendTo(ws, { type: 'login', login: login.state });
  sendTo(ws, { type: 'update', update: updater.status });
  if (codexAccount.status) sendTo(ws, { type: 'codex-status', status: codexAccount.status });
  if (codexAccount.login.state !== 'idle') sendTo(ws, { type: 'codex-login', login: codexAccount.login });

  ws.on('message', async (data) => {
    const msg = parse(data.toString());
    if (!msg) return;
    switch (msg.type) {
      case 'hello': {
        unsubscribe?.();
        unsubscribe = null;
        stopLog();
        const s = msg.sessionId ? manager.get(msg.sessionId) : undefined;
        const reset = msg.serverId !== serverId;
        sendTo(ws, { type: 'hello', serverId, reset, sessionId: msg.sessionId, found: !!s, defaults: config.defaults });
        if (!s) return;
        // Viewing does not start the CLI; typing does (warm), or the first send.
        const { events, replace, older } = s.backlog(reset ? 0 : msg.afterSeq);
        if (events.length || replace) sendTo(ws, { type: 'events', sessionId: s.id, events, ...(replace ? { replace: true as const, older } : {}) });
        const offEvents = s.subscribe((e) => sendTo(ws, e));
        const id = s.id;
        const offPanel = s.subscribePanel((json) => sendRaw(ws, json));
        sendTo(ws, { type: 'map', sessionId: id, ...s.map() });
        const offMap = s.subscribeMap((json) => sendRaw(ws, json));
        const offUi = s.subscribeUiPrompt((m) => sendTo(ws, m));
        sendTo(ws, { type: 'commands', sessionId: id, commands: s.commands() });
        const offCommands = s.subscribeCommands((commands) => sendTo(ws, { type: 'commands', sessionId: id, commands }));
        // The MCP menu loads on mcp-status; changes after that follow here.
        const offMcp = s.subscribeMcp((json) => sendRaw(ws, json));
        unsubscribe = () => {
          offEvents();
          offPanel();
          offMap();
          offUi();
          offCommands();
          offMcp();
        };
        return;
      }
      case 'send': {
        const s = manager.get(msg.sessionId);
        s?.setStyle(msg.style);
        s?.send(msg.text, msg.pastes, msg.files, msg.thumbs, false, msg.id, msg.seen);
        return;
      }
      case 'warm': {
        const s = manager.get(msg.sessionId);
        s?.setStyle(msg.style);
        s?.warm();
        return;
      }
      case 'permission-answer':
        manager.get(msg.sessionId)?.answerPermission(msg.id, msg.allow, msg.reply);
        return;
      case 'interrupt':
        void manager.get(msg.sessionId)?.interrupt();
        return;
      case 'reload': {
        const s = manager.get(msg.sessionId);
        if (!s) return;
        s.setStyle(msg.style);
        const busy = await s.reload();
        sendTo(ws, { type: 'notice', tone: 'info', message: busy ?? 'Session reloaded' });
        return;
      }
      case 'handoff': {
        const why = manager.get(msg.sessionId)?.handoffNow();
        if (why) sendTo(ws, { type: 'notice', tone: 'info', message: `Can't hand off: ${why}` });
        return;
      }
      case 'remote-control': {
        const why = await manager.get(msg.sessionId)?.setRemoteControl(msg.on);
        if (why) sendTo(ws, { type: 'notice', message: `Remote Control is off: ${why}` });
        return;
      }
      case 'set-mode':
        void manager.get(msg.sessionId)?.setMode(msg.mode);
        return;
      case 'set-mcp':
        void manager.get(msg.sessionId)?.setMcp(msg.keys, msg.servers);
        return;
      case 'mcp-status': {
        const s = manager.get(msg.sessionId);
        if (!s) return;
        sendRaw(ws, await s.mcpMenu());
        void s.refreshMcp();
        return;
      }
      case 'mcp-auth':
      case 'mcp-reconnect': {
        const s = manager.get(msg.sessionId);
        if (!s) return;
        const reply = msg.type === 'mcp-auth' ? await s.mcpAuth(msg.server) : await s.mcpReconnect(msg.server);
        sendTo(ws, { type: 'mcp-auth', sessionId: s.id, server: msg.server, ...reply });
        return;
      }
      case 'set-model':
        void manager.get(msg.sessionId)?.setModel(msg.model, msg.effort);
        return;
      case 'list-past':
        return sendPast();
      case 'stop-task':
        void manager.get(msg.sessionId)?.stopTask(msg.taskId);
        return;
      case 'agent-message':
        void manager.get(msg.sessionId)?.messageAgent(msg.agentId, msg.text);
        return;
      case 'watch-log':
        if (msg.taskId) watchLog(msg.sessionId, msg.taskId);
        else stopLog();
        return;
      case 'dismiss':
        manager.get(msg.sessionId)?.dismiss(msg.id);
        return;
      case 'map-open':
        manager.get(msg.sessionId)?.mapOpened();
        return;
      case 'choice-answer':
        manager.get(msg.sessionId)?.answerChoice(msg.id, msg.text?.trim() || msg.index!);
        return;
      case 'round-answer':
        manager.get(msg.sessionId)?.answerChoice(msg.id, msg.answers.map((a) => ({ option: a.option, note: a.note.trim() })));
        return;
      case 'unqueue':
        void manager.get(msg.sessionId)?.unqueue(msg.id, msg.then);
        return;
      case 'replay-load': {
        const s = manager.get(msg.sessionId);
        if (!s) return;
        const info = await s.replay(msg.id);
        sendTo(ws, { type: 'replay', sessionId: msg.sessionId, id: msg.id, ...info });
        return;
      }
      case 'changes-load': {
        const s = manager.get(msg.sessionId);
        if (s) sendTo(ws, { type: 'changes-detail', sessionId: msg.sessionId, id: msg.id, path: msg.path, diff: s.changeDetail(msg.id, msg.path) });
        return;
      }
      case 'agent-load': {
        const s = manager.get(msg.sessionId);
        if (s) sendTo(ws, { type: 'agent-detail', sessionId: msg.sessionId, id: msg.id, detail: s.agentText(msg.id) });
        return;
      }
      case 'watch-load': {
        const s = manager.get(msg.sessionId);
        const reply: WatchTimelineMessage | null = s ? { type: 'watch-timeline', sessionId: msg.sessionId, ...(await s.watchPage(msg.before)) } : null;
        if (reply) sendRaw(ws, JSON.stringify(reply));
        return;
      }
      case 'history-load': {
        const { sessionId, before, until, id } = msg;
        const s = manager.get(sessionId);
        const reply: ServerMessage = await (s ? s.history(before, until, id) : Promise.reject(new Error('The session is closed'))).then(
          (page) => ({ type: 'history', sessionId, before, ...page }),
          (err) => ({ type: 'history', sessionId, before, events: [], older: before, error: String(err) }),
        );
        sendRaw(ws, JSON.stringify(reply));
        return;
      }
      case 'history-find': {
        const { sessionId, query } = msg;
        const s = manager.get(sessionId);
        const reply: ServerMessage = await (s ? s.find(query) : Promise.reject(new Error('The session is closed'))).then(
          (r) => ({ type: 'history-found', sessionId, query, ...r }),
          (err) => ({ type: 'history-found', sessionId, query, hits: [], more: false, error: String(err) }),
        );
        sendRaw(ws, JSON.stringify(reply));
        return;
      }
      case 'tree-list':
      case 'tree-read': {
        const { sessionId, path } = msg;
        const s = manager.get(sessionId);
        if (!s) return;
        if (msg.type === 'tree-list') sendTo(ws, { type: 'tree', sessionId, path, ...(await listTree(s.cwd, path)) });
        else sendTo(ws, { type: 'tree-file', sessionId, path, ...(await readTree(s.cwd, path)) });
        return;
      }
      case 'voice-set':
        manager.voice.setOn(msg.on);
        return;
      case 'stt-warm':
        return stt.warm(ws);
      case 'stt-start':
        return stt.start(ws, msg.take);
      case 'stt-stop':
        return stt.stop(ws, msg.take);
      case 'stt-cancel':
        return stt.cancel(ws, msg.take);
      case 'voice-recap':
        if (manager.get(msg.sessionId)) manager.voice.request(msg.sessionId, msg.reply, msg.prompt, msg.text);
        return;
      case 'replay-voice': {
        const s = manager.get(msg.sessionId);
        if (s) manager.voice.narrate(msg.sessionId, msg.id, () => s.replayText(msg.id));
        return;
      }
      case 'connect-check':
        void connect.check();
        return;
      case 'login-start':
        void login.start();
        return;
      case 'login-code':
        login.code(msg.code);
        return;
      case 'login-cancel':
        login.cancel();
        return;
      case 'logout':
        void login.logout();
        return;
      case 'codex-check':
        void codexAccount.check();
        return;
      case 'codex-login-start':
        void codexAccount.startLogin(msg.flow);
        return;
      case 'codex-login-cancel':
        codexAccount.cancelLogin();
        return;
      case 'codex-logout':
        void codexAccount.logout();
        return;
      case 'codex-models':
        try {
          sendTo(ws, { type: 'codex-models', models: await codexAccount.models(), error: null });
        } catch (err) {
          sendTo(ws, { type: 'codex-models', models: [], error: errText(err) });
        }
        return;
      case 'settings-load':
        sendTo(ws, { type: 'settings', settings: settingsView() });
        return;
      case 'settings-set': {
        const error = checkPatch(msg.patch) ?? (await saveSettings(msg.patch));
        if (!error && msg.patch.handoffAt !== undefined) manager.syncHandoffAt();
        sendTo(ws, { type: 'settings', settings: settingsView(), reply: { id: msg.id, error } });
        return;
      }
      case 'update-check':
        void updater.check(true);
        return;
      case 'update': {
        const why = updater.update(msg.tag);
        if (why) sendTo(ws, { type: 'notice', message: `Can't update: ${why}` });
        return;
      }
      case 'ui-press':
        manager.get(msg.sessionId)?.uiPress(msg.plugin, msg.key, msg.path, msg.href);
        return;
      case 'ui-prompt-answer':
        manager.get(msg.sessionId)?.answerUiPrompt(msg.id, msg.answer);
        return;
      case 'explain': {
        const { sessionId, thread, excerpt, turns, question, deep } = msg;
        const s = manager.get(sessionId);
        if (!s) return sendTo(ws, { type: 'explain-error', sessionId, thread, index: turns.length, error: 'That session is no longer open' });
        void s.explain({ thread, excerpt, turns, question }, !!deep, (e) => sendTo(ws, e));
        return;
      }
      case 'close':
        return mutate('Close', () => manager.close(msg.sessionId));
      case 'rename':
        return mutate('Rename', () => manager.rename(msg.id, oneLine(msg.title, 80)));
      case 'archive':
        return mutate(msg.archived ? 'Archive' : 'Unarchive', () => manager.setArchived(msg.id, msg.archived));
      case 'delete':
        return mutate('Delete', () => manager.remove(msg.id));
      case 'find-dirs':
        sendTo(ws, { type: 'found', query: msg.query, dirs: await findDirs(msg.query) });
        return;
      case 'search':
        sendTo(ws, { type: 'search-found', query: msg.query, cwd: msg.cwd ?? null, ...(await search.query(msg.query, msg.cwd ?? null)) });
        return;
      case 'search-ai': {
        const r = await aiSearch.run(msg.query, msg.cwd ?? null);
        if (r) sendTo(ws, { type: 'search-ai-found', query: msg.query, cwd: msg.cwd ?? null, ...r });
        return;
      }
      case 'search-ai-stop':
        aiSearch.stop();
        return;
      case 'list-dirs':
        try {
          sendTo(ws, { type: 'dirs', ...(await listDirs(msg.path)) });
        } catch (err) {
          sendTo(ws, { type: 'dirs', path: msg.path, error: errText(err) });
        }
        return;
      case 'open':
      case 'resume':
        try {
          const s =
            msg.type === 'open'
              ? await manager.openNew(msg.cwd, { mode: msg.mode, model: msg.model, effort: msg.effort })
              : await manager.resume(msg.id);
          sendTo(ws, { type: 'opened', sessionId: s.id });
        } catch (err) {
          sendTo(ws, { type: 'notice', message: errText(err) });
        }
        return;
    }
  });

  ws.on('close', () => {
    aiSearch.stop();
    stopLog();
    unsubscribe?.();
    offRoster();
    offLimits();
    offVoice();
    offStt();
    stt.drop(ws);
    offConnect();
  });
});

void connect.check();
void sweepCold();
search.start();
// One message object per change, so sendTo serializes it once for every client.
login.subscribe((state) => {
  const msg: ServerMessage = { type: 'login', login: state };
  for (const c of wss.clients) sendTo(c, msg);
});
updater.subscribe((update) => {
  const msg: ServerMessage = { type: 'update', update };
  for (const c of wss.clients) sendTo(c, msg);
});
void updater.start();
// Codex starts only when a client asks (codex-check, sign-in, models), never at boot.
codexAccount.subscribe((status) => {
  const msg: ServerMessage = { type: 'codex-status', status };
  for (const c of wss.clients) sendTo(c, msg);
});
codexAccount.subscribeLogin((state) => {
  const msg: ServerMessage = { type: 'codex-login', login: state };
  for (const c of wss.clients) sendTo(c, msg);
});

http.listen(PORT, HOST, () => {
  console.log(`tarcsweb server on http://${HOST}:${PORT} (ws: /ws)${serveStatic ? `, client from ${process.env.CW_DIST}` : ''}`);
});

function shutdown() {
  const bye = JSON.stringify({ type: 'bye' } satisfies ServerMessage);
  // Wait until every page got its bye (or 800 ms), so open windows close instead of reconnecting.
  // A restart for an update skips it: the pages reconnect to the new version.
  const clients = updater.restarting() ? [] : [...wss.clients];
  const sent = clients.map((c) => new Promise<void>((done) => c.send(bye, () => done())));
  manager.closeAll();
  login.close();
  codex.close();
  stt.close();
  void Promise.race([Promise.all(sent), new Promise((r) => setTimeout(r, 800))]).then(() => {
    wss.close();
    http.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
