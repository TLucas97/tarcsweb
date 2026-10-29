import { stat } from 'node:fs/promises';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  APP_TOOLS, BROWSER_RECORD, CHART_MAX, CODEX_TOOLS, PROTO_STYLES_MAX, acceptOf, chartCuts, checklistText, planCuts, protoText, roundKindOf, roundText, tableCuts, uploadText, withStyles,
} from './tools.ts';
import { browser } from './browser.ts';
import type { EndWhy, Saved } from './recorder.ts';
import { ASK_UPLOAD_MAX, CHECKLIST_MAX, PROTO_VARIANTS_MAX, ROUND_CANCELLED, acceptsFile, type ProtoComment, type RoundPick, type Upload } from './protocol.ts';
import type { StartArgs } from './codex/agents.ts';
import type { ClaudeStartArgs } from './claudeAgents.ts';
import { IMAGE_COUNT_MAX, type ImageArgs, type ImageRun } from './codex/images.ts';
import { codexAccount } from './codex/account.ts';
import { codex as codexClient } from './codex/client.ts';
import { checkImage, saveAsked } from './files.ts';
import { oneLine } from './text.ts';
import { renderUi } from './modTools.ts';

export type RoundInput = { title?: string; questions: { title: string; options: { label: string }[]; kind?: string }[] };
// extra: the round's optional free note, beside the per-question answers.
export type RoundSent = { picks: RoundPick[]; extra: string };
// The session side of ask_round: one pick per question, or null when the round was cancelled.
export type RoundBroker = (round: RoundInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<RoundSent | null>;
export type ProtoInput = { title: string; question: string; html: string; variants?: { html: string }[] };
export type ProtoSent = { values: Record<string, unknown>; note: string; variant?: string | null; comments?: ProtoComment[] };
// The session side of ask_prototype: what the user sent, or null when the call was cancelled.
export type ProtoBroker = (ask: ProtoInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<ProtoSent | null>;
export type ChecklistInput = { title: string; items: { label: string }[] };
export type ChecklistSent = { ticked: number[]; note: string };
// The session side of ask_checklist: what the user ticked, or null when the call was cancelled.
export type ChecklistBroker = (ask: ChecklistInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<ChecklistSent | null>;
export type UploadInput = { prompt: string; accept: string[] };
// The session side of ask_upload: the files the user sent (none when they cancelled), or null when the call was cancelled.
export type UploadBroker = (ask: UploadInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<Upload[] | null>;
// The session side of the Codex tools; each resolves with the text for the model and throws with one it can relay.
export type CodexBroker = {
  start: (args: StartArgs, toolUseId: string | undefined) => Promise<string>;
  message: (agentId: string, text: string) => Promise<string>;
  stop: (agentId: string) => Promise<string>;
  image: (args: ImageArgs, signal: AbortSignal | undefined) => Promise<ImageRun>;
};
// The session side of the Claude subagent tools (Codex tabs only); same contract as CodexBroker.
export type ClaudeBroker = {
  start: (args: ClaudeStartArgs, toolUseId: string | undefined) => Promise<string>;
  message: (agentId: string, text: string) => Promise<string>;
  stop: (agentId: string) => Promise<string>;
};
// open: show_url's page in the Browser panel, for this session's user.
export type SessionTransfer = { folder: string; instruction: string; handoff: string; subsession?: boolean; worktree?: boolean };
export type SessionBroker = {
  open: (args: SessionTransfer, signal?: AbortSignal) => Promise<string>;
  message: (id: string, text: string) => Promise<string>;
  summary: (text?: string, report?: boolean) => Promise<string>;
};
export type Brokers = { round: RoundBroker; upload: UploadBroker; prototype: ProtoBroker; checklist: ChecklistBroker; open: (url: string) => Promise<void>; codex: CodexBroker; claude?: ClaudeBroker; sessions?: SessionBroker };

// The app tools that need the Codex CLI; a Claude tab leaves them out when it is not installed.
export const CODEX_ONLY = ['codex_agent', 'codex_message', 'codex_stop', 'generate_image'];
// The cached install fact; unknown (before the boot probe ends) counts as installed.
export const codexInstalled = () => codexAccount.status?.installed ?? (codexClient.binary ? !!codexClient.binary.path : true);
// Called once at boot, so no message has to start a process to learn it.
export const probeCodex = () => void codexClient.checkBinary().catch(() => {});

const NO_ANSWER = { content: [{ type: 'text' as const, text: ROUND_CANCELLED }], isError: true };
// A round sent with nothing answered: the user closed the card to talk first.
const SKIPPED = 'The user closed the card without answering, to reply in the chat instead. End your turn now and wait for their message; do not pick for them.';
const said = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const failed = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
// The abort signal and the call's id: Claude's tool_use id, or Codex's callId, which is its mcpToolCall item id (rows use `cx:<item id>`).
const callOf = (extra: unknown) => {
  const x = (extra ?? {}) as { signal?: AbortSignal; _meta?: Record<string, unknown> };
  const id = x._meta?.['claudecode/toolUseId'];
  const cx = x._meta?.callId;
  return { signal: x.signal, id: typeof id === 'string' ? id : typeof cx === 'string' ? `cx:${cx}` : undefined };
};

// Allowed without a prompt: a Codex agent asks for its own approvals under the tab's mode; browser_record needs the
// owner's agents switch on. show_url only opens a page the user sees, so it needs no switch.
export const APP_TOOL_NAMES = [...Object.values(APP_TOOLS), ...Object.values(CODEX_TOOLS), BROWSER_RECORD, 'mcp__app__open_session', 'mcp__app__session_message', 'mcp__app__group_summary'];

const REC_OFF = "The Browser panel is off for agents. Ask the user to turn on Agents in the Browser panel's header, then try again.";
const ENDED: Partial<Record<EndWhy, string>> = {
  limit: 'It had already stopped at the 15-minute limit.',
  size: 'It had already stopped at the size limit.',
  chrome: 'It stopped early because the browser stopped.',
};
// The first line is what tools.ts reads back (VIDEO_SAVED) to show the video in the conversation.
const savedReply = (s: Saved) =>
  said([`Saved video: ${s.path} (${s.w}x${s.h}, ${(s.ms / 1000).toFixed(1)} s)`, ...(ENDED[s.why] ? [ENDED[s.why]!] : []), 'The user already sees the video in the chat.'].join('\n'));

async function record(action: 'start' | 'stop', title: string | undefined) {
  if (action === 'stop') return savedReply(await browser.recordStop());
  if (!browser.agents) throw new Error(REC_OFF);
  await browser.ensure();
  await browser.recordStart(title ?? null);
  return said("Recording the Browser panel's active tab (up to 15 minutes). Drive the page now, then call browser_record with action stop.");
}

// Past this size a picture goes back to the model as its path only.
const INLINE_MAX = 3_500_000;

// The text tools.ts reads back for the card ("Generated … in Ns.", "Saved: …"), plus each picture when the model asked to look.
function imageReply(r: ImageRun, look: boolean) {
  const n = r.images.length;
  const lines = [
    `Generated ${n} image${n > 1 ? 's' : ''} in ${Math.round(r.ms / 1000)}s.${n < r.asked ? ` Codex returned ${n} of the ${r.asked} asked for.` : ''}`,
    ...r.images.map((i) => `Saved: ${i.path}${i.width && i.height ? ` (${i.width}x${i.height})` : ''}`),
    ...r.revised.map((p, i) => `Revised prompt${r.revised.length > 1 ? ` ${i + 1}` : ''}: ${p}`),
    'The user already sees the image in the chat.',
  ];
  const pics = (look ? r.images : []).filter((i) => i.data.length <= INLINE_MAX).map((i) => ({ type: 'image' as const, data: i.data.toString('base64'), mimeType: i.mime }));
  return { content: [{ type: 'text' as const, text: lines.join('\n') }, ...pics] };
}

// Loaded up front, so the model needs no ToolSearch round trip before a visual.
const LOAD = { alwaysLoad: true };
// The card cuts to fixed limits; the reply names each cut so the model knows the user saw less.
const shown = (what: string, cuts: (input: unknown) => string[]) => async (args: unknown) => {
  const cut = cuts(args);
  return said(`Shown to the user as a ${what}${cut.length ? `: ${cut.join(', ')}` : ''}.`);
};

function pageUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return `"${oneLine(raw, 200)}" is not a valid URL. Give a full address, such as https://example.com or http://localhost:5173.`;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : `Only http and https pages open in the Browser panel, not ${u.protocol.replace(/:$/, '')}.`;
}

async function showImage(path: string) {
  const r = await checkImage(path);
  if (typeof r === 'string') return failed(`${r} (${oneLine(path, 300)})`);
  // The first line is what tools.ts reads back (IMAGE_SHOWN) to sign the picture for the card.
  return said(`Shown image: ${path}${r.w && r.h ? ` (${r.w}x${r.h})` : ''}\nThe user sees it in the chat.`);
}

const NAMED_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

async function askUpload(upload: UploadBroker, args: { prompt: string; accept?: string[] }, extra: unknown) {
  const ask = { prompt: args.prompt, accept: acceptOf(args.accept) };
  const x = callOf(extra);
  const files = await upload(ask, x.signal, x.id);
  if (!files?.length) return NO_ANSWER;
  // The card filters by accept already; this catches a client that did not. A picture it scaled down is webp now, so its name's type counts too.
  const named = (f: Upload) => (f.kind === 'image' ? NAMED_MIME[/\.\w+$/.exec(f.name.toLowerCase())?.[0] ?? ''] ?? f.mime : f.mime);
  const off = files.filter((f) => !acceptsFile(ask.accept, f.name, f.mime) && !acceptsFile(ask.accept, f.name, named(f))).map((f) => oneLine(f.name, 80));
  if (off.length) return failed(`The user's files did not match accept (${ask.accept.join(', ')}): ${off.join(', ')}.`);
  try {
    return said(uploadText(await saveAsked(files.slice(0, ASK_UPLOAD_MAX))));
  } catch (e) {
    return failed(`The files could not be saved: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Claude subagents need a Claude main's Agent tool otherwise, so only brokers with claude get these.
function claudeTools(claude: ClaudeBroker) {
  const run = (f: () => Promise<string>) => f().then(said, failed);
  return [
    tool(
      'claude_agent',
      'Start a Claude (Anthropic) coding agent in the background, like a background subagent. Returns its agent id at once; its final report arrives later as a task-notification, so do not poll or wait for it. Several can run in parallel. It runs in this tab\'s folder under its permission mode and reports its own progress.',
      {
        description: z.string().describe('Short name shown in the agents panel (3-6 words)'),
        prompt: z.string().describe('The whole task: Claude has none of this conversation, so include the goal, files, constraints and how to verify'),
        model: z.string().optional().describe('Claude model id: claude-sonnet-5-5 (default), claude-opus-5-5 for hard work, claude-haiku-5-5 for quick searches and mechanical edits'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort; omit for the model default'),
      },
      async (args, extra) => run(() => claude.start(args, callOf(extra).id)),
      LOAD,
    ),
    tool(
      'claude_message',
      'Send a follow-up to a Claude agent started with claude_agent. A running agent gets it after its current step; a finished one starts a new turn and reports again when done.',
      { agent_id: z.string().describe('The id claude_agent returned'), message: z.string() },
      async (args) => run(() => claude.message(args.agent_id, args.message)),
      LOAD,
    ),
    tool(
      'claude_stop',
      'Stop a Claude agent started with claude_agent.',
      { agent_id: z.string().describe('The id claude_agent returned') },
      async (args) => run(() => claude.stop(args.agent_id)),
      LOAD,
    ),
  ];
}

// The app's MCP server ("app"): in-process for Claude, over HTTP for Codex, which leaves out tools it has natively (omit).
// The web UI renders the visuals' inputs, so their handlers only acknowledge.
export function appServer({ round, upload, prototype, checklist, open, codex, claude, sessions }: Brokers, omit: string[] = []) {
  return createSdkMcpServer({
    name: 'app',
    version: '1.0.0',
    alwaysLoad: true,
    tools: ([
      ...(sessions ? [
        tool('open_session',
          'Open a fresh tarcsweb tab ONLY when the user explicitly asks for a new session or sub-session, in the folder they name. Never initiate this yourself or choose a folder for them. Write a focused handoff of relevant status, decisions, constraints, files and next steps; do not copy raw messages or secrets. The handoff and user instruction start its first turn immediately. For a standalone session sharing a repository, the app asks about a worktree on every call. For a sub-session sharing a repository, a separate worktree is mandatory. The main session coordinates and merges results. Returns the tab id for session_message.',
          {
            folder: z.string().trim().min(1).max(4096).describe('Folder explicitly named by the user'),
            instruction: z.string().trim().min(1).max(16000).describe('The user request and focus for the new session'),
            handoff: z.string().trim().min(1).max(100000).describe('Focused handoff written by this source session, never raw messages'),
            subsession: z.boolean().optional().describe('True when the user asks for a sub-session in this session’s group. Only main sessions can create children.'),
            worktree: z.boolean().optional().describe('Use a separate worktree. Sub-sessions sharing a repository always require one.'),
          },
          async (args, extra) => sessions.open(args, callOf(extra).signal).then(said, failed), LOAD),
        tool('group_summary',
          'Read the shared group summary (never other transcripts), or append a short decision. Main sessions write the high-level summary; children append decisions. On completing the assigned task, append a short report with report=true: it reaches the main session only while that tab is open.',
          { text: z.string().trim().min(1).max(16000).optional(), report: z.boolean().optional() },
          async (args) => sessions.summary(args.text, args.report).then(said, failed), LOAD),
        tool('session_message',
          'Send a follow-up to an open tarcsweb tab by the id returned by open_session. Use to coordinate the work the user asked to move. Busy tabs queue it; idle tabs start a turn. This addresses tabs, not subagents.',
          { session_id: z.string().min(1).max(200), message: z.string().trim().min(1).max(100000) },
          async (args) => sessions.message(args.session_id, args.message).then(said, failed), LOAD),
      ] : []),
      tool(
        'show_chart',
        'Show a chart in the conversation. Use for comparing numbers: bar (categories), line or area (a trend over labels), stat (a few headline numbers). labels name each point; each series has one value per label.',
        {
          type: z.enum(['bar', 'line', 'area', 'stat']),
          title: z.string().describe('Short title shown above the chart'),
          unit: z.string().optional().describe('Unit of the values, e.g. "s", "%", "ms"'),
          labels: z.array(z.string()).describe('One label per point or bar'),
          series: z.array(z.object({ name: z.string().optional(), values: z.array(z.number()) })).min(1).describe(`1-${CHART_MAX.series} series; more are cut`),
        },
        shown('chart', chartCuts),
        LOAD,
      ),
      tool(
        'show_table',
        'Show a table in the conversation. Use for facts that fit rows and columns. Cells are plain text; cells reading passed, failed or skipped get a status pill.',
        {
          title: z.string().describe('Short title shown above the table'),
          note: z.string().optional().describe('Short note on the right of the title, e.g. "46 tests · 3.2s"'),
          columns: z.array(z.string()),
          rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
          align: z.array(z.enum(['left', 'right', 'center'])).optional().describe('Per column; numbers align right by default'),
        },
        shown('table', tableCuts),
        LOAD,
      ),
      tool(
        'show_plan',
        'Show a step list with progress. Use for a plan of several steps; call it again with updated statuses as work moves on.',
        {
          title: z.string().optional(),
          steps: z.array(z.object({ text: z.string(), status: z.enum(['todo', 'doing', 'done']) })).min(1),
        },
        shown('plan', planCuts),
        LOAD,
      ),
      tool(
        'ask_round',
        'Ask the user 1-5 questions in one card and wait until they submit it. Use it for the questions a reply ends with, after the prose that explains them; the user never sees your thinking, so the explanation and any answer they asked for go in that prose, not in setup. Each answer is an option, a note, both, or unanswered; ask unanswered ones again in a later turn if they still matter, never decide them yourself. A text, number or path question takes one typed value and no options: an open answer, a name, a URL, a number; put your own answer in suggested when you have one.',
        {
          title: z.string().optional().describe('Short title of the round'),
          questions: z.array(z.object({
            title: z.string().describe('The question, short'),
            kind: z.enum(['choice', 'text', 'number', 'path']).optional().describe('choice (default) picks one of 2-4 options; text, number and path take one typed value'),
            setup: z.string().optional().describe('The situation that forces the decision, short'),
            options: z.array(z.object({ label: z.string(), description: z.string().optional() })).max(4).optional().describe('2-4 options; choice questions only'),
            placeholder: z.string().optional().describe('Hint inside the input of a text, number or path question'),
            suggested: z.string().optional().describe('Your suggested answer to a text, number or path question; shown with a button that fills it in, never prefilled. why explains it'),
            recommended: z.number().int().min(0).optional().describe('0-based index of the option you recommend; shown highlighted, never preselected'),
            why: z.string().optional().describe('One or two sentences on the recommended pick'),
          })).min(1).max(5),
        },
        async (args, extra) => {
          const bad = args.questions.findIndex((q) => roundKindOf(q.kind) === 'choice' && (q.options?.length ?? 0) < 2);
          if (bad >= 0) return failed(`Question ${bad + 1} is a choice question and needs 2-4 options; for one typed value set kind to text, number or path.`);
          // Typed questions carry no options, so the session's answer check allows only option null for them.
          const input = { ...args, questions: args.questions.map((q) => ({ ...q, options: roundKindOf(q.kind) === 'choice' ? q.options ?? [] : [] })) };
          const x = callOf(extra);
          const sent = await round(input, x.signal, x.id);
          if (sent === null) return NO_ANSWER;
          if (sent.picks.every((p) => p.option === null && !p.note.trim()) && !sent.extra.trim()) return said(SKIPPED);
          return { content: [{ type: 'text' as const, text: roundText(input, sent.picks, sent.extra) }] };
        },
        LOAD,
      ),
      tool(
        'ask_prototype',
        'Show an HTML prototype in a live card and wait until the user tunes or reacts to it and clicks Send; returns the values they set. Every input, select and textarea with a name attribute comes back (range and number as numbers, checkbox as true/false, radio as the checked value, others as text). For anything else, such as a drag path, call window.proto.set(key, value) from the page with a JSON value. Start every control at your own best guess. Same canvas as render_ui: width px by rows x 19 px. The user can also pin comments to elements of the page; they come back with a CSS selector for each element.\n\n'
          + 'For 2-4 directions, pass variants instead of html: the card shows them side by side, each page at its own width, and the user picks one. Values from each variant come back prefixed with its label ("B.speed").\n\n'
          + 'An approved prototype settles structure, copy and tuned values, never the finish. In a project with its own UI, pass its built CSS in styles and imitate its custom controls; name any raw control you keep in placeholders, so the user does not approve a look nobody will ship.\n\n'
          + 'Check before you show: a card you replace with a fixed version flashes on the user\'s screen and makes them answer twice. First call with check: true; it renders the page (each variant) in the background, returns the PNG path and problems (console errors, failed requests, content past the right edge), and shows no card. Read the PNG, fix, check again until it is right, then call once without check with that same HTML.',
        {
          html: z.string().optional().describe('A fragment or a full document, as for render_ui: inline <style>/<script>, CDN scripts and file:// URLs work. Required unless variants is given'),
          variants: z.array(z.object({
            label: z.string().describe('Short name shown above the variant, e.g. "A · Compact"'),
            html: z.string().describe('The variant\'s page, as for html'),
          })).min(2).max(PROTO_VARIANTS_MAX).optional().describe(`2-${PROTO_VARIANTS_MAX} pages shown side by side for the user to pick one; replaces html. width is each page's width`),
          placeholders: z.string().optional().describe('One short line naming what in the prototype will not ship as drawn, e.g. "native selects and date inputs stand in for the app\'s Select and DatePicker"'),
          styles: z.array(z.string()).max(PROTO_STYLES_MAX).optional().describe('Absolute paths of the project\'s .css files (tokens, a built stylesheet), linked before the page\'s own CSS. Plain CSS only: Tailwind or Sass sources are not compiled, and relative url() fonts or images inside them do not load (absolute file:// URLs do)'),
          question: z.string().optional().describe('One short line above the frame saying what to tune or pick'),
          title: z.string().optional().describe('Short title of the card'),
          width: z.number().optional().describe('Canvas width in px, 320-1800 (default 960)'),
          rows: z.number().optional().describe('Canvas height in rows of 19 px, 4-30 (default 20)'),
          check: z.boolean().optional().describe('Render in the background and report the PNG and problems without showing a card or waiting. Check first, then call once without it.'),
        },
        async (args, extra) => {
          const html = args.html ?? '';
          const variants = args.variants ?? [];
          if (!variants.length && !html.trim()) return failed('ask_prototype needs a non-empty `html` string, or `variants`.');
          if (variants.some((v) => !v.html.trim())) return failed('Every variant needs a non-empty `html` string.');
          if (new Set(variants.map((v) => v.label.trim())).size < variants.length) return failed('Variant labels must be unique.');
          const styles = args.styles ?? [];
          for (const p of styles) {
            if (!p.startsWith('/') || !p.toLowerCase().endsWith('.css')) return failed(`styles takes absolute paths of .css files: ${p}`);
            if (!(await stat(p).then((s) => s.isFile(), () => false))) return failed(`No such stylesheet: ${p}`);
          }
          if (args.check) {
            if (!variants.length) return renderUi({ ...args, html: withStyles(html, styles), interactive: true }, 'ask_prototype');
            const checks = await Promise.all(variants.map((v) => renderUi({ ...args, html: withStyles(v.html, styles), interactive: true }, 'ask_prototype')));
            return { content: checks.flatMap((c, i) => [{ type: 'text' as const, text: `Variant ${variants[i].label}:` }, ...c.content]), isError: checks.some((c) => 'isError' in c) };
          }
          const x = callOf(extra);
          const sent = await prototype({ title: args.title ?? '', question: args.question ?? '', html, variants }, x.signal, x.id);
          if (sent === null) return NO_ANSWER;
          if (!Object.keys(sent.values).length && !sent.note.trim() && !sent.variant && !sent.comments?.length) return said(SKIPPED);
          return said(protoText(sent));
        },
        LOAD,
      ),
      tool(
        'ask_checklist',
        'Show a checklist card and wait until the user ticks the items they want and clicks Send; returns every item marked ticked or not, plus an optional note. Use it for picks that are not mutually exclusive: what is left or next at the end of a task, a batch of cleanups or permissions (delete temp files, optional follow-ups). Work on the ticked items only. For a single-choice decision use ask_round.',
        {
          title: z.string().optional().describe('Short title of the card'),
          items: z.array(z.object({
            label: z.string().describe('The item, short'),
            note: z.string().optional().describe('One short line of detail'),
            recommended: z.boolean().optional().describe('Shown highlighted, never pre-ticked'),
          })).min(1).max(CHECKLIST_MAX).describe(`1-${CHECKLIST_MAX} items`),
        },
        async (args, extra) => {
          const x = callOf(extra);
          const sent = await checklist({ title: args.title ?? '', items: args.items }, x.signal, x.id);
          if (sent === null) return NO_ANSWER;
          if (!sent.ticked.length && !sent.note.trim()) return said(SKIPPED);
          return said(checklistText(args.items, sent.ticked, sent.note));
        },
        LOAD,
      ),
      tool(
        'show_image',
        'Show a local image file in the conversation as a card the user can open full size. Use it for a picture the user should look at (a screenshot, a generated asset, a chart image). Returns only a confirmation, not the picture.',
        {
          path: z.string().describe('Absolute path of a png, jpg, gif or webp file'),
          caption: z.string().optional().describe('Short caption shown above the picture'),
        },
        async (args) => showImage(args.path),
        LOAD,
      ),
      tool(
        'show_url',
        'Open a web page in the Browser panel for the user to look at and use, such as a local dev server or a docs page. Nothing from the page comes back to you; to read or test a page, use the browser tools instead.',
        { url: z.string().describe('Full http or https URL, e.g. http://localhost:5173') },
        async (args) => {
          const u = pageUrl(args.url);
          if (typeof u === 'string') return failed(u);
          try {
            await open(u.href);
          } catch (e) {
            return failed(`The Browser panel could not open the page: ${e instanceof Error ? e.message : String(e)}`);
          }
          return said(`Opened ${u.href} in the Browser panel.`);
        },
        LOAD,
      ),
      tool(
        'ask_upload',
        `Ask the user for files in a card with a drop zone and a file picker, and wait until they send or cancel. Takes images, PDFs and text files, up to ${ASK_UPLOAD_MAX}. Returns the absolute paths where the files were saved, with their names and sizes; read them from there. Use it when you need a file the user has (a screenshot, a log, a document), not for typed values.`,
        {
          prompt: z.string().describe('What you need and why, shown on the card'),
          accept: z.array(z.string()).max(20).optional().describe('Allowed types: extensions like ".png" or MIME patterns like "image/*"; omit to take any image, PDF or text file'),
        },
        async (args, extra) => askUpload(upload, args, extra),
        LOAD,
      ),
      tool(
        'codex_agent',
        'Start a Codex (OpenAI) coding agent in the background, like a background subagent. Returns its agent id at once; its final report arrives later as a task-notification, so do not poll or wait for it. Several can run in parallel. It runs under this tab\'s permission mode and reports its own progress.',
        {
          description: z.string().describe('Short name shown in the agents panel (3-6 words)'),
          prompt: z.string().describe('The whole task: Codex has none of this conversation, so include the goal, files, constraints and how to verify'),
          model: z.string().optional().describe('Codex model id, e.g. gpt-5.5; omit for the account default'),
          // The levels Codex models list in supportedReasoningEfforts; max and ultra exist on some models only.
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().describe('Reasoning effort; omit for the model default. max and ultra exist on some models only'),
          cwd: z.string().optional().describe('Working folder, absolute or relative to the session folder; defaults to the session folder'),
        },
        async (args, extra) => {
          try {
            return said(await codex.start(args, callOf(extra).id));
          } catch (e) {
            return failed(e);
          }
        },
        LOAD,
      ),
      tool(
        'codex_message',
        'Send a follow-up to a Codex agent started with codex_agent. A running agent gets it mid-turn; a finished one starts a new turn and reports again when done.',
        { agent_id: z.string().describe('The id codex_agent returned'), message: z.string() },
        async (args) => {
          try {
            return said(await codex.message(args.agent_id, args.message));
          } catch (e) {
            return failed(e);
          }
        },
        LOAD,
      ),
      tool(
        'codex_stop',
        'Stop a Codex agent started with codex_agent and close its thread.',
        { agent_id: z.string().describe('The id codex_agent returned') },
        async (args) => {
          try {
            return said(await codex.stop(args.agent_id));
          } catch (e) {
            return failed(e);
          }
        },
        LOAD,
      ),
      tool(
        'generate_image',
        'Generate raster images (illustrations, photos, mockups, icons, textures) with Codex\'s built-in image model, or edit/restyle local images given as references. Waits until the images are saved (usually 30-90s) while the chat shows progress and then the images; returns the saved paths, plus the images themselves only with look: true. Never overwrites a file. Each call spends the user\'s Codex image quota: one call per requested deliverable, no silent retries or variants.',
        {
          prompt: z.string().describe('The full image brief: subject, composition, style, palette, any exact text. With references, name them Image 1, Image 2… in the order given and say what each is for'),
          filename: z.string().optional().describe('File name for the result, e.g. "hero-banner.png"; defaults to one made from the prompt. A taken name gets -2, -3…'),
          output_dir: z.string().optional().describe('Folder to save into, absolute or relative to the session folder; defaults to "AI Images" on the user\'s desktop'),
          reference_images: z.array(z.string()).optional().describe('Absolute paths of local images to edit or use as references, in order'),
          count: z.number().int().min(1).max(IMAGE_COUNT_MAX).optional().describe('How many images to make (default 1); only when the user asked for several'),
          look: z.boolean().optional().describe('Return the pictures to you as well, to check or describe them (default false: paths only, the user still sees them)'),
        },
        async ({ look, ...args }, extra) => {
          try {
            return imageReply(await codex.image(args, callOf(extra).signal), look === true);
          } catch (e) {
            return failed(e);
          }
        },
        LOAD,
      ),
      tool(
        'browser_record',
        "Record a video of the Browser panel's active tab: the panel's own Chrome, which Playwright (panel), Chrome DevTools (panel) and Claude in Chrome drive. action start begins (the browser starts if needed); drive the page, then action stop saves the video and returns its path and length, and the user sees it in the chat. One recording at a time, up to 15 minutes; it follows tab switches and shows your mouse pointer and clicks.",
        {
          action: z.enum(['start', 'stop']),
          title: z.string().optional().describe('Short name for the file, e.g. "checkout flow"; start only'),
        },
        async (args) => record(args.action, args.title).catch(failed),
        LOAD,
      ),
      ...(claude ? claudeTools(claude) : []),
    ]).filter((t) => !omit.includes(t.name)),
  });
}
