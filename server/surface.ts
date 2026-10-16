// Draws plugins' AbovePrompt band through the CLI's remote-surface protocol (ui_attach / ui_render / ui_press).
// The protocol is internal and missing from sdk.d.ts, so it lives only here; any failure turns the band off quietly.
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { UiElement, UiNode, UiPromptOp } from './protocol.ts';

type ControlQuery = Query & {
  request?: (req: Record<string, unknown>) => Promise<{ response?: unknown }>;
  setUiHost?: (host: Record<string, (req: Record<string, unknown>) => Promise<unknown>>) => void;
};

export type UiAsk = { op: UiPromptOp; text?: string; mode?: string };
export type SurfaceHost = {
  tree: (tree: UiNode | null) => void;
  // The client's composer answers; null when no client answered in time.
  ask: (ask: UiAsk) => Promise<Record<string, unknown> | null>;
  working: () => boolean;
};

const SURFACE = 'desktop';
const CLIENT_ID = 'claude-web';
const VIEWPORT = { columns: 100, rows: 40 };
const RENDER_MS = 60;

const isElement = (n: unknown): n is UiElement => !!n && typeof n === 'object' && typeof (n as UiElement).type === 'string';

// Core's own AbovePrompt is the terminal's; the app draws its own, so engine refs render as nothing.
function strip(n: UiNode): UiNode | null {
  if (typeof n === 'string') return n;
  if (!isElement(n) || n.type === 'engine') return null;
  const children = n.children?.map(strip).filter((c): c is UiNode => c !== null);
  return { ...n, ...(children ? { children } : {}) };
}

function find(n: UiNode | null, hit: (e: UiElement) => boolean): UiElement | null {
  if (!isElement(n)) return null;
  if (hit(n)) return n;
  for (const c of n.children ?? []) {
    const f = find(c, hit);
    if (f) return f;
  }
  return null;
}

function at(n: UiNode | null, path: number[]): UiElement | null {
  let cur: UiNode | null = n;
  for (const i of path) cur = isElement(cur) ? cur.children?.[i] ?? null : null;
  return isElement(cur) ? cur : null;
}

export class PluginSurface {
  private q: ControlQuery;
  private host: SurfaceHost;
  private alive = true;
  private attached = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rendering = false;
  private dirty = false;
  // The newest tree as the CLI sent it: presses need its handles, which change on every render.
  private latest: UiNode | null = null;

  constructor(q: Query, host: SurfaceHost) {
    this.q = q as ControlQuery;
    this.host = host;
  }

  async start() {
    const q = this.q;
    if (!q.request || !q.setUiHost) return;
    q.setUiHost({
      promptRead: async () => {
        const a = await this.host.ask({ op: 'read' });
        return { text: typeof a?.text === 'string' ? a.text : '', cursor: typeof a?.cursor === 'number' ? a.cursor : 0 };
      },
      promptFill: async (r) => {
        const a = await this.host.ask({ op: 'fill', text: String(r.text ?? ''), mode: String(r.mode ?? 'replace') });
        return { filled: a?.filled === true };
      },
      promptSuggest: async (r) => {
        const a = await this.host.ask({ op: 'suggest', text: String(r.text ?? '') });
        return { shown: a?.shown === true };
      },
    });
    try {
      await q.request({ subtype: 'ui_attach', surface: SURFACE, client_id: CLIENT_ID, viewport: VIEWPORT, answers: ['ui_prompt_read', 'ui_prompt_fill', 'ui_prompt_suggest'] });
    } catch {
      return;
    }
    this.attached = true;
    this.invalidate();
  }

  stop() {
    this.alive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
    this.host.tree(null);
  }

  // Bursts of ui_invalidate (every plugin sends them) collapse into one render; one render runs at a time.
  invalidate() {
    if (!this.attached || !this.alive) return;
    if (this.rendering) return void (this.dirty = true);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.render();
    }, RENDER_MS);
  }

  private async render() {
    if (!this.alive || !this.q.request) return;
    this.rendering = true;
    this.dirty = false;
    try {
      const r = await this.q.request({
        subtype: 'ui_render', surface: SURFACE, client_id: CLIENT_ID, component: 'AbovePrompt', instance_id: 'above-prompt',
        props: { isWorking: this.host.working(), hasSurvey: false, bodyColumns: 92, maxRows: 24 }, viewport: VIEWPORT,
      });
      const tree = (r.response as { tree?: UiNode } | undefined)?.tree;
      if (this.alive && tree !== undefined) {
        this.latest = tree;
        this.host.tree(strip(tree));
      }
    } catch {
      // A failed render keeps the last tree; the next invalidate tries again.
    } finally {
      this.rendering = false;
      if (this.dirty) this.invalidate();
    }
  }

  // The client names the element by plugin + key (or its path when keyless); the handle comes from the newest tree.
  async press(plugin: string, key: string | null, path: number[], href?: string) {
    if (!this.attached || !this.alive || !this.q.request) return;
    const locate = () => {
      const byKey = key === null ? null : find(this.latest, (e) => e.press?.plugin === plugin && e.props?.key === key);
      const el = byKey ?? at(this.latest, path);
      return el?.press?.plugin === plugin ? el : null;
    };
    for (let tries = 0; tries < 2; tries++) {
      const el = locate();
      if (!el?.press) return;
      const elKey = typeof el.props?.key === 'string' ? el.props.key : undefined;
      try {
        const r = await this.q.request({
          subtype: 'ui_press', plugin, handle: el.press.handle, surface: SURFACE, client_id: CLIENT_ID,
          ...(elKey ? { key: elKey } : {}), ...(href ? { href } : {}),
        });
        if ((r.response as { handled?: boolean } | undefined)?.handled) return;
      } catch {
        return;
      }
      // A redraw raced the click: fetch fresh handles and try once more.
      await this.render();
    }
  }
}
