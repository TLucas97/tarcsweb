import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { HOST_ARGS_TOO_LARGE, MAX_HOST_ARGS_BYTES } from './prelude.ts';
import type { HostReply, WorkerMessage, WorkerStart } from './sandboxWorker.ts';
import type { HostCall, RunLimits, RunResult } from './types.ts';

export { GUEST_API } from './prelude.ts';

const MAX_HOST_RESULT_BYTES = 2 * 1024 * 1024;

let compiledModule: Promise<WebAssembly.Module> | undefined;

async function compileModule() {
  const requireQuickJS = createRequire(import.meta.resolve('quickjs-emscripten'));
  const binary = await readFile(requireQuickJS.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'));
  return WebAssembly.compile(binary);
}

export function runScript(code: string, host: HostCall, limits: RunLimits, signal: AbortSignal): Promise<RunResult> {
  return new Promise(resolve => {
    let worker: Worker | undefined;
    let done = false;
    const deadline = performance.now() + limits.wallMs;

    function finish(result: RunResult) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (worker) void worker.terminate().catch(() => {});
      worker = undefined;
      resolve(result);
    }

    function fail(error: string) {
      finish({ ok: false, error, logs: [], truncated: false });
    }

    function abort() {
      fail('Script aborted');
    }

    function expired() {
      if (performance.now() < deadline) return false;
      fail('Script exceeded its wall time limit');
      return true;
    }

    const timer = setTimeout(() => fail('Script exceeded its wall time limit'), limits.wallMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();

    async function onMessage(message: WorkerMessage) {
      if (done || expired()) return;
      if (message.type === 'result') return finish(message.result);

      let json: string;
      try {
        if (Buffer.byteLength(message.args) > MAX_HOST_ARGS_BYTES) throw new Error(HOST_ARGS_TOO_LARGE);
        const args: unknown = JSON.parse(message.args);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Host tool arguments must be a JSON object');
        const data = await host(message.tool, args as Record<string, unknown>);
        if (done || expired()) return;
        json = JSON.stringify({ ok: true, data });
      } catch (error) {
        if (done || expired()) return;
        json = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      if (done || expired()) return;
      if (Buffer.byteLength(json) > MAX_HOST_RESULT_BYTES) {
        json = JSON.stringify({ ok: false, error: 'Host tool response exceeds 2 MiB. Read a smaller window or return less data.' });
      }
      const reply: HostReply = { id: message.id, json };
      worker?.postMessage(reply);
    }

    void (async () => {
      if (expired()) return;
      const workerData: WorkerStart = { code, limits };
      const active = new Worker(new URL('./sandboxWorker.ts', import.meta.url), { workerData, execArgv: [], env: {} });
      worker = active;
      active.on('message', (message: WorkerMessage) => {
        void onMessage(message).catch(() => fail('Could not deliver the host tool response'));
      });
      active.once('error', error => fail(`Sandbox worker failed: ${error instanceof Error ? error.message : String(error)}`));
      active.once('exit', () => fail('Sandbox worker exited before returning a result'));

      compiledModule ??= compileModule();
      const wasmModule = await compiledModule;
      if (!done && !expired()) active.postMessage(wasmModule);
    })().catch((error: unknown) => fail(`Could not start the sandbox: ${error instanceof Error ? error.message : String(error)}`));
  });
}
