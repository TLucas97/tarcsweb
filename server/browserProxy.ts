import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

// Codex has no SDK PreToolUse hook; its browser packs wait at the MCP boundary instead.
export function browserProxy(config: McpServerConfig, before: (signal: AbortSignal, id: string) => Promise<void>, after: (id: string) => void) {
  const server = new Server({ name: 'session-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'session-browser', version: '1.0.0' });
  let connected: Promise<void> | null = null;
  const connect = () => {
    if (!('command' in config)) throw new Error('Browser packs require a local stdio server.');
    return connected ??= client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'inherit' }));
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    await connect();
    return client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const id = randomUUID();
    try {
      await before(extra.signal, id);
      await connect();
      return await client.callTool(request.params, undefined, { signal: extra.signal, timeout: 120_000 });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    } finally {
      after(id);
    }
  });
  server.onclose = () => { void client.close(); };
  return server;
}
