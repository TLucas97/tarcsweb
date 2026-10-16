// Drives one headless Chromium over the CDP pipe: renders HTML to PNG files.
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

export const CACHE = join(homedir(), '.cache', 'visual')

const BASE_CSS = `:root{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:#ffffff;color:#1a1a1a;overflow:hidden}
body{padding:16px;font:18px/1.45 "Atkinson Hyperlegible",system-ui,sans-serif}`

// How much faster than real time a render runs an animation to its last frame.
const RATE = 16
const IDLE_MS = 120_000

// Scales the page's JS clocks by `rate` from the moment the document starts.
const timeShim = rate => `(() => {
  const k = ${rate}, perf = performance.now.bind(performance), p0 = perf()
  const dateNow = Date.now, d0 = dateNow()
  const scale = t => p0 + (t - p0) * k
  performance.now = () => scale(perf())
  Date.now = () => Math.round(d0 + (dateNow() - d0) * k)
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => raf(t => cb(scale(t)))
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window)
  window.setTimeout = (fn, ms = 0, ...a) => st(fn, ms / k, ...a)
  window.setInterval = (fn, ms = 0, ...a) => si(fn, ms / k, ...a)
})()`

// Holds the page's clocks still until `__visualGo()`, so a replay starts after loading, not during it.
const holdShim = `(() => {
  const perf = performance.now.bind(performance), dateNow = Date.now, p0 = perf(), d0 = dateNow()
  let start = null
  const now = () => (start === null ? p0 : p0 + perf() - start)
  performance.now = now
  Date.now = () => Math.round(d0 + now() - p0)
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => raf(() => cb(now()))
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window), held = []
  window.setTimeout = (fn, ms = 0, ...a) => (start === null ? held.push(() => st(fn, ms, ...a)) : st(fn, ms, ...a))
  window.setInterval = (fn, ms = 0, ...a) => (start === null ? held.push(() => si(fn, ms, ...a)) : si(fn, ms, ...a))
  window.__visualGo = () => {
    start = perf()
    document.getAnimations().forEach(a => { try { a.currentTime = 0 } catch {} })
    held.splice(0).forEach(run => run())
  }
})()`

// Lists content that spills past the page's right edge or out of a clipping box (and, with `bottom`, below the canvas).
const layoutCheck = ({ bottom = false } = {}) => `(() => {
  const out = [], hit = [], W = innerWidth, z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1
  const name = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map(c => '.' + c).join('')
  const sel = el => { const p = el.parentElement; return p && p !== document.body ? name(p) + ' > ' + name(el) : name(el) }
  const text = el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40).replace(/"/g, "'")
  const add = (el, px, why = '') => { hit.push(el); if (out.length < 5) out.push('layout: ' + sel(el) + ' overflows by ' + Math.round(px) + 'px' + why + ': "' + text(el) + '"') }
  const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false }
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= 5) break
    if (hit.some(h => h.contains(el)) || el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue
    const cs = getComputedStyle(el), r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) add(el, el.scrollWidth - el.clientWidth, ' (clipped)')
    else if (r.right > W + 1 && !clipped(el)) add(el, (r.right - W) / z)
  }
  const root = document.documentElement, body = document.body
  if (!hit.length && root.scrollWidth > root.clientWidth + 1) add(root, root.scrollWidth - root.clientWidth)
  if (${bottom} && body.scrollHeight > body.clientHeight + 1) out.push('layout: body overflows by ' + Math.round(body.scrollHeight - body.clientHeight) + 'px below the canvas')
  return out
})()`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PATH_NAMES = ['chrome-headless-shell', 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']
const FLATPAK_IDS = ['com.google.Chrome', 'org.chromium.Chromium']

// The newest Playwright build named `<kind>-<revision>` that holds one of `bins`.
function playwright(root, kind, ...bins) {
  const builds = existsSync(root)
    ? readdirSync(root)
        .map(name => new RegExp(`^${kind}-(\\d+)$`).exec(name))
        .filter(Boolean)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : []
  for (const [name] of builds) {
    for (const bin of bins) if (existsSync(join(root, name, bin))) return join(root, name, bin)
  }
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {}
  }
}

const flatpakInstalled = id =>
  [join(homedir(), '.local/share/flatpak/app', id, 'current'), join('/var/lib/flatpak/app', id, 'current')].some(dir => existsSync(dir))

// Full Chrome/Chromium needs --headless; chrome-headless-shell is headless already.
const local = bin => ({ command: bin, args: basename(bin) === 'chrome-headless-shell' ? [] : ['--headless'] })

