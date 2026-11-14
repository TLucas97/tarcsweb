import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EFFORTS, registerClaudeModels, type ClaudeModel } from './protocol.ts';
import { connect } from './connect.ts';

let pending: Promise<ClaudeModel[]> | null = null;
connect.subscribe(() => { pending = null; });

// Catalog lookup initializes the SDK on intent, without submitting a user turn.
export function claudeModels(): Promise<ClaudeModel[]> {
  pending ??= load().catch((error) => { pending = null; throw error; });
  return pending;
}

async function load(): Promise<ClaudeModel[]> {
  let release!: () => void;
  const hold = new Promise<void>((done) => { release = done; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> { await hold; }
  const q = query({ prompt: prompt(), options: {
    ...(process.env.CW_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CW_CLAUDE_BIN } : {}),
    persistSession: false, tools: [], settingSources: [], skills: [], strictMcpConfig: true, mcpServers: {},
    settings: { autoMemoryEnabled: false, disableAllHooks: true }, title: 'Model catalog',
  } });
  try {
    const rows = (await q.supportedModels()).filter((m) => m.value !== 'default');
    const models: ClaudeModel[] = rows.filter((m, i) => rows.findIndex((r) => (r.resolvedModel ?? r.value) === (m.resolvedModel ?? m.value)) === i).map((m) => ({
      id: m.resolvedModel ?? m.value, alias: m.value, name: m.displayName, description: m.description,
      efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels ?? EFFORTS,
    }));
    registerClaudeModels(models);
    return models;
  } finally {
    q.close();
    release();
  }
}
