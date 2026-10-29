import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { CACHE_DIR } from './config.ts';
import { cardCommand, diffDetail, summarizeFor, toolName } from './tools.ts';
import { oneLine } from './text.ts';
import { guard } from './session/util.ts';
import type { DockState, TerminalAsk, TerminalSession } from './protocol.ts';

// Where each running server leaves its port and token for the hook (terminal-hook.mjs); the installer passes this path.
export const HOOK_DIR = join(CACHE_DIR, 'terminal-hook');
// Every CLI the server starts inherits this; the hook sees it and stays out, since those sessions ask through canUseTool.
export const OWNED_ENV = 'CWEB_OWNED';
// Copies of the hook scripts, refreshed on every start; settings.json and the folder menu point here, so they outlive any one release.
export const HOOK_SCRIPT = join(HOOK_DIR, 'terminal-hook.mjs');
export const FOLDER_SCRIPT = join(HOOK_DIR, 'open-folder.mjs');

// Under the hook's own wait (ASK_MS in terminal-hook.mjs) and the settings timeout, so the app always answers first.
const ASK_MS = 120_000;
const BODY_MAX = 8 << 20;
const SESSIONS_MAX = 24;
const ASKS_MAX = 8;
// A session with no hook event for this long is dropped (a terminal closed without SessionEnd).
const STALE_MS = 4 * 3600_000;
const SWEEP_MS = 10 * 60_000;
// Asks these tools make need input only the terminal can collect (answers, a plan choice).
const TERMINAL_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode']);

type Pending = { card: TerminalAsk; tool: string; input: string; suggestions: PermissionUpdate[]; settle: (decision: unknown) => void };
type Ext = { id: string; cwd: string; name: string | null; state: DockState; at: number; seen: number; asks: Pending[] };
type Input = Record<string, unknown>;

const str = (v: unknown, max = 4096) => (typeof v === 'string' && v.length <= max ? v : '');
const hash = (s: string) => createHash('sha256').update(s).digest();

// Sessions from hook events, and the permission asks their hooks hold open.
class TerminalSessions {
  private rows = new Map<string, Ext>();
  private listeners = new Set<() => void>();
  private token = randomBytes(32).toString('base64url');
  private file: string | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  view(): TerminalSession[] {
    return [...this.rows.values()]
      .sort((a, b) => b.seen - a.seen)
      .map((r) => ({ id: r.id, cwd: r.cwd, name: r.name, state: r.state, lastActive: r.seen, asks: r.asks.map((a) => a.card) }));
  }