// macOS: Playwright's cache lives in ~/Library/Caches, and browsers are app bundles rather than PATH commands.
function macChromium() {
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const testing = arch => `chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium']
  return (
    playwright(root, 'chromium_headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell') ??
    playwright(root, 'chromium', testing('arm64'), testing('x64'), 'chrome-mac/Chromium.app/Contents/MacOS/Chromium') ??
    ['/Applications', join(homedir(), 'Applications')].flatMap(dir => apps.map(app => join(dir, app))).find(path => existsSync(path))
  )
}

// How to start the browser: an explicit path, Playwright's cache, PATH, then Flatpak.
export function findChromium(explicit) {
  if (explicit) {
    if (existsSync(explicit)) return local(explicit)
    throw new Error(`Chromium not found at ${explicit} (the visual mod's chromium option or VISUAL_CHROMIUM)`)
  }
  if (process.platform === 'darwin') {
    const bin = macChromium()
    if (bin) return local(bin)
  }
  const root = join(homedir(), '.cache', 'ms-playwright')
  const bin =
    playwright(root, 'chromium_headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell') ??
    playwright(root, 'chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome') ??
    PATH_NAMES.map(onPath).find(Boolean)
  if (bin) return local(bin)
  // The sandbox sees only what it is granted: the cache read-write, the rest read-only for file:// assets.
  const id = onPath('flatpak') && FLATPAK_IDS.find(flatpakInstalled)
  if (id) return { command: 'flatpak', args: ['run', '--filesystem=host:ro', `--filesystem=${CACHE}`, id, '--headless'] }
  throw new Error(
    'No Chromium found for rendering. Install one (`npx playwright install chromium-headless-shell`, or a chromium or google-chrome package), ' +
      'or set VISUAL_CHROMIUM (or the visual mod\'s chromium option) to its path.',
  )
}

// The agent's HTML with the dark base stylesheet placed first, so its own CSS wins.
export function compose(html, title) {
  const head = `<meta charset="utf-8"><title>${(title ?? 'visual').replace(/</g, '&lt;')}</title><style id="visual-base">${BASE_CSS}</style>`
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, match => `${match}${head}`)
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, match => `${match}<head>${head}</head>`)
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

