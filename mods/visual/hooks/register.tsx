import type { EngineInterface, Register } from 'claude-code'

type Options = Parameters<Register>[1]

type Shot = {
  id: string
  png: string
  html: string
  columns: number
  rows: number
  width: number
  height: number
  durationMs: number
  title?: string
  // tarcsweb only: the page follows the app's theme and the PNG shows dark.
  themed?: boolean
}

type HelperEvent =
  | { ev: 'ready'; socket: string }
  | { ev: 'frame'; tag: string; file: string }
  | { ev: 'done'; tag: string }
  | { ev: 'error'; tag: string; message: string }

const TOOL = 'mcp__visual__render_ui'
// Cells the transcript spends left of a tool result (the `⎿` gutter), plus slack.
const INDENT = 6
const FALLBACK_COLUMNS = 120

const DESCRIPTION = `Render HTML as a picture inline in the transcript (the person's terminal shows real pixels).

Use it when a visual explains better than text: connected cards or flow diagrams, component or screen prototypes, side-by-side variants (e.g. three button versions; show states like normal/hover/pressed next to each other; only tarcsweb with \`interactive: true\` takes input), UI rebuilt from a local reference image, charts, and animations. Do not use it for short or yes/no answers, or when plain text, a table or a code block is enough.

Before the first explanatory visual of a session, load the \`visual:visual-explainer\` skill and follow its style (clean, thin lines, color tokens, motion rules). Component prototypes follow the design the person gives instead.

Effort follows intent: a component or screen the user wants to see as they imagine it is a fidelity job, so match it closely and take the time it needs; an explanation is a focus job, so cover it fully without ornaments. Never simplify a request just to finish sooner. Build the asked page count, variants, states and rows; never add unrequested ones. Write the HTML once and fix it with small edits. Draw a figure (SVG diagram, isometric figure, animation) only when the idea is spatial, changes over time, or is a structure that text plus a short code excerpt cannot show; then draw it: a figure that makes the mechanism click is worth the time. Never decoration, and at most one figure per picture. Motion only shows order or change, one animated sequence at most. Load only the skills this tool or the request names. Fix only what a reader would notice; for an explanation, at most 2 check rounds.

Canvas: \`width\` px (fit it to the content; it is drawn left-aligned, never stretched) by rows x 19 px (20 rows = 380 px); nothing scrolls. A light base style (white background, dark text, 16px body padding, 18px Atkinson Hyperlegible) comes first and your CSS overrides it. It also defines the page colors as CSS variables (\`--bg\`, \`--ink\`, \`--muted\`, \`--faint\`, \`--line\`, \`--tint\`, \`--accent\`, \`--bad\`); paint with them instead of hardcoded colors. The image sits next to ~15px terminal text: keep every text 16px or larger, and pick the library that fits the content (the skill has the table). Inline <style>/<script>, CDN scripts and styles (GSAP, Motion, Tailwind, Chart.js...), <canvas>, and local files by absolute file:// URL (e.g. images from image generation) all work.

With duration_ms > 0 the picture shows the page at that moment and gets a play button that replays the animation once in real time: start the animation on load and finish it by duration_ms.

The result lists console errors, page errors, failed requests and \`layout:\` lines for content past the canvas edge. It also gives the picture's id and PNG path, which you can Read to check the picture yourself. To fix a picture, call again with \`replace\` set to its id: in tarcsweb the new frame takes the old one's place, so the person never sees two.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'A full document or a fragment: free HTML, CSS and JS.' },
    width: {
      type: 'integer',
      minimum: 320,
      maximum: 1800,
      default: 960,
      description: 'Canvas width in px, fit to the content; capped at the terminal width.',
    },
    rows: { type: 'integer', minimum: 4, maximum: 30, default: 20, description: 'Height in terminal rows (19 px each).' },
    duration_ms: {
      type: 'integer',
      minimum: 0,
      maximum: 20000,
      default: 0,
      description: 'Animation length; 0 for a static picture.',
    },
    title: { type: 'string', description: 'Short caption shown beside the buttons.' },
    interactive: {
      type: 'boolean',
      default: false,
      description: 'tarcsweb only: the live frame takes mouse and touch (drag, click, sliders), for prototypes the person should try. The chat does not scroll over it.',
    },
    replace: { type: 'string', description: 'The id of an earlier render this call fixes; in tarcsweb the new frame takes its place.' },
  },
  required: ['html'],
  additionalProperties: false,
}

// tarcsweb (TARCSWEB=1) draws the frame live in a web page, so it gets the web wording.
const WEB_DESCRIPTION = `Render HTML as a picture inline in the conversation; in this web UI it runs live in the page.

