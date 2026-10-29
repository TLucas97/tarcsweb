import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { CODEX_EFFORTS, EFFORTS, MODES, type Effort, type Mode, type Provider } from './protocol.ts';

// The live app's server ports: 24817 (default and Dev mode) and 24816 (the tray's production server).
// Test servers on spare ports share the cache dir, so they never read or write the workspace.
const LIVE_PORTS = [24817, 24816];
const ON = LIVE_PORTS.includes(Number(process.env.CW_PORT) || 24817);
export const LIVE_SERVER = ON;
const FILE = join(CACHE_DIR, 'workspace.json');
const WRITE_MS = 2000;
let tmpNo = 0;
// Both live servers write here, so each temp file gets its own name.
export const tmpName = (file: string) => `${file}.${process.pid}-${++tmpNo}.tmp`;
const TABS_MAX = 40;
const CLOSED_MAX = 200;
const VERSION = 1;

// The model and effort a closed tab last ran with, by transcript id; a transcript does not record the effort.
export type Closed = { id: string; model: string; effort: Effort };

// One open tab as the dock showed it; the conversation itself stays in its transcript or Codex thread.
export type Tab = {
  id: string;
  cwd: string;
  name: string;
  spoken?: string;
  branch: string | null;
  provider: Provider;
  transcriptId: string | null;
  codexThreadId: string | null;
  mode: Mode;
  model: string;
  effort: Effort;
  lastActive: number;
  // Set when the server stopped mid-work: the heads-up text the tab shows once restored.
  interrupted: string | null;
};

export function interruptNote(working: boolean, waiting: boolean, background: boolean): string | null {
  const parts = [
    working && 'The turn was cut off; send a message to continue.',
    waiting && 'The questions and permission requests it was waiting on are gone; ask again if needed.',
    background && 'Its background agents and commands stopped.',
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' ') : null;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const strOrNull = (v: unknown) => (str(v) ? v : null);

function tabOf(v: unknown): Tab | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (!str(t.id) || !str(t.cwd) || !str(t.name) || !str(t.model) || (t.provider !== 'claude' && t.provider !== 'codex')) return null;
  if (!MODES.includes(t.mode as Mode) || !CODEX_EFFORTS.includes(t.effort as Effort)) return null;
  return {
    id: t.id, cwd: t.cwd, name: t.name, branch: strOrNull(t.branch), provider: t.provider, transcriptId: strOrNull(t.transcriptId),
    codexThreadId: strOrNull(t.codexThreadId), mode: t.mode as Mode, model: t.model, effort: t.effort as Effort,
    lastActive: typeof t.lastActive === 'number' ? t.lastActive : Date.now(), interrupted: strOrNull(t.interrupted),
    ...(str(t.spoken) ? { spoken: t.spoken as string } : {}),
  };
}

function closedOf(v: unknown): Closed | null {
  const c = v as Record<string, unknown> | null;
  return c && typeof c === 'object' && str(c.id) && str(c.model) && CODEX_EFFORTS.includes(c.effort as Effort) ? { id: c.id, model: c.model, effort: c.effort as Effort } : null;
}

export const validEffort = (provider: Provider, e: Effort) => (provider === 'claude' ? EFFORTS : CODEX_EFFORTS).includes(e);

// The open tabs on disk (CACHE_DIR/workspace.json), so a restarted server lists them again.
export class Workspace {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private last = '';
  private closed = false;
  private snapshot: () => Tab[];
  // Oldest first, so the cap drops the least recently closed.
  private recent = new Map<string, Closed>();

  constructor(snapshot: () => Tab[]) {
    this.snapshot = snapshot;
  }

  // Read once at boot, before the server listens.
  load(): Tab[] {
    if (!ON) return [];
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { version?: unknown; tabs?: unknown; closed?: unknown };
      if (raw.version !== VERSION) return [];
      for (const v of Array.isArray(raw.closed) ? raw.closed.slice(-CLOSED_MAX) : []) {
        const c = closedOf(v);
        if (c) this.recent.set(c.id, c);
      }
      const tabs = Array.isArray(raw.tabs) ? raw.tabs.slice(0, TABS_MAX).flatMap((t) => tabOf(t) ?? []) : [];
      this.last = this.json(tabs);
      return tabs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`workspace: ${FILE} is unreadable, starting empty (${(err as Error).message})`);
      return [];
    }
  }

  changed() {
    if (!ON || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, WRITE_MS);
    this.timer.unref();
  }

  remember(id: string, model: string, effort: Effort) {
    this.recent.delete(id);
    this.recent.set(id, { id, model, effort });
    if (this.recent.size > CLOSED_MAX) this.recent.delete(this.recent.keys().next().value!);
    this.changed();
  }

  recall(id: string): Closed | undefined {
    return this.recent.get(id);
  }

  private json(tabs = this.snapshot()) {
    return `"tabs":${JSON.stringify(tabs.slice(0, TABS_MAX))},"closed":${JSON.stringify([...this.recent.values()])}`;
  }

  // Temp file then rename, so a crash mid-write never leaves a torn manifest.
  private write() {
    const body = this.json();
    if (body === this.last) return;
    this.last = body;
    const text = `{"version":${VERSION},"savedAt":${Date.now()},${body}}`;
    const tmp = tmpName(FILE);
    this.writing = this.writing
      .then(() => mkdir(CACHE_DIR, { recursive: true }))
      .then(() => writeFile(tmp, text))
      .then(() => (this.closed ? rm(tmp, { force: true }) : rename(tmp, FILE)))
      .catch(async (err) => {
        await rm(tmp, { force: true });
        console.log(`workspace: saving failed (${(err as Error).message})`);
      });
  }

  // At shutdown, before the sessions close: what was running is still marked busy. Later changes are ignored.
  final() {
    if (!ON || this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = tmpName(FILE);
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(tmp, `{"version":${VERSION},"savedAt":${Date.now()},${this.json()}}`);
      renameSync(tmp, FILE);
    } catch (err) {
      rmSync(tmp, { force: true });
      console.log(`workspace: saving at shutdown failed (${(err as Error).message})`);
    }
  }
}
