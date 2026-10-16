import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { APP_TOOLS, OWN_WORDS, roundText } from './tools.ts';
import type { RoundPick } from './protocol.ts';

// The session side of ask_choice: resolves with the picked index, the user's own words, or null when the call was cancelled.
export type ChoiceBroker = (question: string, count: number, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<number | string | null>;
export type RoundInput = { title?: string; questions: { title: string; options: { label: string }[] }[] };
// The session side of ask_round: one pick per question, or null when the round was cancelled.
export type RoundBroker = (round: RoundInput, signal: AbortSignal | undefined, toolUseId: string | undefined) => Promise<RoundPick[] | null>;
export type Brokers = { choose: ChoiceBroker; round: RoundBroker };

const NO_ANSWER = { content: [{ type: 'text' as const, text: 'The user did not answer.' }], isError: true };
// The abort signal and tool_use id the SDK passes with a call.
const callOf = (extra: unknown) => {
  const x = (extra ?? {}) as { signal?: AbortSignal; _meta?: Record<string, unknown> };
  const id = x._meta?.['claudecode/toolUseId'];
  return { signal: x.signal, id: typeof id === 'string' ? id : undefined };
};

export const APP_TOOL_NAMES = Object.values(APP_TOOLS);

// Loaded up front, so the model needs no ToolSearch round trip before a visual.
const LOAD = { alwaysLoad: true };
const shown = (what: string) => async () => ({ content: [{ type: 'text' as const, text: `Shown to the user as a ${what}.` }] });

// The app's in-process MCP server ("app"); every input is rendered by the web UI, so the handlers only acknowledge.
export function appServer({ choose, round }: Brokers) {
  return createSdkMcpServer({
    name: 'app',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
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
        'ask_choice',
        'Ask the user to pick one option and wait for the click. Use only for a real decision you need before going on. Returns the chosen option.',
        {
          question: z.string(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(6),
        },
        async (args, extra) => {
          const x = callOf(extra);
          const index = await choose(args.question, args.options.length, x.signal, x.id);
          if (index === null) return NO_ANSWER;
          if (typeof index === 'string') return { content: [{ type: 'text' as const, text: `${OWN_WORDS}${index}` }] };
          return { content: [{ type: 'text' as const, text: `The user chose option ${index + 1}: ${args.options[index].label}` }] };
        },
        LOAD,
      ),
      tool(
        'ask_round',
        'Ask the user a round of 1-5 questions in one card and wait until they submit it. Use whenever you have 2 or more questions at once (one question → ask_choice). Each answer is an option, a note, both, or unanswered; ask unanswered ones again next round if they still matter, never decide them yourself.',
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
          return { content: [{ type: 'text' as const, text: roundText(args, picks) }] };
        },
        LOAD,
      ),
    ],
  });
}
