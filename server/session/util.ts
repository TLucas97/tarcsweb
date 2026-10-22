export const PROGRESS_TOOL = 'mcp__agents-panel__progress';
export const PROGRESS_NOTE = `\n\nProgress reporting: call ${PROGRESS_TOOL} (load it with ToolSearch "select:${PROGRESS_TOOL}" if needed) once at the start with {task, total, done: 0, step}, then after each step with done + 1 and a short name for the next step.`;

// A sync throw in a timer callback reaches uncaughtException, which nothing handles, and stops the server.
export function guard(what: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(`${what} failed:`, err);
  }
}

// Cap for the per-session id and prompt memories that tell Remote Control turns apart.
export const ID_CAP = 200;
export function capAdd(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > ID_CAP) set.delete(set.values().next().value!);
}
