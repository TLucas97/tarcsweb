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

Before the first explanatory visual of a session, load the \`visual:visual-explainer\` skill and follow its style (white, clean, thin lines, motion rules). Component prototypes follow the design the person gives instead.

Canvas: \`width\` px (fit it to the content; it is drawn left-aligned, never stretched) by rows x 19 px (20 rows = 380 px); nothing scrolls. A light base style (white background, dark text, 16px body padding, 18px Atkinson Hyperlegible) comes first and your CSS overrides it. The image sits next to ~15px terminal text: keep every text 16px or larger, and pick the library that fits the content (the skill has the table). Inline <style>/<script>, CDN scripts and styles (GSAP, Motion, Tailwind, Chart.js...), <canvas>, and local files by absolute file:// URL (e.g. images from image generation) all work.

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

Before the first explanatory visual of a session, load the \`visual-explainer\` skill and follow its style (white, clean, thin lines, motion rules). Component prototypes follow the design the person gives instead.

Canvas: \`width\` px (fit it to the content) by rows x 19 px (20 rows = 380 px); nothing scrolls. A light base style (white background, dark text, 16px body padding, 18px Atkinson Hyperlegible) comes first and your CSS overrides it. Keep every text 16px or larger, and pick the library that fits the content (the skill has the table). Inline <style>/<script>, CDN scripts and styles (GSAP, Motion, Tailwind, Chart.js...), <canvas>, and local files by absolute file:// URL (e.g. images from image generation) all work.

With duration_ms > 0 the picture is an animation: start it on load and finish it by duration_ms.

The result lists console errors, page errors, failed requests and \`layout:\` lines for content past the canvas edge. It also gives the picture's id and the PNG path of a headless render, which you can Read to check the picture yourself. To fix a picture, call again with \`replace\` set to its id: the new frame takes the old one's place, so the person never sees two.`

const WEB_INPUT_SCHEMA = {
  ...INPUT_SCHEMA,
  properties: {
    ...INPUT_SCHEMA.properties,
    width: { ...INPUT_SCHEMA.properties.width, description: 'Canvas width in px, fit to the content.' },
    rows: { ...INPUT_SCHEMA.properties.rows, description: 'Height in rows (19 px each).' },
    title: { type: 'string', description: 'Short caption shown with the picture.' },
    interactive: {
      ...INPUT_SCHEMA.properties.interactive,
      description: 'The live frame takes mouse and touch (drag, click, sliders), for prototypes the person should try. The chat does not scroll over it.',
    },
    replace: { type: 'string', description: 'The id of an earlier render this call fixes; the new frame takes its place.' },
  },
}

const shots = new Map<string, Shot>()
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
    await post($, socket, '/play', { id: shot.id, tag, width: shot.width, height: shot.height, durationMs: shot.durationMs })
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

function report(shot: Shot, problems: string[], ms: number) {
  const lines = [
    `Rendered in ${ms} ms and shown to the person under this call.`,
    `id: ${shot.id}`,
    `cells: ${shot.columns}x${shot.rows}`,
    `px: ${shot.width}x${shot.height}`,
    `duration_ms: ${shot.durationMs}`,
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
    const input = e as unknown as Record<string, unknown>
    if (typeof input.html !== 'string' || input.html.trim() === '') return { deny: 'render_ui needs a non-empty `html` string.' }
    // tarcsweb scales the frame to fit the chat, so the PNG keeps the asked width just like the frame.
    const web = (await $.env.get('TARCSWEB')) === '1'
    const room = web ? 255 : clamp((viewColumns ?? FALLBACK_COLUMNS) - INDENT, 20, 255, FALLBACK_COLUMNS)
    const columns = Math.min(room, Math.ceil(clamp(input.width, 320, 1800, 960) / cellWidth))
    const rows = clamp(input.rows, 4, 30, 20)
    const durationMs = clamp(input.duration_ms, 0, 20000, 0)
    const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim().slice(0, 80) : undefined
    const id = `${Date.now().toString(36)}-${e.tool_use_id.slice(-8).replace(/[^\w-]/g, '')}`
    const width = columns * cellWidth
    const height = rows * cellHeight
    try {
      const socket = await startHelper($, options)
      // Content past the canvas edge comes back as problems, so a clipped picture is caught without reading the PNG.
      const checkLayout = { bottom: input.interactive !== true }
      const done = await post($, socket, '/render', { id, html: input.html, title, width, height, durationMs, checkLayout })
      const shot: Shot = { id, png: String(done.png), html: String(done.html), columns, rows, width, height, durationMs, title }
      shots.set(e.tool_use_id, shot)
      const problems = Array.isArray(done.problems) ? done.problems.map(String) : []
      return { result: report(shot, problems, Number(done.ms)) }
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
