// The mod's helper: HTTP over a Unix socket in, JSON lines on stdout out.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { CACHE, Renderer } from './renderer.mjs'

const renderer = new Renderer({ chromium: process.env.VISUAL_CHROMIUM || undefined })
const socket = join(process.env.XDG_RUNTIME_DIR || CACHE, `visual-${process.pid}.sock`)
const parent = process.ppid
let playing

const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)

async function quit() {
  playing?.abort()
  await renderer.stop()
  rmSync(socket, { force: true })
  const leftovers = existsSync(CACHE) ? readdirSync(CACHE).filter(name => name.endsWith('.frames')) : []
  for (const name of leftovers) rmSync(join(CACHE, name), { recursive: true, force: true })
  process.exit(0)
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  return body ? JSON.parse(body) : {}
}

function play(job) {
  playing?.abort()
  const controller = new AbortController()
  playing = controller
  renderer
    .play({
      ...job,
      signal: controller.signal,
      onFrame: (file, seq) => emit({ ev: 'frame', tag: job.tag, file, seq }),
    })
    .then(result => emit({ ev: 'done', tag: job.tag, frames: result.frames, ms: Math.round(result.ms) }))
    .catch(error => emit({ ev: 'error', tag: job.tag, message: String(error?.message ?? error) }))
    .finally(() => {
      if (playing === controller) playing = undefined
    })
}

const server = createServer(async (request, response) => {
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  try {
    const body = await readJson(request)
    if (request.url === '/render') {
      const started = performance.now()
      const result = await renderer.render(body)
      return reply(200, { ok: true, ...result, ms: Math.round(performance.now() - started) })
    }
    if (request.url === '/play') {
      play(body)
      return reply(202, { ok: true })
    }
    if (request.url === '/quit') {
      reply(200, { ok: true })
      return void setTimeout(quit, 10)
    }
    reply(404, { ok: false, error: `no route ${request.url}` })
  } catch (error) {
    reply(500, { ok: false, error: String(error?.message ?? error) })
  }
})

mkdirSync(dirname(socket), { recursive: true })
// Sockets of helpers that were killed outright are left behind; sweep them.
for (const name of readdirSync(dirname(socket))) {
  const pid = /^visual-(\d+)\.sock$/.exec(name)?.[1]
  if (!pid) continue
  try {
    process.kill(Number(pid), 0)
  } catch {
    rmSync(join(dirname(socket), name), { force: true })
  }
}
server.listen(socket, () => emit({ ev: 'ready', socket }))

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, quit)
process.stdout.on('error', quit)
// The engine kills us on unload; this covers it dying without doing so.
setInterval(() => process.ppid !== parent && quit(), 2000).unref()