  // Written once the server listens, readable by this user only; the hook tries the newest live one.
  async publish(port: number) {
    await mkdir(HOOK_DIR, { recursive: true, mode: 0o700 });
    await chmod(HOOK_DIR, 0o700);
    for (const to of [HOOK_SCRIPT, FOLDER_SCRIPT]) {
      const from = fileURLToPath(new URL(`./hooks/${basename(to)}`, import.meta.url));
      await copyFile(from, `${to}.${process.pid}.tmp`);
      await rename(`${to}.${process.pid}.tmp`, to);
    }
    const file = join(HOOK_DIR, `${port}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ port, token: this.token, pid: process.pid, at: Date.now() }), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    this.file = file;
    this.sweep = setInterval(() => guard('terminal sweep', () => this.dropStale()), SWEEP_MS);
    this.sweep.unref();
  }

  // Sync: runs during shutdown, right before exit. Open asks end with no decision, so their terminals ask.
  close() {
    if (this.sweep) clearInterval(this.sweep);
    for (const r of this.rows.values()) for (const a of [...r.asks]) a.settle(null);
    if (!this.file) return;
    try {
      unlinkSync(this.file);
    } catch {}
    this.file = null;
  }

  answer(id: string, allow: boolean, always: boolean) {
    for (const r of this.rows.values()) {
      const a = r.asks.find((x) => x.card.id === id);
      if (!a) continue;
      const decision = !allow
        ? { behavior: 'deny', message: 'The user denied this action.' }
        : { behavior: 'allow', ...(always && a.suggestions.length ? { updatedPermissions: a.suggestions } : {}) };
      return a.settle(decision);
    }
  }

  // Also guards /hook/open (folderOpen.ts), which shares this token file.
  authorized(req: IncomingMessage) {
    const auth = req.headers.authorization ?? '';
    // A browser page always sends Origin; the hook never does.
    if (!auth.startsWith('Bearer ') || req.headers.origin !== undefined) return false;
    return timingSafeEqual(hash(auth.slice(7).trim()), hash(this.token));
  }

  // Handles POST /hook/terminal; false for any other path.
  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.url ?? '').split('?')[0] !== '/hook/terminal') return false;
    const refuse = (status: number) => {
      res.writeHead(status).end();
      return true;
    };
    if (req.method !== 'POST') return refuse(405);
    if (!this.authorized(req)) return refuse(401);
    let body: { at?: unknown; input?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return refuse(400);
    }
    const input = body?.input as Input | undefined;
    if (!input || typeof input !== 'object' || !str(input.session_id, 200) || !str(input.hook_event_name, 100)) return refuse(400);
    this.event(typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : Date.now(), input, res);
    return true;
  }

  private row(input: Input, at: number) {
    const id = str(input.session_id, 200);
    let r = this.rows.get(id);
    if (!r) {
      r = { id, cwd: str(input.cwd) || '/', name: null, state: 'idle', at, seen: Date.now(), asks: [] };
      this.rows.set(id, r);
      if (this.rows.size > SESSIONS_MAX) {
        const old = [...this.rows.values()].filter((x) => !x.asks.length).sort((a, b) => a.seen - b.seen)[0];
        if (old) this.rows.delete(old.id);
      }
    }
    r.seen = Date.now();
    const title = str(input.session_title, 400);
    if (title) r.name = oneLine(title, 80);
    return r;
  }

  // Hook start times order the events, since async hooks can land late.
  private setState(r: Ext, at: number, state: DockState) {
    if (at < r.at) return;
    r.at = at;
    r.state = state;
  }

  // Asks the terminal settled meanwhile: an older one for the same call, or all of them when the turn moved on.
  private clearAsks(r: Ext, at: number, call?: { tool: string; input: string }) {
    for (const a of [...r.asks]) if (a.card.at < at && (!call || (a.tool === call.tool && a.input === call.input))) a.settle(null);
  }

  private event(at: number, input: Input, res: ServerResponse) {
    const ev = str(input.hook_event_name);
    const ok = () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    if (ev === 'SessionEnd') {
      const r = this.rows.get(str(input.session_id, 200));
      if (r) {
        this.rows.delete(r.id);
        for (const a of [...r.asks]) a.settle(null);
        this.changed();
      }
      return ok();
    }
    const r = this.row(input, at);
    switch (ev) {
      case 'SessionStart':
        break;
      case 'UserPromptSubmit':
        if (!r.name && str(input.prompt, 1 << 20).trim()) r.name = oneLine(str(input.prompt, 1 << 20), 80);
        this.clearAsks(r, at);
        this.setState(r, at, 'working');
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.clearAsks(r, at, { tool: str(input.tool_name, 400), input: JSON.stringify(input.tool_input ?? null) });
        this.setState(r, at, r.asks.length ? 'waiting' : 'working');
        break;
      case 'Notification': {
        const kind = str(input.notification_type, 100);
        if (kind === 'permission_prompt' || kind === 'elicitation_dialog') this.setState(r, at, 'waiting');
        else if (kind === 'idle_prompt') this.setState(r, at, 'done');
        break;
      }
      case 'Stop':
      case 'StopFailure':
        this.clearAsks(r, at);
        this.setState(r, at, 'done');
        break;
      case 'PermissionRequest':
        this.setState(r, at, 'waiting');
        if (!TERMINAL_ONLY.has(str(input.tool_name, 400))) return void this.hold(r, at, input, res);
        break;
    }
    this.changed();
    ok();
  }

  // Replies when the ask is answered, cleared or timed out; a hook that went away (killed, timed out) drops it.
  private hold(r: Ext, at: number, input: Input, res: ServerResponse) {
    const tool = str(input.tool_name, 400);
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {};
    const suggestions = Array.isArray(input.permission_suggestions) ? (input.permission_suggestions as PermissionUpdate[]) : [];
    const command = cardCommand(r.cwd, tool, toolInput);
    const summary = summarizeFor(r.cwd, tool, toolInput);
    const detail = diffDetail(r.cwd, tool, toolInput);
    const card: TerminalAsk = {
      id: randomUUID(), tool: toolName(tool), summary, ...(command && command !== summary ? { command } : {}),
      ...(input.agent_id ? { title: `Subagent · ${oneLine(str(input.agent_type, 200) || 'agent', 60)}` } : {}),
      ...(detail ? { detail } : {}), always: suggestions.length > 0, at,
    };
    let done = false;
    const a: Pending = {
      card, tool, input: JSON.stringify(input.tool_input ?? null), suggestions,
      settle: (decision) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        r.asks = r.asks.filter((x) => x !== a);
        if (!r.asks.length && r.state === 'waiting') r.state = 'working';
        this.changed();
        if (!res.writableEnded && !res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision ? { decision } : {}));
      },
    };
    const timer = setTimeout(() => guard('terminal ask timeout', () => a.settle(null)), ASK_MS);
    res.once('close', () => a.settle(null));
    r.asks.push(a);
    if (r.asks.length > ASKS_MAX) r.asks[0].settle(null);
    this.changed();
  }

  private dropStale() {
    const cut = Date.now() - STALE_MS;
    let gone = false;
    for (const r of [...this.rows.values()]) {
      if (r.seen >= cut || r.asks.length) continue;
      this.rows.delete(r.id);
      gone = true;
    }
    if (gone) this.changed();
  }
}

export function readBody(req: IncomingMessage) {
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

export const terminal = new TerminalSessions();