Use it when a visual explains better than text: connected cards or flow diagrams, component or screen prototypes, side-by-side variants (show states like normal/hover/pressed next to each other; only \`interactive: true\` takes input), UI rebuilt from a local reference image, charts, and animations. Do not use it for short or yes/no answers, or when plain text, a table or a code block is enough.

Before the first explanatory visual of a session, load the \`visual-explainer\` skill and follow its style (clean, thin lines, color tokens, motion rules). Component prototypes follow the design the person gives instead.

Effort follows intent: a component or screen the user wants to see as they imagine it is a fidelity job, so match it closely and take the time it needs; an explanation is a focus job, so cover it fully without ornaments. Never simplify a request just to finish sooner. Build the asked page count, variants, states and rows; never add unrequested ones. Write the HTML once and fix it with small edits. Draw a figure (SVG diagram, isometric figure, animation) only when the idea is spatial, changes over time, or is a structure that text plus a short code excerpt cannot show; then draw it: a figure that makes the mechanism click is worth the time. Never decoration, and at most one figure per picture. Motion only shows order or change, one animated sequence at most. Load only the skills this tool or the request names. Fix only what a reader would notice; for an explanation, at most 2 check rounds.

Canvas: \`width\` px (fit it to the content) by rows x 19 px (20 rows = 380 px); nothing scrolls. A base style comes first and your CSS overrides it: 16px body padding, 18px Atkinson Hyperlegible, and the page colors as CSS variables that follow the app's light or dark theme: \`--bg\` (background), \`--ink\` (text, main strokes), \`--muted\`, \`--faint\`, \`--line\`, \`--tint\`, \`--accent\` and \`--bad\`. Paint everything with them and never redefine them or hardcode a color (hex, rgb, white, black): text, borders, SVG fills and strokes (\`fill: var(--ink)\`), chart options and \`<canvas>\` drawing (read them with getComputedStyle, again on the window's \`themechange\` event, and redraw). Text on an \`--ink\` or \`--accent\` fill uses \`--bg\`. A raster image keeps its own colors, so frame it with a 1px \`--line\` border instead of setting it on a white panel. Keep every text 16px or larger, and pick the library that fits the content (the skill has the table). Inline <style>/<script>, CDN scripts and styles (GSAP, Motion, Tailwind, Chart.js...), <canvas>, and local files by absolute file:// URL (e.g. images from image generation) all work.

With duration_ms > 0 the picture is an animation: start it on load and finish it by duration_ms.

The result lists console errors, page errors, failed requests and \`layout:\` lines for content past the canvas edge, the picture's id and the PNG path of a headless render, drawn in the dark theme.

Check before you show. Every call without \`check\` puts a frame in front of the person at once, so a draft you fix afterwards flashes on their screen and gets swapped. First call with \`check: true\`: it renders in the background, returns the PNG, the problems and a \`check_id\`, and shows nothing. Read the PNG, fix, and check again, at most 2 check rounds; stop as soon as one is clean. Then call once without \`check\` and without \`html\`, passing \`from_check\` set to that \`check_id\`: the page is not written twice, and the other params default to the checked call's values. Use \`replace\` only for a change the person asks for after seeing the picture: the new frame takes the old one's place.`

// No required list: html or from_check, and the tool call checks that one of them is there.
const { required: _required, ...OPEN_SCHEMA } = INPUT_SCHEMA
const WEB_INPUT_SCHEMA = {
  ...OPEN_SCHEMA,
  properties: {
    ...INPUT_SCHEMA.properties,
    html: { type: 'string', description: 'A full document or a fragment: free HTML, CSS and JS. Leave it out with from_check.' },
    from_check: { type: 'string', description: 'The check_id of an earlier check: true call: shows that page without sending its HTML again. Params given here override the checked ones.' },
    width: { ...INPUT_SCHEMA.properties.width, description: 'Canvas width in px, fit to the content.' },
    rows: { ...INPUT_SCHEMA.properties.rows, description: 'Height in rows (19 px each).' },
    title: { type: 'string', description: 'Short caption shown with the picture.' },
    interactive: {
      ...INPUT_SCHEMA.properties.interactive,
      description: 'The live frame takes mouse and touch (drag, click, sliders), for prototypes the person should try. The chat does not scroll over it.',
    },
    replace: { type: 'string', description: 'The id of an earlier shown render this call changes, after the person saw it; the new frame takes its place.' },
    check: { type: 'boolean', default: false, description: 'Render in the background and report the PNG, problems and a check_id without showing anything. Check first, then call once without it, passing from_check, to show the final version.' },
  },
}

const shots = new Map<string, Shot>()
// Checked renders by check_id, so a show passes from_check instead of writing the HTML again; the newest CHECKS_MAX stay.
const checks = new Map<string, { input: Record<string, unknown>; shot: Shot; problems: string[] }>()
const CHECKS_MAX = 30
const phase = new Map<string, 'playing' | 'played'>()
let helper: Promise<string> | undefined
let viewColumns: number | undefined

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function startHelper($: EngineInterface, options: Options): Promise<string> {
  helper ??= new Promise<string>((resolve, reject) => void pump($, options, resolve, reject))
  return helper
}

// Runs the helper for as long as it lives, turning its stdout lines into blits.
async function pump($: EngineInterface, options: Options, resolve: (socket: string) => void, reject: (error: Error) => void) {
  const chromium = String(options.chromium ?? '').trim()
  const env: Record<string, string> = chromium === '' ? {} : { VISUAL_CHROMIUM: chromium }
  let pending = ''
  try {
    const node = String(options.node ?? '').trim() || 'node'
    const child = $.process.spawn({ argv: [node, `${$.plugin.root}/helper/server.mjs`], env })
    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        $.ui.log(`visual helper: ${chunk.text.trim()}`, { to: 'debug' })
        continue
      }
      pending += chunk.text
      let end = pending.indexOf('\n')
      while (end !== -1) {
        handle($, pending.slice(0, end), resolve)
        pending = pending.slice(end + 1)
        end = pending.indexOf('\n')
      }
    }
    reject(new Error('the visual helper exited before it was ready'))
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)))
  } finally {
    helper = undefined
    for (const [tag, state] of phase) if (state === 'playing') phase.set(tag, 'played')
    $.ui.invalidate('ui.render')
  }
}

