import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ExplainEvent, ExplainTurn } from './protocol.ts';
import { CACHE_DIR, t } from './config.ts';

export const MAX_EXCERPT = 4000;
const MAX_TURNS_IN_PROMPT = 10;
const DRAWINGS = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'tarcsweb-explain') : join(CACHE_DIR, 'explain');
const SVG_FENCE = /```svg\n([\s\S]*?)```/;
const REVIEW_MS = 180_000;

// Prompts verbatim from the explica mod.
const REVIEWER_PROMPT = [
  'You review one diagram that explains a technical point to a layperson. You get the rendered PNG and its SVG source.',
  'Read the PNG first and look at it as the reader will. Then read the SVG.',
  'Check: text cut off or overlapping, labels not on the shape they name, arrows that do not touch what they connect, parts too small to read, a canvas with large empty areas, and anything that reads as decoration instead of meaning.',
  'If the drawing is fine, reply with exactly: OK',
  'Otherwise reply with the full corrected SVG inside a ```svg code fence and nothing else. Keep the same viewBox, the same content and the same meaning; fix only what you saw. Same rules as the source: static SVG, no CSS, no foreignObject, no images, no external fonts, sans-serif, font-size 22 or larger.',
].join('\n');

const L = t({
  en: { name: 'English', labels: 'English', either: 'A or B?', dunno: "I don't know" },
  'pt-BR': { name: 'Brazilian Portuguese', labels: 'Portuguese', either: 'A ou B?', dunno: 'não sei' },
});

const RULES = [
  `Answer in ${L.name}, to someone with zero background who must truly get it. Your only job here is to make this one point understood.`,
  'Use the simplest words possible. Very short sentences, one idea each. No jargon: if a technical term is unavoidable, say what it is in plain words first.',
  'The first sentence states what the point means, in plain words. Everything after it adds detail in decreasing importance, so a reader who stops early still has the point.',
  'Explain exactly how the thing works, so the reader can picture it happening: name who or what takes part, then what happens first and what happens next, as "X does Y to Z". Describe the real mechanism, not a metaphor for it.',
  'Cut everything that does not serve that one point: no intro, no recap, no side facts.',
  'An everyday comparison is optional, at most one. Use it only when it maps closely onto the mechanism and makes it click faster than the direct explanation. When you use one, say which part of it is which part of the real thing, and say where it stops matching. When none fits well, use none.',
  'The default is no drawing: most answers are words only. A drawing costs the reader time, so it must earn its place.',
  'Add one only when both hold: the point is a structure or a flow among 3 to 5 parts, a before and after, or a screen layout; and a reader would still be lost after the words alone. Never for a definition, a single fact, a yes or no, or a point two sentences already settle. When in doubt, no drawing.',
  'In a drawing, labels sit on the shapes they name, connected parts sit next to each other, and each arrow carries a verb. The text must not repeat what the drawing already shows.',
  'When the point is about a UI or a screen, the drawing is a small wireframe of the layout: boxes for the regions, a short label saying what goes in each.',
  'A drawing is one standalone SVG inside a ```svg code fence, after the text.',
  'Make the drawing as detailed as the idea needs, and no more: every shape and label must carry meaning. Show the real parts, their order (number the arrows when order matters), what moves between them and, when useful, a before and after side by side. No decoration.',
  'SVG rules: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 H" width="640" height="H"> with H between 360 and 640, chosen to fit the content without empty areas. White background, dark text, soft fills (2-5 colors) to tell regions apart.',
  'Allowed: g, defs, marker (for arrow heads), rect (rx for rounded corners), circle, ellipse, line, polyline, polygon, path, text, tspan. No CSS, no foreignObject, no images, no external fonts. font-family sans-serif, font-size 22 or larger, stroke-width 2 or 3.',
  `At most 16 shapes and 12 short labels in ${L.labels}. Keep every label inside the canvas, inside or beside its shape, and never overlapping. Leave room between parts. Escape & as &amp;.`,
  'At most 130 words outside the drawing. No preamble, no closing offer, do not continue the task.',
];

function promptFor(excerpt: string, turns: readonly ExplainTurn[], question: string) {
  const lines =
    excerpt === ''
      ? ['The user opened a side panel to get one point of this conversation explained. They selected no excerpt.']
      : ['The user selected the excerpt below from this conversation because they did not understand it.'];
  lines.push(...RULES, '');
  if (excerpt !== '') lines.push('<excerpt>', excerpt, '</excerpt>');

  if (turns.length > 0) {
    lines.push(
      '',
      'This is a follow-up in the side panel. What was said there so far:',
      '<side_conversation>',
    );
    for (const turn of turns.slice(-MAX_TURNS_IN_PROMPT)) {
      if (turn.question !== '') lines.push(`User: ${turn.question}`);
      lines.push(`You: ${turn.text}`);
    }
    lines.push(
      '</side_conversation>',
      'Answer the new message only. Do not repeat what the user already got.',
      'Answer a direct question directly, in 1 to 3 plain sentences.',
      'In a follow-up, add a drawing only when the user is clearly still lost and a new picture would show what the words did not.',
      'Ask a guiding question only when the user message shows a gap you can name and they already know part of the topic. Someone starting from zero gets the explanation, not a question.',
      `A guiding question covers one step from what they already know toward the point, and its answer separates the likely misreading from the right reading. Offer 2 or 3 concrete options when you can ("${L.either}").`,
      'Ask about the topic itself. A real-world comparison question is fine only when it fits well.',
      'One question per reply, at most 40 words besides the question, then stop and wait.',
      `Correct a wrong guess in one line. Never repeat a question that failed: make it narrower. After two wrong or "${L.dunno}" answers, stop asking and explain in two sentences.`,
      'At most 3 guiding rounds on one point.',
      'Never ask whether they understood. To check, ask them to say it in their own words, or to apply it to one short case.',
      'When they state the point correctly, confirm it in one bold sentence and stop. No new question.',
    );
  }

  if (question === '') {
    lines.push('', 'The user gave no question: explain the excerpt.');
  } else {
    lines.push('', 'The user says exactly what they did not get. Aim the whole answer at it:', '<question>', question, '</question>');
  }

  return lines.join('\n');
}

