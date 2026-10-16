import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MEDIA, manifestPages } from './files.ts';
import { modDir } from './mcp.ts';

// The mod tools (progress, render_ui, replay open) for Codex tabs, which have no Claude Code plugin runtime.
// The web page draws them from the call's input; render_ui and replay also render in the visual mod's helper, so the model gets its PNGs and problems.

const CELL = { width: 9, height: 19 };
const REPLAY_CANVAS = { width: 880, height: 800 };
const REPLAY_SCALE = 1.5;
const LOAD = { alwaysLoad: true };
const RENDER_MS = 120_000;
// Per replay page: a page may carry a long animation and a layout check.
const PAGE_MS = 180_000;

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
};
const said = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const failed = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let helper: Promise<string> | null = null;
let child: ChildProcess | null = null;

// One shared helper process (headless Chromium behind a Unix socket), started on first use.
function startHelper() {
  helper ??= (async () => {
    const script = join(modDir('visual'), 'helper', 'server.mjs');
    await access(script).catch(() => {
      throw new Error(`the visual mod's helper is missing (${script})`);
    });
    return new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
      child = c;
      let buf = '';
      c.stdout!.setEncoding('utf8').on('data', (s: string) => {
        buf += s;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const e = JSON.parse(line) as { ev?: string; socket?: string };
            if (e.ev === 'ready' && e.socket) {
              clearTimeout(late);
              resolve(e.socket);
            }
          } catch {}
        }
      });
      c.stderr!.resume();
      const late = setTimeout(() => {
        reject(new Error('the visual helper did not start within 60 s'));
        c.kill('SIGTERM');
      }, 60_000);
      const gone = (e?: Error) => {
        clearTimeout(late);
        if (child === c) child = null;
        helper = null;
        reject(e ?? new Error('the visual helper exited'));
      };
      c.once('error', gone);
      c.once('exit', () => gone());
    });
  })();
  helper.catch(() => (helper = null));
  return helper;
}

export function stopHelper() {
  child?.kill('SIGTERM');
}

// A hung render must not hold the turn for the tool's 24 h timeout; the helper restarts on the next call.
function post(socket: string, path: string, body: unknown, ms: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: ms }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (s: string) => (text += s));
      res.on('end', () => {
        try {
          const r = JSON.parse(text) as Record<string, unknown>;
          if (r.ok !== true) reject(new Error(String(r.error ?? `HTTP ${res.statusCode}`)));
          else resolve(r);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`the visual helper did not answer within ${ms / 1000} s`));
      stopHelper();
    });
    req.end(JSON.stringify(body));
  });
}

const problemsOf = (done: Record<string, unknown>) => (Array.isArray(done.problems) ? done.problems.map(String) : []);

// Same report as the visual mod, so ToolLog reads the png line back and folds a later Read into the frame.
async function renderUi(a: { html: string; width?: number; rows?: number; duration_ms?: number; title?: string }) {
  if (!a.html.trim()) return failed('render_ui needs a non-empty `html` string.');
  const columns = Math.ceil(clamp(a.width, 320, 1800, 960) / CELL.width);
  const rows = clamp(a.rows, 4, 30, 20);
  const durationMs = clamp(a.duration_ms, 0, 20000, 0);
  const title = a.title?.trim() ? a.title.trim().slice(0, 80) : undefined;
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const width = columns * CELL.width;
  const height = rows * CELL.height;
  let done: Record<string, unknown>;
  try {
    done = await post(await startHelper(), '/render', { id, html: a.html, title, width, height, durationMs }, RENDER_MS);
  } catch (e) {
    return said(`Shown to the user in the page. No preview was rendered (${errText(e)}), so there is no PNG to check.`);
  }
  const problems = problemsOf(done);
  return said([
    `Rendered in ${Number(done.ms)} ms and shown to the person under this call.`,
    `id: ${id}`, `cells: ${columns}x${rows}`, `px: ${width}x${height}`, `duration_ms: ${durationMs}`,
    ...(title ? [`title: ${title}`] : []),
    `png: ${String(done.png)}`, `html: ${String(done.html)}`,
    ...(problems.length ? [`Problems (${problems.length}):`, ...problems.slice(0, 20).map((p) => `- ${p.slice(0, 300)}`)] : ['No console errors, page errors or failed requests.']),
  ].join('\n'));
}

