import type { EngineInterface, Register } from 'claude-code'

type Options = Parameters<Register>[1]

type Shot = { shot: string; png: string; html: string; width: number; height: number }

type Page = {
  id: string
  title: string
  source: string
  durationMs: number
  fixed?: { width: number; height: number }
  shot?: Shot
}

type Replay = { title: string; manifest: string; pages: Page[] }

type ManifestPage = { id?: unknown; title?: unknown; file?: unknown; width?: unknown; height?: unknown; duration_ms?: unknown }

type HelperEvent =
  | { ev: 'ready'; socket: string }
  | { ev: 'frame'; tag: string; file: string }
  | { ev: 'done'; tag: string }
  | { ev: 'error'; tag: string; message: string }

const PANE = 'replay'
const TOOL = 'mcp__replay__open'
const LAST = 'last-manifest'
// Rows around the picture: the info line, the keys, and a row of air on each side.
const CHROME = 4
// Every page lays out on this fixed canvas (CSS px); the pane only scales the picture.
const CANVAS = { width: 880, height: 800 }
// Rendered at this many pixels per CSS px, so a big pane stays sharp.
const SCALE = 1.5

const DESCRIPTION = `Open a visual replay of a change in a pane the person pages through with the keyboard (n next, p previous, r replay animation, o open in browser, q close).

Load the \`replay\` skill first: it says how to pick a format and write the pages. This tool only shows pages that already exist.

\`path\` is the absolute path of a replay.json manifest: { "title": string, "pages": [{ "id": "P1", "title": string, "file": "p1.html", "duration_ms"?: number }] }. Page files are relative to the manifest. Every page is laid out on a fixed 880x800 CSS px canvas (manifest \`width\`/\`height\` override it per page) and scaled to fit the pane, so design for that canvas (the skill says how). The result lists each page's PNG path and problems: console errors, failed requests, and \`layout:\` lines for content that overflows the page or a clipping box.

\`check: true\` renders and reports without showing the replay; use it to validate (Read the PNGs you doubt, fix, check again), then call once without \`check\` to show it. Every call without \`check\` shows the replay to the person again, so make that call once per replay.

\`page\` (1-based) opens at that page, for when the person asks about one (P3 = 3).`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path of the replay.json manifest.' },
    page: { type: 'integer', minimum: 1, description: 'Page to open at, 1-based. Default 1.' },
    check: {
      type: 'boolean',
      description: 'Render and report without showing the replay; use it to validate, then call once without check to show it.',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

let replay: Replay | undefined
let index = 0
let playing: string | undefined
let helper: Promise<string> | undefined
let generation = 0
let pass = 0
const cell = { width: 9, height: 19 }

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const resolvePath = (base: string, file: string) => (file.startsWith('/') ? file : `${base}/${file}`)
const current = () => replay?.pages[index]

function withZoom(source: string, zoom: number) {
  const style = `<style>:root{--replay-zoom:${zoom}}</style>`
  return /<head[\s>]/i.test(source) ? source.replace(/<head(\s[^>]*)?>/i, match => `${match}${style}`) : `${style}${source}`
}

function startHelper($: EngineInterface, options: Options): Promise<string> {
  helper ??= new Promise<string>((resolve, reject) => void pump($, options, resolve, reject))
  return helper
}

// Runs the visual helper for as long as it lives, turning its stdout lines into blits.
async function pump($: EngineInterface, options: Options, resolve: (socket: string) => void, reject: (error: Error) => void) {
  const chromium = String(options.chromium ?? '').trim()
  const env: Record<string, string> = chromium === '' ? {} : { VISUAL_CHROMIUM: chromium }
  let pending = ''
  try {
    const node = String(options.node ?? '').trim() || 'node'
    // The visual mod sits beside this one, in ~/.claude/mods and in the repo's mods/ alike.
    const script = String(options.helper ?? '').trim() || `${$.plugin.root}/../visual/helper/server.mjs`
    const child = $.process.spawn({ argv: [node, script], env })
    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        $.ui.log(`replay helper: ${chunk.text.trim()}`, { to: 'debug' })
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
    playing = undefined
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
  // Frames of a page the person already left, or of an older render, are dropped.
  const shot = current()?.shot
  if (!shot || event.tag !== shot.shot) return
  if (event.ev === 'frame') {
    void $.ui.blit({ requestId: PANE, key: shot.shot, source: { file: event.file, format: 'png' } }).catch(() => {})
    return
  }
  if (event.ev === 'error') $.ui.log(`replay: animation failed: ${event.message}`, { to: 'debug' })
  // A new generation, so the engine does not skip the still as equal to the tree's source.
  void $.ui.blit({ requestId: PANE, key: shot.shot, source: { file: shot.png, format: 'png', generation: ++generation } }).catch(() => {})
  playing = undefined
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

async function loadManifest($: EngineInterface, manifest: string): Promise<Replay> {
  const raw = JSON.parse(await $.fs.read(manifest)) as { title?: unknown; pages?: unknown }
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new Error('the manifest has no pages')
  const base = dirOf(manifest)
  const pages: Page[] = []
  for (const [i, entry] of (raw.pages as ManifestPage[]).entries()) {
    if (typeof entry.file !== 'string') throw new Error(`page ${i + 1} has no "file"`)
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : `P${i + 1}`
    const fixed =
      entry.width === undefined && entry.height === undefined
        ? undefined
        : { width: clamp(entry.width, 320, 1300, CANVAS.width), height: clamp(entry.height, 120, 1300, CANVAS.height) }
    pages.push({
      id,
      title: typeof entry.title === 'string' ? entry.title : id,
      source: await $.fs.read(resolvePath(base, entry.file)),
      durationMs: clamp(entry.duration_ms, 0, 20000, 0),
      fixed,
    })
  }
  return { title: typeof raw.title === 'string' ? raw.title : 'Replay', manifest, pages }
}

// Renders every page, `first` first; a newer call stops an older one. Only the shown replay redraws the pane.
async function renderPages($: EngineInterface, options: Options, target: Replay, first = index) {
  const shown = target === replay
  const run = shown ? ++pass : pass
  const socket = await startHelper($, options)
  const stamp = Date.now().toString(36)
  const report: string[] = []
  const order = [first, ...target.pages.keys()].filter((i, k, all) => all.indexOf(i) === k)
  for (const i of order) {
    if (shown && run !== pass) return report
    const page = target.pages[i]
    if (!page) continue
    const canvas = page.fixed ?? CANVAS
    const width = Math.round(canvas.width * SCALE)
    const height = Math.round(canvas.height * SCALE)
    const shot = `replay-${stamp}-${i + 1}`
    const html = withZoom(page.source, SCALE)
    // The bottom edge only binds the fixed terminal canvas; web pages may scroll.
    const checkLayout = { bottom: !page.fixed }
    const done = await post($, socket, '/render', { id: shot, html, title: page.title, width, height, durationMs: page.durationMs, checkLayout })
    page.shot = { shot, png: String(done.png), html: String(done.html), width, height }
    const problems = Array.isArray(done.problems) ? done.problems.map(String) : []
    report.push(`${page.id} ${page.title}: png ${String(done.png)}${problems.length ? `\n  ${problems.slice(0, 10).join('\n  ')}` : ''}`)
    if (shown && i === index) $.ui.invalidate('ui.render')
  }
  if (shown) $.ui.invalidate('ui.render')
  return report
}

async function play($: EngineInterface, options: Options) {
  const page = current()
  const shot = page?.shot
  if (!page || !shot || page.durationMs === 0) return
  playing = shot.shot
  $.ui.invalidate('ui.render')
  try {
    const socket = await startHelper($, options)
    await post($, socket, '/play', { id: shot.shot, tag: shot.shot, width: shot.width, height: shot.height, durationMs: page.durationMs })
    // A replay whose `done` never arrives must not leave the label stuck.
    $.clock.after(page.durationMs + 15_000, () => {
      if (playing !== shot.shot) return
      playing = undefined
      $.ui.invalidate('ui.render')
    })
  } catch (error) {
    playing = undefined
    $.ui.invalidate('ui.render')
    $.ui.toast(`replay: could not play (${String(error)})`)
  }
}

function go($: EngineInterface, options: Options, to: number) {
  if (!replay) return
  const next = Math.min(Math.max(to, 0), replay.pages.length - 1)
  if (next === index) return
  index = next
  playing = undefined
  $.ui.invalidate('ui.render')
  void play($, options)
}

async function show($: EngineInterface, options: Options, page: number) {
  if (!replay) return { isPlaced: false }
  index = Math.min(Math.max(page, 0), replay.pages.length - 1)
  const rows = Math.ceil(CANVAS.height / cell.height) + CHROME
  const opened = await $.ui.open({ id: PANE, title: replay.title, focus: true, closeOnEscape: true, rows })
  $.ui.invalidate('ui.render')
  void play($, options)
  return opened
}

async function browse($: EngineInterface, html: string) {
  // Detached, so the browser xdg-open may start never holds this call open.
  const result = await $.process
    .run(['sh', '-c', 'setsid -f xdg-open "$1" >/dev/null 2>&1', 'sh', html], { timeoutMs: 5000 })
    .catch(() => undefined)
  if (result?.exitCode !== 0) $.ui.toast(`replay: could not open ${html}`)
}

export const register: Register = (on, options) => {
  cell.width = clamp(Number(options.cell_width), 4, 40, 9)
  cell.height = clamp(Number(options.cell_height), 8, 80, 19)

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'open', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'replay', description: 'Reopen the last replay (/replay 3 opens at page 3)' })
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
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path.startsWith('/')) return { deny: 'replay needs `path`, the absolute path of a replay.json manifest.' }
    const size = `Canvas ${CANVAS.width}x${CANVAS.height} CSS px, PNGs at ${SCALE}x.`
    try {
      // A check leaves the shown replay, its page and the last-manifest record alone.
      if (input.check === true) {
        const checked = await loadManifest($, path)
        const report = await renderPages($, options, checked, 0)
        const next = 'Not shown. Fix the problems and the PNGs that look wrong, check again, then call once without check to show it.'
        return { result: [`Checked ${checked.pages.length} pages. ${size} ${next}`, ...report].join('\n') }
      }
      replay = await loadManifest($, path)
      index = clamp(input.page, 1, replay.pages.length, 1) - 1
      const report = await renderPages($, options, replay)
      await $.store.set(LAST, path)
      const opened = await show($, options, index)
      const where = opened.isPlaced
        ? 'The pane is open.'
        : 'The pane could not be placed yet; tell the person to type /replay to open it.'
      return { result: [`Rendered ${replay.pages.length} pages. ${size} ${where}`, ...report].join('\n') }
    } catch (error) {
      return { deny: `replay failed: ${String(error)}` }
    }
  }).catch(() => ({ deny: 'replay failed inside the replay mod; see the debug log.' }))

  on('command.run', { command: 'replay' }, async ($, e) => {
    const page = Number.parseInt(e.args.trim(), 10)
    if (!replay) {
      const last = await $.store.get(LAST)
      if (typeof last !== 'string') return { text: 'No replay yet. Ask the agent for one.' }
      try {
        replay = await loadManifest($, last)
        await renderPages($, options, replay)
      } catch (error) {
        return { text: `Could not reopen ${last}: ${String(error)}` }
      }
    }
    await show($, options, Number.isFinite(page) ? page - 1 : index)
    return { text: `Replay: ${replay.title}` }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    playing = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const page = current()
    if (!replay || !page) return <Text dimColor>No replay open.</Text>
    if (e.surface !== 'terminal') return <Text dimColor>The replay only renders in the terminal.</Text>
    const { Button, Image } = $.ui.resolve(e)

    const bodyRows = e.props.scroll?.bodyRows
    const roomColumns = Math.max(10, e.props.bodyColumns - 2)
    const roomRows = Math.max(4, (bodyRows ?? e.viewport?.rows ?? 40) - CHROME)

    const shot = page.shot
    const last = replay.pages.length - 1
    const isPlaying = playing === shot?.shot
    const dots = replay.pages.map((_, i) => (i === index ? '●' : '○')).join('')

    // Fit the picture in the room, width first, keeping its proportions.
    const ratio = shot ? (shot.height / shot.width) * (cell.width / cell.height) : 0.5
    let columns = roomColumns
    let rows = Math.round(columns * ratio)
    if (rows > roomRows) {
      rows = roomRows
      columns = Math.floor(rows / ratio)
    }

    // Docked, the column spans the body: info on top, the page centered, the keys at the bottom.
    return (
      <Box flexDirection="column" alignItems="center" height={e.props.placement === 'dock' && bodyRows ? bodyRows : undefined}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{page.id}</Text>
          <Text dimColor>
            {index + 1}/{replay.pages.length} {dots} {page.title}
          </Text>
        </Box>
        <Box flexGrow={1} />
        {shot ? (
          <Image key={shot.shot} source={{ file: shot.png, format: 'png' }} columns={columns} rows={rows} alt={`[${page.id}] ${page.title}`} />
        ) : (
          <Text dimColor>Rendering {page.id}…</Text>
        )}
        <Box flexGrow={1} />
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center">
          <Box flexDirection="row" gap={2}>
            <Button key="prev" plain hotkey="p" label="previous" dimColor={index === 0} onPress={() => go($, options, index - 1)} />
            <Button key="next" plain hotkey="n" label="next" dimColor={index === last} onPress={() => go($, options, index + 1)} />
            {page.durationMs > 0 && (
              <Button key="play" plain hotkey="r" label={isPlaying ? 'playing…' : 'play again'} onPress={() => void play($, options)} />
            )}
            {shot && <Button key="open" plain hotkey="o" label="open in browser" onPress={() => void browse($, shot.html)} />}
            <Button key="close" plain hotkey="q" label="close" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      </Box>
    )
  })
}