// rsvg-convert must accept the drawing, as in the mod; the PNG is what the reviewer looks at.
function rasterize(svg: string, file: string) {
  return writeFile(`${file}.svg`, svg).then(
    () => new Promise<boolean>((resolve) => {
      const child = spawn('rsvg-convert', ['-w', '960', '-b', 'white', `${file}.svg`, '-o', `${file}.png`], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    }),
    () => false,
  );
}

// The mod's reviewer subagent, as a one-shot Sonnet run that may only read the two files.
async function review(file: string, abort: AbortController): Promise<string | null> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const timer = setTimeout(() => abort.abort(), REVIEW_MS);
  const allowed = new Set([`${file}.png`, `${file}.svg`]);
  try {
    const q = query({
      prompt: `Rendered PNG: ${file}.png\nSVG source: ${file}.svg\nRead both and answer as instructed.`,
      options: {
        model: 'sonnet', systemPrompt: REVIEWER_PROMPT, tools: ['Read'], maxTurns: 4, settingSources: [], persistSession: false,
        strictMcpConfig: true, mcpServers: {}, cwd: DRAWINGS, env, abortController: abort, permissionMode: 'default',
        canUseTool: async (_name, input) =>
          allowed.has(String((input as { file_path?: unknown }).file_path))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Only the two drawing files may be read.' },
      },
    });
    for await (const m of q) if (m.type === 'result') return m.subtype === 'success' ? (SVG_FENCE.exec(m.result)?.[1] ?? null) : null;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const LIGHT_MODEL = 'claude-sonnet-5-5';
const LIGHT_MS = 90_000;

// The cheap path: Sonnet sees only the recent messages, with no settings, tools or CLAUDE.md to pay for.
export async function answerLight(recent: string, prompt: string, abort: AbortController): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const timer = setTimeout(() => abort.abort(), LIGHT_MS);
  try {
    const q = query({
      prompt: `The most recent messages of the conversation, oldest first:\n<conversation>\n${recent}\n</conversation>\n\n${prompt}`,
      options: {
        model: LIGHT_MODEL, systemPrompt: 'You explain one point of a conversation between a user and a coding assistant.', tools: [], allowedTools: [],
        maxTurns: 1, settingSources: [], persistSession: false, strictMcpConfig: true, mcpServers: {}, cwd: homedir(), env, abortController: abort,
      },
    });
    for await (const m of q) {
      if (m.type !== 'result') continue;
      if (m.subtype === 'success' && !m.is_error && m.result.trim()) return m.result;
      throw new Error(m.subtype === 'success' ? 'The answer came back empty' : m.subtype);
    }
    throw new Error(abort.signal.aborted ? 'Stopped' : 'No answer');
  } finally {
    clearTimeout(timer);
  }
}

export type ExplainRequest = { thread: string; excerpt: string; turns: ExplainTurn[]; question: string };
// A throwaway fork of the session that answers one prompt; throws with the reason when there is no answer.
export type Fork = (prompt: string, abort: AbortController) => Promise<string>;

// One question of the side conversation: the opening explanation or a follow-up. The text goes out first, the drawing after.
export async function explain(sessionId: string, req: ExplainRequest, fork: Fork, abort: AbortController, reply: (e: ExplainEvent) => void) {
  const index = req.turns.length;
  const base = { sessionId, thread: req.thread, index };
  let answer: string;
  try {
    answer = await fork(promptFor(req.excerpt.trim().slice(0, MAX_EXCERPT), req.turns, req.question.trim()), abort);
  } catch (err) {
    return reply({ type: 'explain-error', ...base, error: err instanceof Error ? err.message : String(err) });
  }
  const svg = SVG_FENCE.exec(answer)?.[1];
  reply({ type: 'explain-answer', ...base, text: answer.replace(SVG_FENCE, '').trim() });
  if (svg === undefined || abort.signal.aborted) return;

  // First version on screen right away; the reviewed one replaces it when ready.
  await mkdir(DRAWINGS, { recursive: true });
  const file = join(DRAWINGS, `${req.thread.replace(/[^\w-]/g, '').slice(0, 40)}-${index}`);
  try {
    if (!(await rasterize(svg, file))) return;
    reply({ type: 'explain-drawing', ...base, svg });
    const corrected = await review(file, abort);
    if (corrected === null || abort.signal.aborted) return;
    if (await rasterize(corrected, file)) reply({ type: 'explain-drawing', ...base, svg: corrected });
  } finally {
    await rm(`${file}.svg`, { force: true });
    await rm(`${file}.png`, { force: true });
  }
}
