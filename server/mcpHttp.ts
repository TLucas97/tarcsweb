import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

// A Streamable HTTP MCP session that always answers in plain JSON (no SSE stream, no resumption).
// It plugs into McpServer.connect; swapping it for the SDK's StreamableHTTPServerTransport only touches this file and mcpHost.ts.

export type RpcId = string | number;
export type RpcMessage = { jsonrpc: '2.0'; id?: RpcId | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const isRequest = (m: RpcMessage): m is RpcMessage & { id: RpcId; method: string } => typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const failure = (id: RpcId, code: number, message: string): RpcMessage => ({ jsonrpc: '2.0', id, error: { code, message } });

export class JsonTransport {
  sessionId = randomUUID();
  onmessage?: (message: RpcMessage, extra?: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private waits = new Map<RpcId, (m: RpcMessage) => void>();
  private closed = false;

  async start() {}

  async send(message: RpcMessage, options?: { relatedRequestId?: RpcId }) {
    // Server-initiated requests and notifications have no stream to ride on here.
    if (message.method !== undefined) return;
    this.settle(message.id ?? options?.relatedRequestId, message);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.waits.keys()]) this.settle(id, failure(id, -32000, 'The MCP session closed'));
    this.onclose?.();
  }

  // Feeds one POST body to the server; resolves with the responses to its requests, in order.
  async post(messages: RpcMessage[], res: ServerResponse): Promise<RpcMessage[]> {
    if (this.closed) throw new Error('The MCP session closed');
    const asked = messages.filter(isRequest);
    const replies = asked.map((m) => new Promise<RpcMessage>((done) => this.waits.set(m.id, done)));
    // A client that hangs up gave up on its calls, so a blocking tool stops waiting.
    const gone = () => {
      for (const m of asked) if (this.waits.has(m.id)) this.cancel(m.id, 'The client closed the request');
    };
    res.once('close', gone);
    for (const m of messages) {
      this.onmessage?.(m);
      // The server aborts a cancelled call without answering it; its waiting POST is answered here.
      if (m.method === 'notifications/cancelled') {
        const id = m.params?.requestId;
        if (typeof id === 'string' || typeof id === 'number') this.settle(id, failure(id, -32800, 'Request cancelled'));
      }
    }
    try {
      return await Promise.all(replies);
    } finally {
      res.off('close', gone);
    }
  }

  private cancel(id: RpcId, reason: string) {
    this.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
    this.settle(id, failure(id, -32800, reason));
  }

  private settle(id: RpcId | null | undefined, m: RpcMessage) {
    if (id === undefined || id === null) return;
    const w = this.waits.get(id);
    if (!w) return;
    this.waits.delete(id);
    w(m);
  }
}
