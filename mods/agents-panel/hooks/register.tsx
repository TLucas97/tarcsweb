import type { AgentStatus, EngineInterface, Register } from 'claude-code'

type Kind = 'read' | 'edit' | 'create'
type FileHit = {
  path: string
  kind: Kind
  at: number
  added: number
  removed: number
  // First line of the last edit's new text, used to open the file at that line.
  snippet?: string
  conflicts: string[]
}

type Row = {
  id: string
  parentId?: string
  description: string
  type: string
  model: string
  effort?: string | number
  context: number
  status: AgentStatus
  isWaiting: boolean
  tools: number
  activity?: string
  startedAt: number
  endedAt?: number
  files: FileHit[]
  tasks?: { done: number; total: number }
  step?: string
  progressStartAt?: number
  // Steps already done when the panel first heard of the task; the average skips them.
  baseDone?: number
  isStoppedByYou?: boolean
  lastStepAt?: number
}

// A background shell, monitor or workflow some agent launched.
type Job = {
  id: string
  kind: 'shell' | 'monitor' | 'workflow'
  label: string
  owner: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  outputFile?: string
  last?: string
  lastTail?: string
  lastOutputAt?: number
  // Progress read off the newest line (`12/30` or `40%`), as a 0..1 ratio, and the first reading for the time left.
  ratio?: number
  ratioText?: string
  ratioBase?: { ratio: number; at: number }
  deadline?: number
  exitCode?: number
  // A synchronous subagent's background command dies with that subagent.
  endsWithOwner?: boolean
  isStoppedByYou?: boolean
}

const PANE = 'agents'
const MAIN = 'main'
const PROGRESS = 'mcp__agents-panel__progress'
const DONE: readonly AgentStatus[] = ['completed', 'failed', 'killed']
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const BAR_CELLS = 8
const TASK_CELLS = 10
const MINI_CELLS = 6
const CARD_FILES = 3
const FOCUS_FILES = 6
// Above this many agents the cards fold into one line each plus one focused timeline.
const MAX_CARDS = 3
const FRESH_MS = 10_000
const CONFLICT_MS = 5 * 60_000
const JOB_RECEIPTS = 3
const TAIL_EVERY_MS = 2000
const STALE_MS = 2 * 60_000
const STORE_PREFIX = 'jobs:'
// The terminal trims trailing spaces between Texts; a no-break space survives.
const NB = ' '

const PROGRESS_RULE = [
  'Progress reporting: when a task will take 3 or more steps, call mcp__agents-panel__progress',
  'once at the start with {task, total, done: 0, step} and again each time a step finishes (done + 1, next step).',
  'Send it in the same response as your next real tool call, never as a call on its own.',
  'Skip it for questions, chat and single-step work.',
].join(' ')

const GLYPH: Partial<Record<AgentStatus, [string, string]>> = {
  pending: ['○', 'subtle'],
  waiting: ['!', 'warning'],
  idle: ['◌', 'subtle'],
  completed: ['✔', 'success'],
  failed: ['✖', 'error'],
  killed: ['■', 'error'],
}

const KIND: Record<Kind, [string, string, string]> = {
  read: ['·', 'subtle', 'read'],
  edit: ['✎', 'warning', 'edited'],
  create: ['+', 'success', 'created'],
}

const FILE_TOOL: Record<string, Kind> = { Read: 'read', Edit: 'edit', NotebookEdit: 'edit', Write: 'edit' }

const VERB: Record<string, string> = {
  Read: 'reading',
  Grep: 'searching',
  Glob: 'searching',
  Bash: 'running',
  Edit: 'editing',
  Write: 'writing',
  NotebookEdit: 'editing',
  WebFetch: 'fetching',
  WebSearch: 'searching the web',
  Agent: 'starting agent',
  Skill: 'loading skill',
}

const isDone = (row: Row) => DONE.includes(row.status)
const nb = (text: string) => text.replace(/ /g, NB)
const lineCount = (text: unknown) => (typeof text === 'string' && text !== '' ? text.replace(/\n$/, '').split('\n').length : 0)

const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/\[1m\]$/i, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')

