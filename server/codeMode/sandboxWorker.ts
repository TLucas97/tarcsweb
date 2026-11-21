import { on, once } from 'node:events';
import { threadCpuUsage } from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import type { QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';
import { HOST_ARGS_TOO_LARGE, MAX_HOST_ARGS_BYTES, PRELUDE } from './prelude.ts';
import { INNER_TOOLS } from './types.ts';
import type { InnerTool, RunLimits, RunResult } from './types.ts';

export type WorkerStart = { code: string; limits: RunLimits };
export type WorkerMessage =
  | { type: 'call'; id: number; tool: InnerTool; args: string }
  | { type: 'result'; result: RunResult };
export type HostReply = { id: number; json: string };

const port = parentPort!;
const { code, limits } = workerData as WorkerStart;
const LOG_LIMIT = 200;
const MAX_IN_FLIGHT_CALLS = 8;
const CPU_ERROR = 'Script exceeded its CPU time limit';
const MEMORY_ERROR = 'Script exceeded its memory limit';
const WASM_PAGE_BYTES = 64 * 1024;
const WASM_INITIAL_PAGES = 256;

function valuePreview(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max < 2) return '';

  let low = 0;
  let high = max - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= max) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify(value.slice(0, low));
}

function capOutput(value: string, logs: string[], max: number) {
  if (value.length + logs.reduce((length, log) => length + log.length, 0) <= max) {
    return { value, logs, truncated: false };
  }

  const note = '[Output truncated]'.slice(0, max);
  value = valuePreview(value, max - note.length);
  let remaining = max - note.length - value.length;
  const kept = note ? [note] : [];
  for (let i = logs.length - 1; i >= 0 && remaining > 0 && kept.length < LOG_LIMIT; i--) {
    const log = logs[i].slice(0, remaining);
    kept.push(log);
    remaining -= log.length;
  }
  return { value, logs: kept.reverse(), truncated: true };
}