class Cdp {
  constructor(proc) {
    this.writer = proc.stdio[3]
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    let buffer = ''
    proc.stdio[4].on('data', chunk => {
      buffer += chunk.toString('utf8')
      let end
      while ((end = buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        this.dispatch(message)
      }
    })
  }

  dispatch(message) {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (!waiter) return
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`))
      else waiter.resolve(message.result)
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const body = { id, method, params }
    if (sessionId) body.sessionId = sessionId
    this.writer.write(`${JSON.stringify(body)}\0`)
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }

  // Resolves with the first event `method` on `sessionId`, or rejects after `ms`.
  wait(method, sessionId, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(`timed out waiting for ${method}`))
      }, ms)
      const listener = message => {
        if (message.method !== method || message.sessionId !== sessionId) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(message.params)
      }
      this.listeners.add(listener)
    })
  }

  failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

export class Renderer {
  constructor({ chromium } = {}) {
    this.chromiumPath = chromium
    this.proc = undefined
    this.cdp = undefined
    this.starting = undefined
  }

  get isRunning() {
    return this.proc !== undefined
  }

  start() {
    this.starting ??= this.launch().catch(error => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  async launch() {
    mkdirSync(CACHE, { recursive: true })
    const browser = findChromium(this.chromiumPath)
    const proc = spawn(
      browser.command,
      [
        ...browser.args,
        '--remote-debugging-pipe',
        `--user-data-dir=${join(CACHE, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        '--allow-file-access-from-files',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-extensions',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    )
    this.proc = proc
    this.cdp = new Cdp(proc)
    proc.on('exit', () => {
      this.cdp?.failAll(new Error('chromium exited'))
      this.proc = undefined
      this.cdp = undefined
      this.starting = undefined
    })
    await this.cdp.send('Browser.getVersion')
  }

  // A fresh page per job, so one render never inherits another's state.
  async openPage(width, height) {
    clearTimeout(this.idleTimer)
    await this.start()
    const cdp = this.cdp
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const problems = []
    const urls = new Map()
    const listener = message => {
      if (message.sessionId !== sessionId) return
      const p = message.params
      if (message.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
        problems.push(`console.${p.type}: ${p.args.map(arg => arg.value ?? arg.description ?? '').join(' ')}`)
      } else if (message.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails
        problems.push(`page error: ${d.exception?.description ?? d.text} (line ${d.lineNumber + 1})`)
      } else if (message.method === 'Network.requestWillBeSent') {
        urls.set(p.requestId, p.request.url)
      } else if (message.method === 'Network.loadingFailed' && !p.canceled) {
        problems.push(`request failed: ${urls.get(p.requestId) ?? p.requestId} (${p.errorText})`)
      } else if (message.method === 'Network.responseReceived' && p.response.status >= 400) {
        problems.push(`request failed: ${p.response.url} (HTTP ${p.response.status})`)
      }
    }
    cdp.listeners.add(listener)
    await Promise.all([
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId),
      cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } }, sessionId),
    ])
    this.open = (this.open ?? 0) + 1
    const close = async () => {
      cdp.listeners.delete(listener)
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      // Chromium holds ~200 MB per CLI; with no job for a while it exits and the next render relaunches it.
      if (--this.open === 0) this.idleTimer = setTimeout(() => this.stop(), IDLE_MS).unref()
    }
    return { cdp, sessionId, problems, close }
  }

  async load(page, file) {
    const { cdp, sessionId } = page
    const loaded = cdp.wait('Page.loadEventFired', sessionId, 10_000)
    await cdp.send('Page.navigate', { url: `file://${file}` }, sessionId)
    await loaded.catch(() => page.problems.push('page did not finish loading within 10 s'))
    await cdp
      .send('Runtime.evaluate', { expression: 'Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))])', awaitPromise: true }, sessionId)
      .catch(() => {})
  }

  // Runs the page's clocks `rate` times faster: CSS/WAAPI through the document
  // timeline, JS through a shim on performance.now, Date.now, rAF and timers.
  async speedUp(page, rate) {
    const { cdp, sessionId } = page
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: timeShim(rate) }, sessionId)
    await cdp.send('Animation.enable', {}, sessionId)
    await cdp.send('Animation.setPlaybackRate', { playbackRate: rate }, sessionId)
  }

  // The playback rate does not reliably reach CSS animations after navigation, so pin them at `ms`.
  async seek(page, ms) {
    const expression = `document.getAnimations().forEach(a => { try { if ((a.currentTime ?? 0) < ${ms}) a.currentTime = ${ms} } catch {} });
      new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
    await page.cdp.send('Runtime.evaluate', { expression, awaitPromise: true }, page.sessionId).catch(() => {})
  }

  async capture(page, path) {
    const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }, page.sessionId)
    writeFileSync(path, Buffer.from(data, 'base64'))
  }

  write(id, html, title) {
    mkdirSync(CACHE, { recursive: true })
    const file = join(CACHE, `${id}.html`)
    writeFileSync(file, compose(html, title))
    return file
  }

  // The settled page, or its state at `durationMs`, saved as `<id>.png`.
  async render({ id, html, title, width, height, durationMs, settleMs = 200, checkLayout }) {
    const file = this.write(id, html, title)
    const png = join(CACHE, `${id}.png`)
    const page = await this.openPage(width, height)
    try {
      if (durationMs > 0) await this.speedUp(page, RATE)
      await this.load(page, file)
      await sleep(Math.max(settleMs, (settleMs + durationMs) / RATE))
      if (durationMs > 0) await this.seek(page, durationMs)
      // Opt-in (the replay mod); measured on the final frame, so entrance motion is not flagged.
      if (checkLayout) {
        const found = await page.cdp
          .send('Runtime.evaluate', { expression: layoutCheck(checkLayout), returnByValue: true }, page.sessionId)
          .catch(error => ({ result: { value: [`layout check failed: ${error.message}`] } }))
        const failed = found.exceptionDetails && `layout check failed: ${found.exceptionDetails.exception?.description ?? found.exceptionDetails.text}`
        page.problems.push(...(failed ? [failed] : (found.result?.value ?? [])))
      }
      await this.capture(page, png)
      return { html: file, png, problems: [...new Set(page.problems)] }
    } finally {
      await page.close()
    }
  }

  // Replays in real time from a fresh load, streaming screencast frames as PNG files.
  async play({ id, width, height, durationMs, everyNthFrame = 1, tailMs = 300, onFrame, signal }) {
    const file = join(CACHE, `${id}.html`)
    const dir = join(CACHE, `${id}.frames`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const page = await this.openPage(width, height)
    const { cdp, sessionId } = page
    let seq = 0
    const listener = message => {
      if (message.method !== 'Page.screencastFrame' || message.sessionId !== sessionId) return
      const path = join(dir, `${String(seq++).padStart(5, '0')}.png`)
      writeFileSync(path, Buffer.from(message.params.data, 'base64'))
      onFrame(path, seq)
      cdp.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }, sessionId).catch(() => {})
    }
    try {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: holdShim }, sessionId)
      await this.load(page, file)
      cdp.listeners.add(listener)
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame }, sessionId)
      await cdp.send('Runtime.evaluate', { expression: '__visualGo()' }, sessionId).catch(() => {})
      const started = performance.now()
      while (!signal?.aborted && performance.now() - started < durationMs + tailMs) await sleep(25)
      await cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {})
      return { frames: seq, ms: performance.now() - started, dir }
    } finally {
      cdp.listeners.delete(listener)
      await page.close()
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 5000).unref()
    }
  }

  async stop() {
    const proc = this.proc
    if (!proc) return
    await this.cdp?.send('Browser.close').catch(() => {})
    const exited = new Promise(resolve => proc.once('exit', resolve))
    await Promise.race([exited, sleep(2000)])
    if (this.proc) proc.kill('SIGKILL')
  }
}