// Pre-4.6 models have a 200k window unless run with the [1m] suffix.
const windowOf = (model: string) =>
  /claude-(3|haiku-4|sonnet-4-[0-5]\b|opus-4-[0-5]\b)/.test(model) && !/\[1m\]/i.test(model) ? 200_000 : 1_000_000

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`
}

const age = (ms: number) => (ms < 3000 ? 'now' : elapsed(ms))
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const shortPath = (path: string) => path.split('/').slice(-2).join('/')
const sizeOf = (file: FileHit) => (file.added + file.removed === 0 ? '' : `+${file.added} −${file.removed}`)

const activityOf = (tool: string, input: Record<string, unknown>) => {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const path = pick('file_path') ?? pick('notebook_path')
  const target = path?.split('/').pop() ?? pick('pattern') ?? pick('description') ?? pick('command') ?? pick('url') ?? pick('query') ?? ''
  const verb = VERB[tool] ?? `using ${tool.replace(/^mcp__[^_]+__/, '')}`
  return clip(`${verb} ${target}`.trim(), 60)
}

// Time left from the average of the steps this panel saw finish; undefined until one did.
const etaOf = (row: Row, at: number) => {
  const { tasks, progressStartAt, lastStepAt } = row
  if (tasks === undefined || progressStartAt === undefined || lastStepAt === undefined) return undefined
  const seen = tasks.done - (row.baseDone ?? 0)
  if (seen <= 0 || tasks.done >= tasks.total || isDone(row)) return undefined
  const left = ((lastStepAt - progressStartAt) / seen) * (tasks.total - tasks.done) - (at - lastStepAt)
  if (!Number.isFinite(left) || left > 86_400_000) return undefined
  return left < 5000 ? 'almost done' : `~${elapsed(left)} left`
}

const newMain = (at: number): Row => ({
  id: MAIN,
  description: 'Main agent',
  type: 'main',
  model: '',
  context: 0,
  status: 'running',
  isWaiting: false,
  tools: 0,
  startedAt: at,
  files: [],
})

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

// The output's last visible line; a progress bar redraws with \r, so only its newest frame counts.
const lastLineOf = (text: string) =>
  stripAnsi(text)
    .split('\n')
    .map(line => line.split('\r').filter(part => part.trim() !== '').pop() ?? '')
    .filter(line => line.trim() !== '')
    .pop()
    ?.trim()

const rows = new Map<string, Row>()
const jobs = new Map<string, Job>()
let tailAt = 0
// The person's own open/closed choice per card; without one, a card closes when its agent ends.
const collapsed = new Map<string, boolean>()
const warned = new Set<string>()
let main = newMain(0)
// The main agent gets a card only once it edits a file or reports progress.
let isMainShown = false
let pinned: string | undefined
let narrowToastAt = 0
// tarcsweb draws its own agents panel and has no terminal to place this one in.
let isWeb = false
let cwd = ''
let now = 0
let frame = 0
let isOpen = false
let isPlaced = false
let ticker: { cancel: () => void } | undefined
let spinner: { cancel: () => void } | undefined

const shown = () => (isMainShown ? [main, ...rows.values()] : [...rows.values()])
const active = () => shown().filter(row => !isDone(row))
const rowOf = (agentId?: string) => (agentId === undefined ? main : rows.get(agentId))
const nameOf = (id: string) => (id === MAIN ? 'main' : (rows.get(id)?.description ?? 'another agent'))
const stopLabel = (row: Row) => (row.isStoppedByYou ? 'stopped by you' : 'interrupted')
const isCollapsed = (row: Row) => collapsed.get(row.id) ?? isDone(row)
const runningJobs = () => [...jobs.values()].filter(job => job.status === 'running')
const isBusy = () => active().length > 0 || runningJobs().length > 0

let sessionId = ''

// Kept per session in $.store so a reload of this mod still knows what it saw start.
async function saveJobs($: EngineInterface) {
  if (sessionId === '') return
  await $.store.set(`${STORE_PREFIX}${sessionId}`, { savedAt: now, jobs: [...jobs.values()] }).catch(() => undefined)
}

async function loadJobs($: EngineInterface) {
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const saved = (await $.store.get(key).catch(() => undefined)) as { savedAt?: number; jobs?: Job[] } | undefined
    if (key === `${STORE_PREFIX}${sessionId}`) {
      for (const job of saved?.jobs ?? []) if (!jobs.has(job.id)) jobs.set(job.id, job)
    } else if ((saved?.savedAt ?? 0) < now - 86_400_000) await $.store.delete(key).catch(() => undefined)
  }
}

function endJob($: EngineInterface, job: Job, status: Job['status'], exitCode?: number) {
  if (job.status !== 'running') return
  job.status = status
  job.endedAt = now
  job.exitCode = exitCode ?? job.exitCode
  if (status === 'failed') {
    const code = job.exitCode === undefined ? '' : ` (code ${job.exitCode})`
    $.ui.toast(`✖ background failed${code}: ${clip(job.label, 50)} · ${nameOf(job.owner)}`, { timeoutMs: 12_000 })
  }
  void saveJobs($)
}

// `12/30` or `40%` on the newest line becomes a bar; a percent wins when both show.
function readProgress(job: Job) {
  const line = job.last ?? ''
  const percent = line.match(/(\d{1,3}(?:[.,]\d+)?)\s?%/)
  const fraction = line.match(/(\d+)\s?\/\s?(\d+)/)
  let ratio: number | undefined
  let text: string | undefined
  if (percent !== null) {
    ratio = Number(percent[1]?.replace(',', '.')) / 100
    text = `${percent[1]}%`
  } else if (fraction !== null && Number(fraction[2]) > 0 && Number(fraction[1]) <= Number(fraction[2])) {
    ratio = Number(fraction[1]) / Number(fraction[2])
    text = `${fraction[1]}/${fraction[2]}`
  }
  if (ratio === undefined || !(ratio >= 0 && ratio <= 1)) return
  job.ratio = ratio
  job.ratioText = text
  if (job.ratioBase === undefined || ratio < job.ratioBase.ratio) job.ratioBase = { ratio, at: now }
}

const jobEta = (job: Job) => {
  const { ratio, ratioBase } = job
  if (ratio === undefined || ratioBase === undefined || ratio <= ratioBase.ratio || ratio >= 1) return undefined
  const left = ((now - ratioBase.at) / (ratio - ratioBase.ratio)) * (1 - ratio)
  return left < 5000 ? 'almost done' : `~${elapsed(left)} left`
}

// The engine keeps task logs in <tmp>/claude-<uid>/<project>/<session id>/tasks; the Bash result names only the id.
let tasksDir: string | undefined
async function findTasksDir($: EngineInterface) {
  if (tasksDir !== undefined || sessionId === '') return tasksDir
  for (const top of await $.fs.list('/tmp').catch(() => [])) {
    if (!top.name.startsWith('claude-')) continue
    for (const project of await $.fs.list(`/tmp/${top.name}`).catch(() => [])) {
      const dir = `/tmp/${top.name}/${project.name}/${sessionId}/tasks`
      if (await $.fs.exists(dir).catch(() => false)) return (tasksDir = dir)
    }
  }
  return undefined
}

async function outputOf($: EngineInterface, job: Job) {
  if (job.outputFile !== undefined || job.kind === 'workflow') return job.outputFile
  const dir = await findTasksDir($)
  const path = dir === undefined ? undefined : `${dir}/${job.id}.output`
  if (path !== undefined && (await $.fs.exists(path).catch(() => false))) job.outputFile = path
  return job.outputFile
}

// Reads each running shell's output tail: its newest line, and the end marker the engine writes on exit or kill.
async function tailJobs($: EngineInterface) {
  for (const job of runningJobs()) {
    const file = await outputOf($, job)
    if (file === undefined) continue
    const tail = await $.process
      .run(['tail', '-c', '4096', file], { timeoutMs: 2000 })
      .then(result => (result.exitCode === 0 ? result.stdout : undefined))
      .catch(() => undefined)
    if (tail === undefined) continue
    if (tail !== job.lastTail) {
      job.lastTail = tail
      job.lastOutputAt = now
    }
    const exit = tail.match(/\[exited with code (-?\d+)\]\s*$/)
    const killed = tail.match(/\[killed\]\s*$/)
    const end = exit ?? killed
    job.last = lastLineOf(end === null ? tail : tail.slice(0, end.index)) ?? job.last
    readProgress(job)
    if (exit !== null) endJob($, job, exit[1] === '0' ? 'completed' : 'failed', Number(exit[1]))
    else if (killed !== null) endJob($, job, 'killed')
  }
}

// One notification may carry several tasks; only an ending status closes a job, a monitor's event just updates its line.
function readNotifications($: EngineInterface, text: string) {
  for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = (name: string) => block[1]?.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
    const job = jobs.get(tag('task-id') ?? '')
    if (job === undefined) continue
    const status = tag('status')
    const summary = tag('summary')
    const code = summary?.match(/exit code (-?\d+)/)?.[1]
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      endJob($, job, status, code === undefined ? undefined : Number(code))
      continue
    }
    const event = tag('event') ?? summary
    if (event === undefined) continue
    job.last = clip(lastLineOf(event) ?? event, 200)
    job.lastOutputAt = now
    readProgress(job)
  }
  void saveJobs($)
}

function addJob($: EngineInterface, job: Job) {
  jobs.set(job.id, { ...job, lastOutputAt: job.startedAt })
  const ended = [...jobs.values()].filter(item => item.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const old of ended.slice(JOB_RECEIPTS)) jobs.delete(old.id)
  void saveJobs($)
  $.ui.invalidate('ui.render')
}

function stopTimers() {
  ticker?.cancel()
  spinner?.cancel()
  ticker = undefined
  spinner = undefined
}

async function sync($: EngineInterface) {
  now = await $.clock.now()
  for (const info of await $.agent.list()) {
    const row = rows.get(info.id)
    if (row === undefined) continue
    if (!isDone(row) && DONE.includes(info.status)) row.endedAt = now
    row.status = info.status
    row.parentId = info.parentId ?? row.parentId
  }
  for (const job of runningJobs()) {
    const owner = rows.get(job.owner)
    if (job.endsWithOwner && owner !== undefined && isDone(owner)) endJob($, job, 'killed')
  }
  if (now - tailAt >= TAIL_EVERY_MS) {
    tailAt = now
    await tailJobs($)
    if (runningJobs().length > 0) void saveJobs($)
  }
  const panes = await $.ui.panes()
  isPlaced = panes.some(pane => pane.id === PANE && pane.isPlaced)
  if (!isBusy()) stopTimers()
  $.ui.invalidate('ui.render')
}

function spin($: EngineInterface) {
  frame = (frame + 1) % SPINNER.length
  if (isOpen && isPlaced) $.ui.invalidate('ui.render')
}

async function show($: EngineInterface, isAsked: boolean) {
  // Ask the engine instead of trusting isOpen, so a pane the person closed, or one left as a hidden tab, comes back.
  const pane = (await $.ui.panes()).find(item => item.id === PANE)
  if (pane !== undefined && !isAsked && (!pane.isShown || !pane.isPlaced)) await $.ui.close({ id: PANE })
  if (!(isWeb && !isAsked) && (pane === undefined || isAsked || !pane.isShown || !pane.isPlaced)) {
    const opened = await $.ui.open({ id: PANE, title: 'Agents' })
    isOpen = true
    isPlaced = opened.isPlaced
    now = await $.clock.now()
    // The engine places an unasked pane only from 144 columns; say so at most once a minute.
    if (!opened.isPlaced && !isAsked && now - narrowToastAt > 60_000) {
      narrowToastAt = now
      $.ui.toast('agents: terminal too narrow to open the panel automatically, use /agents-panel', { timeoutMs: 8000 })
    }
  }
  if (!isBusy()) return
  ticker ??= $.clock.every(1000, () => void sync($))
  spinner ??= $.clock.every(120, () => spin($))
}

function touch($: EngineInterface, row: Row, path: string, kind: Kind, added: number, removed: number, snippet?: string) {
  // A file keeps one entry, moved to the newest; reading an edited file keeps it "edited".
  const old = row.files.find(file => file.path === path)
  const hit: FileHit = {
    path,
    kind: old !== undefined && old.kind !== 'read' && kind === 'read' ? old.kind : kind,
    at: now,
    added: (old?.added ?? 0) + added,
    removed: (old?.removed ?? 0) + removed,
    snippet: snippet ?? old?.snippet,
    conflicts: old?.conflicts ?? [],
  }
  row.files = [...row.files.filter(file => file.path !== path), hit].slice(-20)
  if (kind === 'read') return
  for (const other of [main, ...rows.values()]) {
    // An archived main card is the same agent, never a conflict.
    if (other === row || (other.type === 'main' && row.type === 'main')) continue
    const theirs = other.files.find(file => file.path === path && file.kind !== 'read' && now - file.at < CONFLICT_MS)
    if (theirs === undefined) continue
    if (!hit.conflicts.includes(other.id)) hit.conflicts.push(other.id)
    if (!theirs.conflicts.includes(row.id)) theirs.conflicts.push(row.id)
    const key = `${path}|${[row.id, other.id].sort().join('|')}`
    if (!warned.has(key)) {
      warned.add(key)
      $.ui.toast(`⚠ conflict: ${shortPath(path)} edited by ${nameOf(row.id)} and ${nameOf(other.id)}`, { timeoutMs: 12_000 })
    }
  }
}

async function openInEditor($: EngineInterface, file: FileHit) {
  const dir = file.path.slice(0, file.path.lastIndexOf('/')) || '/'
  const top = await $.process
    .run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
    .then(result => (result.exitCode === 0 ? result.stdout.trim() : undefined))
    .catch(() => undefined)
  let line = 1
  if (file.snippet !== undefined) {
    const text = await $.fs.read(file.path).catch(() => '')
    const index = text.indexOf(file.snippet)
    if (index >= 0) line = text.slice(0, index).split('\n').length
  }
  // Passing the project folder makes VS Code reuse (or open) that project's window.
  const opened = await $.process.run(['code', top ?? dir, '-g', `${file.path}:${line}`]).catch(() => undefined)
  if (opened === undefined || opened.exitCode !== 0) $.ui.toast('agents: could not open in VS Code', { timeoutMs: 6000 })
}

async function stopAgent($: EngineInterface, row: Row) {
  row.activity = 'stopping'
  row.isStoppedByYou = true
  $.ui.invalidate('ui.render')
  await $.tool.call({ tool: 'TaskStop', task_id: row.id }).catch(() => $.ui.toast(`agents: could not stop ${row.description}`, { timeoutMs: 6000 }))
}

// Opens the full output in VS Code; the log lives outside any project, so no folder is passed.
async function openLog($: EngineInterface, job: Job) {
  if (job.outputFile === undefined) return
  const opened = await $.process.run(['code', '-g', job.outputFile]).catch(() => undefined)
  if (opened === undefined || opened.exitCode !== 0) $.ui.toast('agents: could not open the log in VS Code', { timeoutMs: 6000 })
}

async function stopJob($: EngineInterface, job: Job) {
  job.isStoppedByYou = true
  job.last = 'stopping'
  $.ui.invalidate('ui.render')
  const stopped = await $.tool.call({ tool: 'TaskStop', task_id: job.id }).catch(() => undefined)
  if (stopped === undefined || stopped.deny !== undefined || stopped.isError === true) {
    job.isStoppedByYou = false
    $.ui.toast(`agents: could not stop ${clip(job.label, 40)}`, { timeoutMs: 6000 })
    return
  }
  now = await $.clock.now()
  endJob($, job, 'killed')
  $.ui.invalidate('ui.render')
}

// Records a background launch from the tool's own answer; anything run in the foreground is ignored.
function trackLaunch($: EngineInterface, tool: string, agentId: string | undefined, input: Record<string, unknown>, result: unknown) {
  const out = (result ?? {}) as Record<string, unknown>
  const text = (key: string, from: Record<string, unknown> = out) => (typeof from[key] === 'string' ? (from[key] as string) : undefined)
  const owner = agentId ?? MAIN
  const base = { owner, startedAt: now, status: 'running' as const }
  if (tool === 'Bash' && text('backgroundTaskId') !== undefined) {
    const command = (text('command', input) ?? '').replace(/\s+/g, ' ')
    addJob($, {
      ...base,
      id: text('backgroundTaskId') as string,
      kind: 'shell',
      label: text('description', input) ?? command,
      outputFile: text('stdout')?.match(/written to: (\S+?\.output)\b/)?.[1],
      endsWithOwner: out.backgroundEndsWithFinalResponse === true,
    })
  } else if (tool === 'Monitor' && text('taskId') !== undefined) {
    const timeout = Number(out.timeoutMs)
    addJob($, {
      ...base,
      id: text('taskId') as string,
      kind: 'monitor',
      label: text('description', input) ?? 'monitor',
      deadline: out.persistent === true || !(timeout > 0) ? undefined : now + timeout,
    })
  } else if (tool === 'Workflow' && text('taskId') !== undefined) {
    addJob($, { ...base, id: text('taskId') as string, kind: 'workflow', label: text('workflowName') ?? 'workflow' })
  } else return
  void show($, false)
}

function archiveMain() {
  const id = `${MAIN}-${main.startedAt}`
  rows.set(id, { ...main, id })
  if (collapsed.has(MAIN)) collapsed.set(id, collapsed.get(MAIN) ?? true)
  if (pinned === MAIN) pinned = id
}

// The [clear] button: drops every finished agent; running ones stay.
function clearDone($: EngineInterface) {
  for (const row of rows.values()) {
    if (!isDone(row)) continue
    rows.delete(row.id)
    collapsed.delete(row.id)
  }
  if (isDone(main)) {
    isMainShown = false
    collapsed.delete(MAIN)
  }
  for (const job of jobs.values()) if (job.status !== 'running') jobs.delete(job.id)
  void saveJobs($)
  if (pinned !== undefined && pinned !== MAIN && !rows.has(pinned)) pinned = undefined
  $.ui.invalidate('ui.render')
}

async function reportProgress($: EngineInterface, agentId: string | undefined, input: Record<string, unknown>) {
  const row = rowOf(agentId)
  if (row === undefined) return { result: 'ok' }
  now = await $.clock.now()
  const total = Number(input.total)
  const done = Number(input.done)
  const isNewTask = row.tasks === undefined || Number(input.done) === 0
  if (Number.isFinite(total) && total > 0) {
    const next = Math.min(total, Math.max(0, Number.isFinite(done) ? done : 0))
    if (row.tasks === undefined) {
      row.progressStartAt = now
      row.baseDone = next
    }
    if (next > (row.tasks?.done ?? 0)) row.lastStepAt = now
    row.tasks = { total, done: next }
  }
  if (typeof input.step === 'string') row.step = clip(input.step, 80)
  if (row === main) {
    if (typeof input.task === 'string' && input.task.trim() !== '') main.description = clip(input.task, 60)
    isMainShown = true
  }
  // Only a task's start reopens the pane, so a pane closed mid-task stays closed until the next one.
  if (isNewTask) await show($, false)
  $.ui.invalidate('ui.render')
  return { result: 'ok' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    isWeb = (await $.process.run(['printenv', 'TARCSWEB']).catch(() => undefined))?.stdout.trim() === '1'
    // A reload mid-task rebuilds the main card here, so its clock starts now and not at zero.
    if (main.startedAt === 0) main = newMain(await $.clock.now())
    now = await $.clock.now()
    sessionId = await $.session.id()
    await loadJobs($)
    if (runningJobs().length > 0) {
      ticker ??= $.clock.every(1000, () => void sync($))
      spinner ??= $.clock.every(120, () => spin($))
    }
    await $.command.register({ name: 'agents-panel', description: 'Show the agents panel' })
    await $.tool.register({
      name: 'progress',
      description:
        'Report task progress to the agents panel the user watches: the task, how many steps, how many are done, and the step now running. Cheap; batch it with your next real tool call.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Short task title, on the first call' },
          total: { type: 'integer', minimum: 1, description: 'Number of steps in the task' },
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far' },
          step: { type: 'string', description: 'The step running now, a few words' },
        },
        required: ['total', 'done', 'step'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'agents-panel:progress', text: PROGRESS_RULE, scope: 'session' }] }
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await show($, true)
    return { text: shown().length === 0 && jobs.size === 0 ? 'Nothing running right now' : 'Agents panel open' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next({ ...e, prompt: `${e.prompt}\n\n${PROGRESS_RULE}` })
    if (started.deny !== undefined || started.agentId === undefined) return started
    now = await $.clock.now()
    rows.set(started.agentId, {
      id: started.agentId,
      parentId: e.parentAgentId,
      description: e.description,
      type: e.subagentType,
      model: started.model,
      context: 0,
      status: 'running',
      isWaiting: false,
      tools: 0,
      activity: 'starting',
      startedAt: now,
      files: [],
    })
    await show($, false)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (main.status !== 'running') {
      main.status = 'running'
      main.endedAt = undefined
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      now = await $.clock.now()
      main.status = 'completed'
      main.endedAt = now
      main.isWaiting = false
      if (!isBusy()) stopTimers()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const row = rowOf(e.agentId)
    if (row !== undefined) row.activity = 'thinking'
    const response = yield* next(e)
    if (row !== undefined) {
      row.model = e.model
      row.effort = e.effort
      const usage = response.usage
      if (usage) {
        row.context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
      }
      $.ui.invalidate('ui.render')
    }
    return response
  })

  // An `ask` verdict means the agent now waits on the person.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const row = rowOf(e.agentId)
    if (row !== undefined && verdict.decision === 'ask') {
      row.isWaiting = true
      $.ui.invalidate('ui.render')
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    // Typed tool names come from the last reload, so this mod's own tool may not be in the union yet.
    if ((e.tool as string) === PROGRESS) return reportProgress($, e.agentId, input)
    if (e.tool === 'TaskStop') {
      const stopped = await next(e)
      const job = jobs.get(String(input.task_id ?? input.shell_id ?? ''))
      if (job !== undefined && stopped.deny === undefined && stopped.isError !== true) {
        now = await $.clock.now()
        endJob($, job, 'killed')
        $.ui.invalidate('ui.render')
      }
      return stopped
    }
    const row = rowOf(e.agentId)
    if (row === undefined) {
      // A workflow's agents have no card, but what they leave running still shows.
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        now = await $.clock.now()
        trackLaunch($, e.tool, e.agentId, input, ran.result)
      }
      return ran
    }
    const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    const path = raw === undefined || raw.startsWith('/') ? raw : `${cwd}/${raw}`
    let kind = path === undefined ? undefined : FILE_TOOL[e.tool]
    let added = 0
    let removed = 0
    let snippet: string | undefined
    if (path !== undefined && e.tool === 'Write') {
      const before = await $.fs.read(path).catch(() => undefined)
      if (before === undefined) kind = 'create'
      added = lineCount(input.content)
      removed = lineCount(before)
    } else if (e.tool === 'Edit') {
      added = lineCount(input.new_string)
      removed = lineCount(input.old_string)
      const first = typeof input.new_string === 'string' ? input.new_string.split('\n').find(line => line.trim() !== '') : undefined
      snippet = first === undefined ? undefined : first.slice(0, 200)
    } else if (e.tool === 'NotebookEdit') {
      added = lineCount(input.new_source)
    }
    row.tools += 1
    row.activity = activityOf(e.tool, input)
    $.ui.invalidate('ui.render')
    const ran = await next(e)
    row.isWaiting = false
    if (ran.deny === undefined && ran.isError !== true) {
      now = await $.clock.now()
      trackLaunch($, e.tool, e.agentId, input, ran.result)
    }
    if (kind !== undefined && path !== undefined && ran.deny === undefined && ran.isError !== true) {
      now = await $.clock.now()
      touch($, row, path, kind, added, removed, snippet)
      if (row === main && kind !== 'read' && !isMainShown) {
        isMainShown = true
        await show($, false)
      }
    }
    $.ui.invalidate('ui.render')
    return ran
  })

  // A new message keeps finished agents; a finished main card becomes a receipt and a fresh one waits for new work.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification' && jobs.size > 0) {
      now = await $.clock.now()
      readNotifications($, e.text)
      $.ui.invalidate('ui.render')
    }
    if (e.origin.kind === 'composer' && isDone(main)) {
      if (isMainShown) archiveMain()
      main = newMain(await $.clock.now())
      collapsed.delete(MAIN)
      isMainShown = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    isOpen = false
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (sessionId !== '') await $.store.delete(`${STORE_PREFIX}${sessionId}`).catch(() => undefined)
    rows.clear()
    jobs.clear()
    collapsed.clear()
    isMainShown = false
    stopTimers()
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    const running = active()
    const background = runningJobs().length
    if ((running.length === 0 && background === 0) || (isOpen && isPlaced)) return next(e)
    const waiting = running.filter(row => row.isWaiting || row.status === 'waiting').length
    const tail = [
      `agents: ${running.length} running`,
      waiting > 0 ? `${waiting} waiting for you` : undefined,
      background > 0 ? `${background} in background` : undefined,
    ]
      .filter(part => part !== undefined)
      .join(' · ')
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const subs = [...rows.values()].sort((a, b) => a.startedAt - b.startedAt)
    const childrenOf = (id?: string) =>
      subs.filter(row => (row.parentId !== undefined && rows.has(row.parentId) ? row.parentId : undefined) === id)

    // Each row gets its tree branch (head) and the guide its lines below hang on (cont).
    const ordered: { row: Row; head: string; cont: string; isRoot: boolean }[] = []
    if (isMainShown) ordered.push({ row: main, head: '', cont: '', isRoot: true })
    const walk = (id: string | undefined, cont: string) => {
      const kids = childrenOf(id)
      kids.forEach((row, index) => {
        const isLast = index === kids.length - 1
        const head = id === undefined ? '' : `${cont}${isLast ? '└─ ' : '├─ '}`
        const below = id === undefined ? '' : `${cont}${isLast ? '   ' : '│  '}`
        ordered.push({ row, head, cont: below, isRoot: id === undefined })
        walk(row.id, below)
      })
    }
    walk(undefined, '')
    const all = ordered.map(item => item.row)

    const counts = {
      running: all.filter(row => !isDone(row) && !row.isWaiting && row.status !== 'waiting').length,
      waiting: all.filter(row => row.isWaiting || row.status === 'waiting').length,
      done: all.filter(row => row.status === 'completed').length,
      failed: all.filter(row => row.status === 'failed').length,
      stopped: all.filter(row => row.status === 'killed').length,
    }
    const summary: [string, string][] = [
      [`${counts.running} running`, 'claude'],
      [`${counts.waiting} waiting for you`, 'warning'],
      [`${counts.done} done`, 'success'],
      [`${counts.failed} failed`, 'error'],
      [`${counts.stopped} stopped`, 'error'],
    ]
    const parts = summary.filter(([text]) => !text.startsWith('0 '))
    const width = Math.max(24, e.props.bodyColumns)

    const glyphOf = (row: Row): [string, string] => {
      const isWaiting = row.isWaiting || row.status === 'waiting'
      const isRunning = !isDone(row) && !isWaiting && row.status !== 'idle' && row.status !== 'pending'
      return isRunning ? [SPINNER[frame] ?? '●', 'claude'] : (GLYPH[isWaiting ? 'waiting' : row.status] ?? ['●', 'claude'])
    }

    const taskBar = (row: Row, cells: number) => {
      if (row.tasks === undefined) return <Text dimColor>no task list</Text>
      const filled = Math.round((row.tasks.done / row.tasks.total) * cells)
      return (
        <Box>
          <Text color={isDone(row) ? 'success' : 'claude'}>{'▰'.repeat(filled)}</Text>
          <Text color="subtle">{'▱'.repeat(cells - filled)}</Text>
          <Text>{nb(` ${row.tasks.done}/${row.tasks.total}`)}</Text>
        </Box>
      )
    }

    const stopButton = (row: Row) =>
      row.id === MAIN || isDone(row) ? null : (
        <Button key={`stop-${row.id}`} plain onPress={() => void stopAgent($, row)}>
          <Text color="error">{`${NB}[stop]`}</Text>
        </Button>
      )

    const nameButton = (row: Row, label: string, isDim: boolean, onPress: () => void) => (
      <Button key={`row-${row.id}`} plain dimColor={isDim} label={label} onPress={onPress} />
    )

    const toggle = (row: Row) => () => {
      collapsed.set(row.id, !isCollapsed(row))
      $.ui.invalidate('ui.render')
    }

    // tail: the file's age in a card, its state word in the focused timeline.
    const fileLine = (owner: Row, file: FileHit, prefix: string, nameWidth: number, tail: 'age' | 'word') => {
      const [mark, color, word] = KIND[file.kind]
      const isFresh = now - file.at < FRESH_MS
      const hasConflict = file.conflicts.length > 0
      const end = hasConflict
        ? ` ⚠ also: ${clip(file.conflicts.map(nameOf).join(', '), 18)}`
        : tail === 'age'
          ? ` ${age(now - file.at).padStart(5)}`
          : ` ${word}`
      return (
        <Box>
          <Text color="subtle">{nb(prefix)}</Text>
          <Text color={hasConflict ? 'warning' : color}>{`${hasConflict ? '⚠' : mark}${NB}`}</Text>
          <Button key={`file-${owner.id}-${file.path}`} plain onPress={() => void openInEditor($, file)}>
            <Text bold={isFresh || hasConflict} dimColor={!isFresh && !hasConflict} color={hasConflict ? 'warning' : undefined}>
              {nb(clip(shortPath(file.path), nameWidth).padEnd(nameWidth))}
            </Text>
          </Button>
          <Text dimColor>{nb(` ${sizeOf(file)}`.padEnd(10))}</Text>
          <Text color={hasConflict ? 'warning' : tail === 'age' ? 'subtle' : color} wrap="truncate-end">
            {nb(end)}
          </Text>
        </Box>
      )
    }

    const statusLine = (row: Row, guide: string) => {
      const isWaiting = row.isWaiting || row.status === 'waiting'
      const [text, color] = isWaiting
        ? ['needs your approval', 'warning']
        : row.status === 'failed'
          ? ['failed', 'error']
          : row.status === 'killed'
            ? [stopLabel(row), 'error']
            : isDone(row)
              ? ['done', 'success']
            : [`now: ${row.step ?? row.activity ?? 'starting'}`, 'claude']
      return (
        <Box>
          <Text color="subtle">{nb(guide)}</Text>
          <Text color={color} wrap="truncate-end">{text}</Text>
        </Box>
      )
    }

    // One line per closed card: a running agent keeps its bar and time left, a finished one reads as a receipt.
    const closedCard = ({ row, head, isRoot }: (typeof ordered)[number]) => {
      const [glyph, color] = glyphOf(row)
      const created = row.files.filter(file => file.kind === 'create').length
      const edited = row.files.filter(file => file.kind === 'edit').length
      const conflicts = row.files.some(file => file.conflicts.length > 0)
      const took = elapsed((row.endedAt ?? now) - row.startedAt)
      const eta = etaOf(row, now)
      const receipt = [
        row.tasks === undefined ? undefined : `${row.tasks.done}/${row.tasks.total}`,
        took,
        created + edited === 0 ? undefined : `+${created} ✎${edited}`,
        row.context === 0 ? undefined : `${tokens(row.context)} ctx`,
      ].filter(part => part !== undefined)
      return (
        <Box marginTop={isRoot ? 1 : 0}>
          <Text color="subtle">{nb(head)}</Text>
          <Text color={color}>{`${glyph}${NB}`}</Text>
          {nameButton(row, clip(row.description, 28), isDone(row), toggle(row))}
          {conflicts && <Text color="warning">{`${NB}⚠`}</Text>}
          {row.status === 'killed' && <Text color="error">{nb(` [${stopLabel(row)}]`)}</Text>}
          {isDone(row) ? (
            <Text dimColor wrap="truncate-end">{nb(` · ${receipt.join(' · ')}`)}</Text>
          ) : (
            <Box>
              <Text>{NB}</Text>
              {row.tasks === undefined ? <Text dimColor>{nb(took)}</Text> : taskBar(row, MINI_CELLS)}
              {eta !== undefined && <Text dimColor>{nb(` · ${eta}`)}</Text>}
            </Box>
          )}
          {stopButton(row)}
        </Box>
      )
    }

    // A: one fixed-height card per agent, its newest files on top.
    const openCard = ({ row, head, cont, isRoot }: (typeof ordered)[number]) => {
      const [glyph, color] = glyphOf(row)
      const guide = `${cont}${childrenOf(row.id).length > 0 ? '│ ' : '  '}`
      const ratio = row.context / windowOf(row.model || 'claude-opus-4-6')
      const filled = row.context === 0 ? 0 : Math.max(1, Math.round(ratio * BAR_CELLS))
      const barColor = ratio > 0.9 ? 'error' : ratio > 0.7 ? 'warning' : 'subtle'
      const effort = row.effort === undefined ? '' : ` · ${row.effort}`
      const took = elapsed((row.endedAt ?? now) - row.startedAt)
      const eta = etaOf(row, now)
      const files = [...row.files].reverse().slice(0, CARD_FILES)
      const blanks = isDone(row) ? 0 : CARD_FILES - files.length
      const nameWidth = Math.max(10, width - guide.length - 2 - 10 - 7)
      const conflicts = row.files.some(file => file.conflicts.length > 0)
      return (
        <Box flexDirection="column" marginTop={isRoot ? 1 : 0}>
          <Box>
            <Text color="subtle">{nb(head)}</Text>
            <Text color={color}>{`${glyph}${NB}`}</Text>
            {nameButton(row, row.description, isDone(row), toggle(row))}
            {conflicts && <Text color="warning">{`${NB}⚠ conflict`}</Text>}
            {row.status === 'killed' && <Text color="error">{nb(` [${stopLabel(row)}]`)}</Text>}
            {stopButton(row)}
          </Box>
          <Box>
            <Text color="subtle">{nb(guide)}</Text>
            <Text dimColor wrap="truncate-end">
              {nb(`${row.model === '' ? '…' : shortModel(row.model)}${effort} · `)}
            </Text>
            <Text color={barColor}>{'▰'.repeat(filled)}</Text>
            <Text dimColor>{'▱'.repeat(BAR_CELLS - filled)}</Text>
            <Text dimColor wrap="truncate-end">
              {nb(` ${tokens(row.context)}/${tokens(windowOf(row.model || 'claude-opus-4-6'))} · ${took}`)}
            </Text>
          </Box>
          <Box>
            <Text color="subtle">{nb(guide)}</Text>
            {taskBar(row, TASK_CELLS)}
            {eta !== undefined && <Text dimColor>{nb(` · ${eta}`)}</Text>}
          </Box>
          {statusLine(row, guide)}
          {files.map(file => fileLine(row, file, guide, nameWidth, 'age'))}
          {Array.from({ length: blanks }, () => (
            <Text>{NB}</Text>
          ))}
        </Box>
      )
    }

    // C: one line per agent, then the timeline of the pinned agent or the one that touched a file last.
    const compact = () => {
      const latest = [...all]
        .filter(row => row.files.length > 0)
        .sort((a, b) => (b.files.at(-1)?.at ?? 0) - (a.files.at(-1)?.at ?? 0))[0]
      const focus = all.find(row => row.id === pinned) ?? latest ?? all.find(row => !isDone(row)) ?? all[0]
      const labelWidth = 16
      const files = focus === undefined ? [] : [...focus.files].reverse().slice(0, FOCUS_FILES)
      return (
        <Box flexDirection="column" marginTop={1}>
          {ordered.map(({ row, head }) => {
            const [glyph, color] = glyphOf(row)
            const eta = etaOf(row, now)
            return (
              <Box>
                <Text color="subtle">{nb(head)}</Text>
                <Text color={color}>{`${glyph}${NB}`}</Text>
                {nameButton(row, nb(clip(row.description, labelWidth).padEnd(labelWidth)), row !== focus, () => {
                  pinned = pinned === row.id ? undefined : row.id
                  $.ui.invalidate('ui.render')
                })}
                {row.files.some(file => file.conflicts.length > 0) ? <Text color="warning">⚠</Text> : <Text>{NB}</Text>}
                {row.tasks === undefined ? <Text dimColor>{nb(elapsed((row.endedAt ?? now) - row.startedAt))}</Text> : taskBar(row, MINI_CELLS)}
                {eta !== undefined && <Text dimColor>{nb(` ${eta.replace(' left', '')}`)}</Text>}
                {stopButton(row)}
              </Box>
            )
          })}
          {focus !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="claude" wrap="truncate-end">
                {`── ${clip(focus.description, 24)}${focus.id === pinned ? ' (pinned)' : ''} · ${focus.step ?? focus.activity ?? ''}`}
              </Text>
              {files.map(file => fileLine(focus, file, `${age(now - file.at).padStart(5)} `, Math.max(10, width - 6 - 2 - 10 - 10), 'word'))}
              {Array.from({ length: FOCUS_FILES - files.length }, () => (
                <Text>{NB}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // Background shells, monitors and workflows: running ones with their newest output line, then the last few receipts.
    const background = () => {
      const running = runningJobs().sort((a, b) => a.startedAt - b.startedAt)
      const ended = [...jobs.values()]
        .filter(job => job.status !== 'running')
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        .slice(0, JOB_RECEIPTS)
      if (running.length + ended.length === 0) return null
      const kindOf = (job: Job) => nb(job.kind.padEnd(9))
      const indent = nb(' '.repeat(11))
      const title = `── background${running.length > 0 ? ` · ${running.length} running` : ''} `
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={running.length > 0 ? 'claude' : 'subtle'} wrap="truncate-end">
            {nb(title.padEnd(width, '─'))}
          </Text>
          {running.map(job => {
            const left = job.deadline === undefined ? undefined : job.deadline - now
            const meta = [
              elapsed(now - job.startedAt),
              left === undefined ? undefined : left > 0 ? `expires in ${elapsed(left)}` : 'expiring',
              nameOf(job.owner),
            ].filter(part => part !== undefined)
            const detail =
              job.last ?? (job.kind === 'shell' ? 'no output yet' : job.kind === 'monitor' ? 'waiting for the first event' : 'progress in /workflows')
            const quiet = now - (job.lastOutputAt ?? job.startedAt)
            const isStale = job.kind === 'shell' && quiet > STALE_MS
            const eta = jobEta(job)
            const filled = job.ratio === undefined ? 0 : Math.round(job.ratio * TASK_CELLS)
            const label = nb(clip(job.label, Math.max(12, width - 11 - 30)))
            return (
              <Box flexDirection="column">
                <Box>
                  <Text color={isStale ? 'warning' : 'claude'}>{`${isStale ? '!' : (SPINNER[frame] ?? '●')}${NB}`}</Text>
                  <Text dimColor>{kindOf(job)}</Text>
                  {job.outputFile === undefined ? (
                    <Text wrap="truncate-end">{label}</Text>
                  ) : (
                    <Button key={`log-${job.id}`} plain label={label} onPress={() => void openLog($, job)} />
                  )}
                  <Text dimColor wrap="truncate-end">{nb(` · ${meta.join(' · ')}`)}</Text>
                  {!job.isStoppedByYou && (
                    <Button key={`stop-job-${job.id}`} plain onPress={() => void stopJob($, job)}>
                      <Text color="error">{`${NB}[stop]`}</Text>
                    </Button>
                  )}
                </Box>
                <Box>
                  <Text>{indent}</Text>
                  {job.ratio !== undefined && (
                    <Box>
                      <Text color="claude">{'▰'.repeat(filled)}</Text>
                      <Text color="subtle">{'▱'.repeat(TASK_CELLS - filled)}</Text>
                      <Text>{nb(` ${job.ratioText ?? ''}`)}</Text>
                      {eta !== undefined && <Text dimColor>{nb(` · ${eta}`)}</Text>}
                      <Text dimColor>{nb(' · ')}</Text>
                    </Box>
                  )}
                  {isStale && <Text color="warning">{nb(`no output for ${elapsed(quiet)} · `)}</Text>}
                  <Text dimColor wrap="truncate-end">{clip(detail, 200)}</Text>
                </Box>
              </Box>
            )
          })}
          {ended.map(job => {
            const [glyph, color] = GLYPH[job.status] ?? ['●', 'subtle']
            const how =
              job.status === 'killed'
                ? job.isStoppedByYou
                  ? 'stopped by you'
                  : job.endsWithOwner
                    ? 'ended with the agent'
                    : 'interrupted'
                : job.exitCode !== undefined
                  ? `exited ${job.exitCode}`
                  : job.status === 'failed'
                    ? 'failed'
                    : 'done'
            return (
              <Box>
                <Text color={color}>{`${glyph}${NB}`}</Text>
                <Text dimColor>{kindOf(job)}</Text>
                <Text dimColor wrap="truncate-end">
                  {nb(`${clip(job.label, Math.max(12, width - 11 - 26))} · ${elapsed((job.endedAt ?? now) - job.startedAt)} · `)}
                </Text>
                <Text color={job.status === 'completed' ? 'success' : 'error'}>{how}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    // Folded receipts are one line each, so only open cards count toward the compact view.
    const openCount = ordered.filter(item => !isCollapsed(item.row)).length
    const hasJobs = jobs.size > 0
    return (
      <Box flexDirection="column">
        {all.length === 0 ? (
          !hasJobs && <Text dimColor>Nothing running right now</Text>
        ) : (
          <Box>
            {parts.map(([text, color], index) => (
              <Text color={color}>{nb(index === 0 ? text : ` · ${text}`)}</Text>
            ))}
            {(all.some(isDone) || [...jobs.values()].some(job => job.status !== 'running')) && (
              <Button key="clear" plain onPress={() => clearDone($)}>
                <Text dimColor>{`${NB}${NB}[clear]`}</Text>
              </Button>
            )}
          </Box>
        )}
        {openCount > MAX_CARDS ? compact() : ordered.map(item => (isCollapsed(item.row) ? closedCard(item) : openCard(item)))}
        {background()}
        {all.length === 0 && [...jobs.values()].some(job => job.status !== 'running') && (
          <Button key="clear-jobs" plain onPress={() => clearDone($)}>
            <Text dimColor>[clear]</Text>
          </Button>
        )}
      </Box>
    )
  })
}