const FILE_URL = /file:\/\/(\/[^"'`()<>\n]+)/g;

// The check renders with full disk access, so file:// links the web viewer cannot load are flagged here, as the replay mod does.
async function webProblems(source: string): Promise<string[]> {
  const problems = new Set<string>();
  const scan = async (text: string, depth: number) => {
    for (const match of text.matchAll(FILE_URL)) {
      const path = (match[1] ?? '').trimEnd();
      const name = path.slice(path.lastIndexOf('/') + 1);
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
      if (!MEDIA.has(ext)) {
        problems.add(ext === ''
          ? `web: file://${path} looks built at runtime; the web viewer rewrites only full literal file:// paths`
          : `web: file://${path} is a ${ext} file, which the web viewer does not serve; inline it`);
      } else if (depth === 0 && (ext === '.css' || ext === '.js' || ext === '.mjs')) {
        await scan(await readFile(path, 'utf8').catch(() => ''), 1);
      }
    }
  };
  await scan(source, 0);
  return [...problems];
}

function withZoom(source: string, zoom: number) {
  const style = `<style>:root{--replay-zoom:${zoom}}</style>`;
  return /<head[\s>]/i.test(source) ? source.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${style}`) : `${style}${source}`;
}

// The page viewer reads the manifest itself; this renders every page for the model's report, like the replay mod.
async function openReplay(a: { path: string; page?: number; check?: boolean }) {
  const path = a.path.trim();
  if (!path.startsWith('/')) return failed('replay needs `path`, the absolute path of a replay.json manifest.');
  const m = await manifestPages(path);
  if (typeof m === 'string') return failed(`replay failed: ${m}`);
  const size = `Canvas ${REPLAY_CANVAS.width}x${REPLAY_CANVAS.height} CSS px, PNGs at ${REPLAY_SCALE}x.`;
  const report: string[] = [];
  try {
    const socket = await startHelper();
    const stamp = Date.now().toString(36);
    for (const [i, p] of m.pages.entries()) {
      const source = await readFile(p.full, 'utf8');
      const html = withZoom(source, REPLAY_SCALE);
      const width = Math.round(p.width * REPLAY_SCALE);
      const height = Math.round(p.height * REPLAY_SCALE);
      const done = await post(socket, '/render', { id: `replay-${stamp}-${i + 1}`, html, title: p.title, width, height, durationMs: p.durationMs, checkLayout: { bottom: !p.fixed } }, PAGE_MS);
      const problems = [...problemsOf(done), ...(await webProblems(source))];
      report.push(`${p.id} ${p.title}: png ${String(done.png)}${problems.length ? `\n  ${problems.slice(0, 10).join('\n  ')}` : ''}`);
    }
  } catch (e) {
    if (a.check) return failed(`replay failed: ${errText(e)}`);
    report.push(`No page was rendered for checking (${errText(e)}).`);
  }
  if (a.check) {
    const next = 'Not shown. Fix the problems and the PNGs that look wrong, check again, then call once without check to show it.';
    return said([`Checked ${m.pages.length} pages. ${size} ${next}`, ...report].join('\n'));
  }
  return said([`Rendered ${m.pages.length} pages. ${size} The replay is open in the chat.`, ...report].join('\n'));
}

const VISUAL_DESCRIPTION = `Render HTML as a picture inline in the conversation; in this web UI it runs live in the page.

Use it when a visual explains better than text: connected cards or flow diagrams, component or screen prototypes, side-by-side variants (show states like normal/hover/pressed next to each other; only \`interactive: true\` takes input), UI rebuilt from a local reference image, charts, and animations. Do not use it for short or yes/no answers, or when plain text, a table or a code block is enough.

Canvas: \`width\` px (fit it to the content) by rows x 19 px (20 rows = 380 px); nothing scrolls. A light base style (white background, dark text, 16px body padding, 18px Atkinson Hyperlegible) comes first and your CSS overrides it. Keep every text 16px or larger. Inline <style>/<script>, CDN scripts and styles (GSAP, Motion, Tailwind, Chart.js...), <canvas>, and local files by absolute file:// URL all work.

With duration_ms > 0 the picture is an animation: start it on load and finish it by duration_ms.

The result lists console errors, page errors and failed requests; if any matter, fix the HTML and call again. It also gives the PNG path of a headless render, which you can open to check the picture yourself.`;

const REPLAY_DESCRIPTION = `Open a visual replay of a change: a paged viewer in the conversation.

\`path\` is the absolute path of a replay.json manifest: { "title": string, "pages": [{ "id": "P1", "title": string, "file": "p1.html", "duration_ms"?: number }] }. Page files are relative to the manifest. Every page is laid out on a fixed 880x800 CSS px canvas (manifest \`width\`/\`height\` override it per page), so design for that canvas. The result lists each page's PNG path and problems: console errors, failed requests, and \`layout:\` lines for content that overflows the page or a clipping box.

\`check: true\` renders and reports without showing the replay; use it to validate (open the PNGs you doubt, fix, check again), then call once without \`check\` to show it. Every call without \`check\` shows the replay again, so make that call once per replay.

\`page\` (1-based) opens at that page.`;

function visualServer() {
  return createSdkMcpServer({
    name: 'visual', version: '1.0.0', alwaysLoad: true,
    tools: [tool('render_ui', VISUAL_DESCRIPTION, {
      html: z.string().describe('A full document or a fragment: free HTML, CSS and JS.'),
      width: z.number().optional().describe('Canvas width in px, 320-1800, fit to the content. Default 960.'),
      rows: z.number().optional().describe('Height in rows of 19 px, 4-30. Default 20.'),
      duration_ms: z.number().optional().describe('Animation length, 0-20000; 0 for a static picture.'),
      title: z.string().optional().describe('Short caption shown with the picture.'),
      interactive: z.boolean().optional().describe('The live frame takes mouse and touch (drag, click, sliders), for prototypes the person should try. The chat does not scroll over it. Default false.'),
    }, renderUi, LOAD)],
  });
}

function replayServer() {
  return createSdkMcpServer({
    name: 'replay', version: '1.0.0', alwaysLoad: true,
    tools: [tool('open', REPLAY_DESCRIPTION, {
      path: z.string().describe('Absolute path of the replay.json manifest.'),
      page: z.number().optional().describe('Page to open at, 1-based. Default 1.'),
      check: z.boolean().optional().describe('Render and report without showing the replay; use it to validate, then call once without check to show it.'),
    }, openReplay, LOAD)],
  });
}

// The session reads the call's input from the Codex item, like it reads the tool_use on Claude tabs; the handler only acknowledges.
export function progressServer() {
  return createSdkMcpServer({
    name: 'agents-panel', version: '1.0.0', alwaysLoad: true,
    tools: [tool('progress', 'Report task progress to the agents panel the user watches: the task, how many steps, how many are done, and the step now running. Cheap; batch it with your next real tool call.', {
      task: z.string().optional().describe('Short task title, on the first call'),
      total: z.number().int().min(1).describe('Number of steps in the task'),
      done: z.number().int().min(0).describe('Steps finished so far'),
      step: z.string().describe('The step running now, a few words'),
    }, async () => said('Progress noted.'), LOAD)],
  });
}

// A fresh server for one MCP session; null for a name that is not a mod tool server.
export function modServer(name: string) {
  if (name === 'visual') return visualServer().instance;
  if (name === 'replay') return replayServer().instance;
  if (name === 'agents-panel') return progressServer().instance;
  return null;
}
