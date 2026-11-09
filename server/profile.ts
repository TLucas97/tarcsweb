import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, config } from './config.ts';
import { PERF_PROFILES, type PerfProfile } from './protocol.ts';

// CW_PROFILE wins over the saved choice, for headless runs and first boots.
const forced = (): PerfProfile | null => (PERF_PROFILES.includes(process.env.CW_PROFILE as never) ? (process.env.CW_PROFILE as PerfProfile) : null);

// Read at use time, so a Settings change applies without a restart.
export const perfProfile = (): PerfProfile => forced() ?? config.perf ?? 'standard';
export const isLite = () => perfProfile() === 'lite';
export const perfForced = () => forced() !== null;
// Installs from before Lite already had a search index or history; they count as having chosen standard, so nothing
// new (detection, lag monitor, suggestion) runs for them. A fresh install marks itself and stays offerable until it picks.
const OFFER_MARK = join(CACHE_DIR, 'lite-offer');
const offerable = existsSync(OFFER_MARK) || !(existsSync(join(CACHE_DIR, 'search.db')) || existsSync(join(CACHE_DIR, 'history')));
if (offerable && config.perf === undefined) mkdir(CACHE_DIR, { recursive: true }).then(() => writeFile(OFFER_MARK, '')).catch(() => {});

// False until the user picks a profile; a never-chosen config runs as standard.
export const perfChosen = () => config.perf !== undefined || !offerable;

// Deadline of one board AI job (high effort can take minutes); CW_BOARD_JOB_MS shortens it for test runs.
const boardJobMs = Number(process.env.CW_BOARD_JOB_MS) || 300_000;

const standard = Object.freeze({
  idleClis: 1, cliIdleMs: 5 * 60_000, sttPrewarm: true, sttIdleMs: 10 * 60_000,
  codexIdleMs: 10 * 60_000, idleThreads: 2, voiceRecaps: true, modelTitles: true, sideNotes: true, youShouldKnow: true,
  claudeAgents: 4, codexAgents: 8, boardJobs: 2, boardJobMs, boardFileMs: 24 * 3600_000, boardCodexIdleMs: 5 * 60_000, logMax: 800, logKeep: 400,
  // generate_image jobs running at once per tab; each starts up to 4 Codex threads.
  imageJobs: 2,
  flushMs: 50, partialMs: 80, mapMs: 150, panelMs: 150, emitMs: 250, renderMs: 60, journalMs: 1500,
  searchBootScan: true, promptWatch: true, agentSummaries: true,
  browserIdleMs: 5 * 60_000, browserQuality: 80, browserTitleMs: 2000,
  // Screencast acks are at least browserFrameMs apart, browserIdleFrameMs once the owner gave no input for browserInputIdleMs.
  browserFrameMs: 33, browserIdleFrameMs: 66, browserInputIdleMs: 2000,
  // The run bar's poll of its processes (memory, ports, logs) while any of them runs.
  runMs: 2000,
  // Voice call: its app-server's idle stop, the wait for the answer SDP, and redials (backoff doubles from callRedialMs).
  callCodexIdleMs: 3 * 60_000, callSdpMs: 30_000, callRedials: 3, callRedialMs: 500,
  // A first call thread may wait on the app-server's boot; the summary reads callSummaryChars of the session.
  callThreadMs: 120_000, callStopMs: 10_000, callSummaryMs: 90_000, callReportMs: 120_000, callSummaryChars: 60_000, callLinesMax: 2000,
  // How long a server shutdown waits for calls to stop; their conversations are saved before that.
  callShutdownMs: 5000,
  // Hovering the call button summarizes the session ahead of the click.
  callSummaryWarm: true,
  // Pages opened in the user's Chrome (open-html) kept on disk; older tabs stop loading on reload.
  tabsKept: 20,
});
const lite = Object.freeze({
  idleClis: 0, cliIdleMs: 90_000, sttPrewarm: false, sttIdleMs: 2 * 60_000,
  codexIdleMs: 2 * 60_000, idleThreads: 1, voiceRecaps: false, modelTitles: false, sideNotes: false, youShouldKnow: false,
  claudeAgents: 2, codexAgents: 2, boardJobs: 1, boardJobMs, boardFileMs: 6 * 3600_000, boardCodexIdleMs: 90_000, logMax: 300, logKeep: 150,
  imageJobs: 1,
  flushMs: 100, partialMs: 160, mapMs: 300, panelMs: 300, emitMs: 500, renderMs: 120, journalMs: 4000,
  searchBootScan: false, promptWatch: false, agentSummaries: false,
  browserIdleMs: 90_000, browserQuality: 75, browserTitleMs: 5000,
  browserFrameMs: 50, browserIdleFrameMs: 100, browserInputIdleMs: 2000,
  runMs: 4000,
  callCodexIdleMs: 60_000, callSdpMs: 30_000, callRedials: 3, callRedialMs: 500,
  callThreadMs: 120_000, callStopMs: 10_000, callSummaryMs: 90_000, callReportMs: 120_000, callSummaryChars: 30_000, callLinesMax: 2000,
  callShutdownMs: 5000,
  callSummaryWarm: false,
  tabsKept: 20,
});

export const tuning = () => isLite() ? lite : standard;

type PerfListener = (profile: PerfProfile, prev: PerfProfile) => void;
const listeners = new Set<PerfListener>();

// Fires whenever the saved choice changes, so profile can equal prev; act only on a real change.
export function onPerfChange(fn: PerfListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// settings.ts calls this after a save that changed config.perf.
export function perfSaved(prev: PerfProfile) {
  const now = perfProfile();
  for (const fn of listeners) fn(now, prev);
}