function handle($: EngineInterface, line: string, resolve: (socket: string) => void) {
  let event: HelperEvent
  try {
    event = JSON.parse(line) as HelperEvent
  } catch {
    return
  }
  if (event.ev === 'ready') return resolve(event.socket)
  if (event.ev === 'frame') {
    void $.ui.blit({ requestId: event.tag, key: 'view', source: { file: event.file, format: 'png' } }).catch(() => {})
    return
  }
  if (event.ev === 'error') $.ui.log(`visual: replay failed: ${event.message}`, { to: 'debug' })
  const shot = shots.get(event.tag)
  if (shot) void $.ui.blit({ requestId: event.tag, key: 'view', source: { file: shot.png, format: 'png' } }).catch(() => {})
  phase.set(event.tag, 'played')
  $.ui.invalidate('ui.render')
}

async function post($: EngineInterface, socket: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await $.http.fetch(`http://visual${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socket,
  })
  const parsed = JSON.parse(response.text) as Record<string, unknown>
  if (parsed.ok !== true) throw new Error(String(parsed.error ?? `HTTP ${response.status}`))
  return parsed
}

async function play($: EngineInterface, options: Options, tag: string) {
  const shot = shots.get(tag)
  if (!shot || phase.get(tag) === 'playing') return
  phase.set(tag, 'playing')
  $.ui.invalidate('ui.render')
  try {
    const socket = await startHelper($, options)
    // The helper plays <id>.html; a show reusing a check keeps the check's file under its own id.
    const file = shot.html.slice(shot.html.lastIndexOf('/') + 1).replace(/\.html$/, '')
    await post($, socket, '/play', { id: file, tag, width: shot.width, height: shot.height, durationMs: shot.durationMs })
    // A replay whose `done` never arrives must not leave the button stuck.
    $.clock.after(shot.durationMs + 15_000, () => {
      if (phase.get(tag) !== 'playing') return
      phase.set(tag, 'played')
      $.ui.invalidate('ui.render')
    })
  } catch (error) {
    phase.delete(tag)
    $.ui.invalidate('ui.render')
    $.ui.toast(`visual: could not play (${String(error)})`)
  }
}

const OPEN_CMD = 'if [ "$(uname -s)" = Darwin ]; then open "$1"; else setsid -f xdg-open "$1"; fi >/dev/null 2>&1'

async function open($: EngineInterface, html: string) {
  // Detached, so the browser xdg-open may start never holds this call open. macOS `open` returns by itself.
  const result = await $.process
    .run(['sh', '-c', OPEN_CMD, 'sh', html], { timeoutMs: 5000 })
    .catch(() => undefined)
  if (result?.exitCode !== 0) $.ui.toast(`visual: could not open ${html}`)
}

// After a reload or resume the map is empty; the result text carries what we need.
function recover(tag: string, output: unknown): Shot | undefined {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const id = /\bid: ([\w.-]+)/.exec(text)?.[1]
  const png = /\bpng: (\/[^\s"\\]+\.png)/.exec(text)?.[1]
  const html = /\bhtml: (\/[^\s"\\]+\.html)/.exec(text)?.[1]
  const cells = /\bcells: (\d+)x(\d+)/.exec(text)
  const px = /\bpx: (\d+)x(\d+)/.exec(text)
  if (!id || !png || !html || !cells || !px) return undefined
  const shot: Shot = {
    id,
    png,
    html,
    columns: Number(cells[1]),
    rows: Number(cells[2]),
    width: Number(px[1]),
    height: Number(px[2]),
    durationMs: Number(/\bduration_ms: (\d+)/.exec(text)?.[1] ?? 0),
    title: /\btitle: (.+?)(?:\\n|\n|$)/.exec(text)?.[1],
  }
  shots.set(tag, shot)
  return shot
}

function report(shot: Shot, problems: string[], ms: number, check: boolean, reused = false) {
  const lines = [
    check
      ? `Checked in ${ms} ms; nothing was shown to the person. Read the PNG, fix and check again, or show it with one call without check and without html, passing from_check: "${shot.id}".`
      : reused
        ? 'Shown to the person under this call, from the checked render.'
        : `Rendered in ${ms} ms and shown to the person under this call.`,
    // A check has no frame to replace; check_id, not id, keeps recover() from drawing it in the terminal.
    check ? `check_id: ${shot.id}` : `id: ${shot.id}`,
    `cells: ${shot.columns}x${shot.rows}`,
    `px: ${shot.width}x${shot.height}`,
    `duration_ms: ${shot.durationMs}`,
    // tarcsweb reads this line back (server/tools.ts THEME_LINE), only right after duration_ms and before the page's own title.
    ...(shot.themed ? ["theme: auto (follows the app's light or dark theme; this PNG shows dark)"] : []),
    ...(shot.title ? [`title: ${shot.title}`] : []),
    `png: ${shot.png}`,
    `html: ${shot.html}`,
  ]
  if (problems.length === 0) lines.push('No console errors, page errors or failed requests.')
  else lines.push(`Problems (${problems.length}):`, ...problems.slice(0, 20).map(problem => `- ${problem.slice(0, 300)}`))
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const cellWidth = clamp(Number(options.cell_width), 4, 40, 9)
  const cellHeight = clamp(Number(options.cell_height), 8, 80, 19)

  on('session.start', async ($, e, next) => {
    const web = (await $.env.get('TARCSWEB')) === '1'
    await $.tool.register({ name: 'render_ui', description: web ? WEB_DESCRIPTION : DESCRIPTION, inputSchema: web ? WEB_INPUT_SCHEMA : INPUT_SCHEMA, isDeferred: false })
    // Drop renders older than 7 days; a resumed old session loses those pictures.
    const prune = $.process.spawn({ argv: ['sh', '-c', 'find "$HOME/.cache/visual" -maxdepth 1 -type f -mtime +7 -delete'] })
    void (async () => { for await (const _ of prune) {} })().catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const running = helper
    helper = undefined
    const socket = running && (await running.catch(() => undefined))
    if (socket) await post($, socket, '/quit', {}).catch(() => {})
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    let input = e as unknown as Record<string, unknown>
    const web = (await $.env.get('TARCSWEB')) === '1'
    const fromId = web && typeof input.from_check === 'string' ? input.from_check : undefined
    const from = fromId === undefined ? undefined : checks.get(fromId)
    if (fromId !== undefined && !from) return { deny: `No check with check_id ${fromId} in this session; call again with html.` }
    // The checked call's params, overridden by the ones this call gives; check never carries over.
    if (from) input = { ...from.input, ...input, check: input.check }
    if (typeof input.html !== 'string' || input.html.trim() === '') return { deny: `render_ui needs a non-empty \`html\` string${web ? ', or from_check' : ''}.` }
    // tarcsweb scales the frame to fit the chat, so the PNG keeps the asked width just like the frame.
    const room = web ? 255 : clamp((viewColumns ?? FALLBACK_COLUMNS) - INDENT, 20, 255, FALLBACK_COLUMNS)
    const columns = Math.min(room, Math.ceil(clamp(input.width, 320, 1800, 960) / cellWidth))
    const rows = clamp(input.rows, 4, 30, 20)
    const durationMs = clamp(input.duration_ms, 0, 20000, 0)
    const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim().slice(0, 80) : undefined
    const id = `${Date.now().toString(36)}-${e.tool_use_id.slice(-8).replace(/[^\w-]/g, '')}`
    const width = columns * cellWidth
    const height = rows * cellHeight
    const check = web && input.check === true
    // Same page and canvas as the check: show its render as is, under a fresh id so a later replace finds this frame.
    const same = from && from.input.html === input.html && from.shot.columns === columns && from.shot.rows === rows
      && from.shot.durationMs === durationMs && (from.input.interactive === true) === (input.interactive === true)
    if (same && !check) {
      const shot = { ...from.shot, id, title }
      shots.set(e.tool_use_id, shot)
      return { result: report(shot, from.problems, 0, false, true) }
    }
    try {
      const socket = await startHelper($, options)
      // Content past the canvas edge comes back as problems, so a clipped picture is caught without reading the PNG.
      const checkLayout = { bottom: input.interactive !== true }
      // The mod cannot see which theme tarcsweb shows, so its renders use dark, the app's default; the terminal stays light.
      const theme = web ? { theme: 'dark' } : {}
      const done = await post($, socket, '/render', { id, html: input.html, title, width, height, durationMs, checkLayout, ...theme })
      const shot: Shot = { id, png: String(done.png), html: String(done.html), columns, rows, width, height, durationMs, title, themed: web }
      const problems = Array.isArray(done.problems) ? done.problems.map(String) : []
      if (!check) shots.set(e.tool_use_id, shot)
      else {
        const { tool_use_id: _, ...asked } = input
        checks.set(id, { input: asked, shot, problems })
        if (checks.size > CHECKS_MAX) checks.delete(checks.keys().next().value!)
      }
      return { result: report(shot, problems, Number(done.ms), check) }
    } catch (error) {
      return { deny: `render_ui failed: ${String(error)}` }
    }
  }).catch(() => ({ deny: 'render_ui failed inside the visual mod; see the debug log.' }))

  // The tool call has no viewport; remember the width the prompt row last drew at.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.viewport) viewColumns = e.viewport.columns
    return next(e)
  })

  // The row header would print the whole HTML; show the caption instead.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | undefined
    if (!input || typeof input.html !== 'string') return next(e)
    const short = typeof input.title === 'string' && input.title !== '' ? { title: input.title } : { html: `${input.html.length} chars` }
    return next({ ...e, props: { ...e.props, input: short } })
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const shot = shots.get(e.requestId) ?? recover(e.requestId, e.props.output)
    if (!shot || !(await $.fs.exists(shot.png))) return next(e)
    if (e.viewport) viewColumns = e.viewport.columns
    const room = Math.max(10, (e.viewport?.columns ?? shot.columns + INDENT) - INDENT)
    const columns = Math.min(shot.columns, room)
    const rows = Math.max(1, Math.round((shot.rows * columns) / shot.columns))
    const state = phase.get(e.requestId)
    const tag = e.requestId
    const { Box, Button, Image, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Image
          key="view"
          source={{ file: shot.png, format: 'png' }}
          columns={columns}
          rows={rows}
          alt={`[visual${shot.title ? `: ${shot.title}` : ''}] ${shot.html}`}
        />
        <Box flexDirection="row" gap={1}>
          {shot.durationMs > 0 && (
            <Button
              key="play"
              label={state === 'playing' ? 'playing…' : state === 'played' ? '↻ replay' : '▶ play'}
              onPress={() => void play($, options, tag)}
            />
          )}
          <Button key="open" label="open" onPress={() => void open($, shot.html)} />
          {shot.title !== undefined && <Text dimColor>{shot.title}</Text>}
        </Box>
      </Box>
    )
  })
}