async function run(): Promise<RunResult> {
  const [wasmModule] = await once(port, 'message') as [WebAssembly.Module];
  const wasmMemory = new WebAssembly.Memory({
    initial: WASM_INITIAL_PAGES,
    maximum: Math.min(32768, WASM_INITIAL_PAGES + Math.ceil(limits.memoryBytes / WASM_PAGE_BYTES)),
  });
  const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmModule, wasmMemory }));
  // Not disposed: the worker dies after one run, and JS_FreeRuntime aborts on a QuickJS leak
  // (await + JSON.parse of ~1.3M mixed-width chars), which would replace a good result.
  const runtime = module.newRuntime();
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();

  let usedCpu = 0;
  let sliceStart: ReturnType<typeof threadCpuUsage> | undefined;
  const cpuLimit = limits.cpuMs * 1000;
  function sliceCpu() {
    if (!sliceStart) return 0;
    const { user, system } = threadCpuUsage(sliceStart);
    return user + system;
  }
  function cpuExceeded() {
    return usedCpu + sliceCpu() >= cpuLimit;
  }
  function guest<T>(runSlice: () => T): T {
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    sliceStart = threadCpuUsage();
    try {
      return runSlice();
    } finally {
      usedCpu += sliceCpu();
      sliceStart = undefined;
    }
  }
  const logs: string[] = [];
  let dropped = false;
  let shortened = false;
  let memoryExceeded = false;
  const inFlight = new Map<number, QuickJSDeferredPromise>();
  // Keep queued payloads in QuickJS so they count against its memory limit.
  const queued = new Map<number, { tool: InnerTool; args: QuickJSHandle; deferred: QuickJSDeferredPromise }>();
  let callId = 0;
  runtime.setInterruptHandler(() => memoryExceeded || cpuExceeded());

  // This build's allocator undercounts cumulative allocations in setMemoryLimit.
  function checkMemory() {
    if (!memoryExceeded) {
      const usage = runtime.computeMemoryUsage().consume(handle => vm.dump(handle).memory_used_size as number);
      memoryExceeded = usage > limits.memoryBytes;
    }
    if (memoryExceeded) throw new Error(MEMORY_ERROR);
  }

  function finish(outcome: { value: string } | { error: string }): RunResult {
    if (dropped) {
      logs.shift();
      logs.unshift('[Older log entries dropped]');
    }
    const output = capOutput('value' in outcome ? outcome.value : '', logs, limits.maxOutputChars);
    const truncated = output.truncated || dropped || shortened;
    return 'value' in outcome
      ? { ok: true, value: output.value, logs: output.logs, truncated }
      : { ok: false, error: outcome.error, logs: output.logs, truncated };
  }

  function sendCall(id: number, tool: InnerTool, args: string, deferred: QuickJSDeferredPromise) {
    inFlight.set(id, deferred);
    port.postMessage({ type: 'call', id, tool, args } satisfies WorkerMessage);
  }

  using dispatch = vm.newFunction('dispatch', (toolHandle, argsHandle) => {
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    checkMemory();
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    const tool = vm.getString(toolHandle) as InnerTool;
    if (!INNER_TOOLS.includes(tool) || vm.typeof(argsHandle) !== 'string') throw new Error('Invalid host call');
    const args = vm.getString(argsHandle);
    if (Buffer.byteLength(args) > MAX_HOST_ARGS_BYTES) throw new Error(HOST_ARGS_TOO_LARGE);
    const deferred = vm.newPromise();
    const id = ++callId;
    if (inFlight.size < MAX_IN_FLIGHT_CALLS && queued.size === 0) sendCall(id, tool, args, deferred);
    else queued.set(id, { tool, args: argsHandle.dup(), deferred });
    return deferred.handle;
  });

  using record = vm.newFunction('log', entry => {
    const [line, clipped] = JSON.parse(vm.getString(entry)) as [string, boolean];
    shortened ||= clipped;
    if (logs.length === LOG_LIMIT) {
      logs.shift();
      dropped = true;
    }
    logs.push(line);
  });

  using setup = vm.evalCode(PRELUDE, 'prelude.js', { type: 'global' }).unwrap();
  using api = vm.callFunction(setup, vm.undefined, dispatch, record).unwrap();
  using start = vm.getProp(api, 'start');
  using encode = vm.getProp(api, 'encode');
  using describe = vm.getProp(api, 'describe');

  function guestError(error: QuickJSHandle): string {
    using description = guest(() => vm.callFunction(describe, vm.undefined, error));
    if (description.error || vm.typeof(description.value) !== 'string') return 'Could not read the guest error';
    const { message, stack } = JSON.parse(vm.getString(description.value)) as { message: string; stack: string };
    if (message === 'InternalError: out of memory') return MEMORY_ERROR;
    const frames = stack.trimEnd().split('\n').slice(0, 5).map(frame => frame.replace(
      /<input>:(\d+)/g, (_, line: string) => `script.js:${Math.max(1, Number(line) - 3)}`,
    ));
    return [message, ...frames.filter(Boolean)].join('\n');
  }

  function settle(promise: QuickJSHandle): RunResult | undefined {
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    const state = vm.getPromiseState(promise);
    if (state.type === 'pending') return;
    if (state.type === 'rejected') {
      using error = state.error;
      return finish({ error: guestError(error) });
    }
    using value = state.value;
    using encoded = guest(() => vm.callFunction(encode, vm.undefined, value));
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    checkMemory();
    if (encoded.error) return finish({ error: guestError(encoded.error) });
    return finish({ value: vm.typeof(encoded.value) === 'string' ? vm.getString(encoded.value) : '' });
  }

  function drain(promise: QuickJSHandle) {
    while (runtime.hasPendingJob()) {
      using jobs = guest(() => runtime.executePendingJobs(32));
      if (cpuExceeded()) throw new Error(CPU_ERROR);
      checkMemory();
      if (jobs.error) return finish({ error: guestError(jobs.error) });
    }
    return settle(promise);
  }

  try {
    // QuickJS needs enough memory to initialize the context and its intrinsics.
    checkMemory();
    runtime.setMemoryLimit(limits.memoryBytes);
    using source = vm.newString(JSON.stringify(code));
    using execution = guest(() => vm.callFunction(start, vm.undefined, source));
    if (cpuExceeded()) throw new Error(CPU_ERROR);
    checkMemory();
    if (execution.error) return finish({ error: guestError(execution.error) });
    const initial = drain(execution.value);
    if (initial) return initial;

    for await (const [reply] of on(port, 'message') as AsyncIterable<[HostReply]>) {
      const deferred = inFlight.get(reply.id);
      if (!deferred) continue;
      inFlight.delete(reply.id);
      using response = vm.newString(reply.json);
      using call = deferred;
      guest(() => call.resolve(response));
      const result = drain(execution.value);
      if (result) return result;

      if (inFlight.size === MAX_IN_FLIGHT_CALLS) continue;
      const next = queued.entries().next().value;
      if (next) {
        const [id, request] = next;
        const args = vm.getString(request.args);
        queued.delete(id);
        request.args.dispose();
        sendCall(id, request.tool, args, request.deferred);
      }
    }
    return finish({ error: 'Sandbox port closed' });
  } catch (error) {
    if (memoryExceeded) return finish({ error: MEMORY_ERROR });
    return finish({ error: cpuExceeded() ? CPU_ERROR : error instanceof Error ? error.message : String(error) });
  } finally {
    for (const deferred of inFlight.values()) deferred.dispose();
    for (const request of queued.values()) {
      request.args.dispose();
      request.deferred.dispose();
    }
  }
}

let result: RunResult;
try {
  result = await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result = { ok: false, error: message, logs: [], truncated: false };
}
port.postMessage({ type: 'result', result } satisfies WorkerMessage);
