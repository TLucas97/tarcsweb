import WebSocket from 'ws';
type Pending = { ok: (v: any) => void; fail: (e: Error) => void };
export class Cdp {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private ws: WebSocket;

  constructor(ws: WebSocket, onEvent: (method: string, params: any, session?: string) => void, onClose: () => void) {
    this.ws = ws;
    // The close event follows and fails what is pending.
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.id === undefined) return onEvent(m.method, m.params, m.sessionId);
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.fail(new Error(m.error.message));
      else p?.ok(m.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.fail(new Error('DevTools connection closed'));
      this.pending.clear();
      onClose();
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string | null): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('DevTools connection closed'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise<T>((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  close() {
    this.ws.close();
  }

  // A handshake still open when its run goes stale is cut, so it never lands on a torn-down run.
  static open(url: string, signal: AbortSignal, timeout: number, aborted: string) {
    return new Promise<WebSocket>((ok, fail) => {
      if (signal.aborted) return fail(new Error(aborted));
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 << 20, handshakeTimeout: timeout });
      const cut = () => {
        ws.terminate();
        fail(new Error(aborted));
      };
      signal.addEventListener('abort', cut, { once: true });
      ws.once('open', () => {
        signal.removeEventListener('abort', cut);
        ok(ws);
      });
      ws.once('error', (e) => {
        signal.removeEventListener('abort', cut);
        fail(new Error(`Chrome's DevTools connection failed: ${e.message}`));
      });
    });
  }
}
