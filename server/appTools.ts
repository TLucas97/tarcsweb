import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { APP_TOOLS, CODEX_TOOLS, roundText } from './tools.ts';
import type { RoundPick } from './protocol.ts';
import type { StartArgs } from './codex/agents.ts';
import type { ClaudeStartArgs } from './claudeAgents.ts';
import { IMAGE_COUNT_MAX, type ImageArgs, type ImageRun } from './codex/images.ts';

// The session side of ask_choice: resolves with the picked index, the user's own words, or null when the call was cancelled.
export type ChoiceBroker = (question: string, count: number, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<number | string | null>;
export type RoundInput = { title?: string; questions: { title: string; options: { label: string }[] }[] };
// The session side of ask_round: one pick per question, or null when the round was cancelled.
export type RoundBroker = (round: RoundInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<RoundPick[] | null>;
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
export type Brokers = { choose: ChoiceBroker; round: RoundBroker; codex: CodexBroker; claude?: ClaudeBroker };

const NO_ANSWER = { content: [{ type: 'text' as const, text: 'The user did not answer.' }], isError: true };
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

// Allowed without a prompt: a Codex agent asks for its own approvals under the tab's mode.
export const APP_TOOL_NAMES = [...Object.values(APP_TOOLS), ...Object.values(CODEX_TOOLS)];

// Past this size a picture goes back to the model as its path only.
const INLINE_MAX = 3_500_000;

// The text tools.ts reads back for the card ("Generated … in Ns.", "Saved: …"), plus each picture for the model to look at.
function imageReply(r: ImageRun) {
  const n = r.images.length;
  const lines = [
    `Generated ${n} image${n > 1 ? 's' : ''} in ${Math.round(r.ms / 1000)}s.${n < r.asked ? ` Codex returned ${n} of the ${r.asked} asked for.` : ''}`,
    ...r.images.map((i) => `Saved: ${i.path}${i.width && i.height ? ` (${i.width}x${i.height})` : ''}`),
    ...r.revised.map((p, i) => `Revised prompt${r.revised.length > 1 ? ` ${i + 1}` : ''}: ${p}`),
    'The user already sees the image in the chat.',
  ];
  const pics = r.images.filter((i) => i.data.length <= INLINE_MAX).map((i) => ({ type: 'image' as const, data: i.data.toString('base64'), mimeType: i.mime }));
  return { content: [{ type: 'text' as const, text: lines.join('\n') }, ...pics] };
}

// Loaded up front, so the model needs no ToolSearch round trip before a visual.
const LOAD = { alwaysLoad: true };
const shown = (what: string) => async () => ({ content: [{ type: 'text' as const, text: `Shown to the user as a ${what}.` }] });

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
export function appServer({ round, codex, claude }: Brokers, omit: string[] = []) {
  return createSdkMcpServer({
    name: 'app',
    version: '1.0.0',
    alwaysLoad: true,
    tools: ([
      tool(
        'show_chart',
        'Show a chart in the conversation. Use for comparing numbers: bar (categories), line or area (a trend over labels), stat (a few headline numbers). labels name each point; each series has one value per label.',
        {
          type: z.enum(['bar', 'line', 'area', 'stat']),
          title: z.string().describe('Short title shown above the chart'),
          unit: z.string().optional().describe('Unit of the values, e.g. "s", "%", "ms"'),
          labels: z.array(z.string()).describe('One label per point or bar'),
          series: z.array(z.object({ name: z.string().optional(), values: z.array(z.number()) })).min(1).max(4),
        },
        shown('chart'),
        LOAD,
      ),
      tool(
        'show_table',
        'Show a table in the conversation. Use for facts that fit rows and columns. Cells are plain text; cells reading passed, failed or skipped get a status pill.',
        {
          title: z.string().describe('Short title shown above the table'),
          note: z.string().optional().describe('Short note on the right of the title, e.g. "46 tests · 3.2s"'),
          columns: z.array(z.string()),
          rows: z.array(z.array(z.union([z.string(), z.number()]))),
          align: z.array(z.enum(['left', 'right', 'center'])).optional().describe('Per column; numbers align right by default'),
        },
        shown('table'),
        LOAD,
      ),
      tool(
        'show_plan',
        'Show a step list with progress. Use for a plan of several steps; call it again with updated statuses as work moves on.',
        {
          title: z.string().optional(),
          steps: z.array(z.object({ text: z.string(), status: z.enum(['todo', 'doing', 'done']) })).min(1),
        },
        shown('plan'),
        LOAD,
      ),
      tool(
        'ask_round',
        'Ask the user 1-5 questions in one card and wait until they submit it. Only for decisions already explained in prose; never in the same turn as an analysis the user asked for. Each answer is an option, a note, both, or unanswered; ask unanswered ones again next round if they still matter, never decide them yourself.',
        {
          title: z.string().optional().describe('Short title of the round'),
          questions: z.array(z.object({
            title: z.string().describe('The question, short'),
            setup: z.string().optional().describe('The situation that forces the decision, short'),
            options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
            recommended: z.number().int().min(0).optional().describe('0-based index of the option you recommend; shown highlighted, never preselected'),
            why: z.string().optional().describe('One or two sentences on the recommended pick'),
          })).min(1).max(5),
        },
        async (args, extra) => {
          const x = callOf(extra);
          const picks = await round(args, x.signal, x.id);
          if (picks === null) return NO_ANSWER;
          if (picks.every((p) => p.option === null && !p.note.trim())) return said(SKIPPED);
          return { content: [{ type: 'text' as const, text: roundText(args, picks) }] };
        },
        LOAD,
      ),
      tool(
        'codex_agent',
        'Start a Codex (OpenAI) coding agent in the background, like a background subagent. Returns its agent id at once; its final report arrives later as a task-notification, so do not poll or wait for it. Several can run in parallel. It runs under this tab\'s permission mode and reports its own progress.',
        {
          description: z.string().describe('Short name shown in the agents panel (3-6 words)'),
          prompt: z.string().describe('The whole task: Codex has none of this conversation, so include the goal, files, constraints and how to verify'),
          model: z.string().optional().describe('Codex model id, e.g. gpt-5.5; omit for the account default'),
          effort: z.string().optional().describe('Reasoning effort, e.g. low, medium, high, xhigh; omit for the model default'),
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
        'Generate raster images (illustrations, photos, mockups, icons, textures) with Codex\'s built-in image model, or edit/restyle local images given as references. Waits until the images are saved (usually 30-90s) while the chat shows progress and then the images; returns the saved paths and the images. Never overwrites a file. Each call spends the user\'s Codex image quota: one call per requested deliverable, no silent retries or variants.',
        {
          prompt: z.string().describe('The full image brief: subject, composition, style, palette, any exact text. With references, name them Image 1, Image 2… in the order given and say what each is for'),
          filename: z.string().optional().describe('File name for the result, e.g. "hero-banner.png"; defaults to one made from the prompt. A taken name gets -2, -3…'),
          output_dir: z.string().optional().describe('Folder to save into, absolute or relative to the session folder; defaults to "AI Images" on the user\'s desktop'),
          reference_images: z.array(z.string()).optional().describe('Absolute paths of local images to edit or use as references, in order'),
          count: z.number().int().min(1).max(IMAGE_COUNT_MAX).optional().describe('How many images to make (default 1); only when the user asked for several'),
        },
        async (args, extra) => {
          try {
            return imageReply(await codex.image(args, callOf(extra).signal));
          } catch (e) {
            return failed(e);
          }
        },
        LOAD,
      ),
      ...(claude ? claudeTools(claude) : []),
    ]).filter((t) => !omit.includes(t.name)),
  });
}
