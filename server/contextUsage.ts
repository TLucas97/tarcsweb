import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextBreakdown, ContextCategory, ContextDetail } from './protocol.ts';

// Summary already includes categories and local estimates; it does not call the token-count API.
export function claudeBreakdown(r: SDKControlGetContextUsageResponse): ContextBreakdown {
  const tools = { mcp_tools: new Map<string, ContextDetail>(), mcp_tools_deferred: new Map<string, ContextDetail>() };
  for (const tool of r.mcpTools ?? []) {
    const group = tool.isLoaded === false ? tools.mcp_tools_deferred : tools.mcp_tools;
    const server = group.get(tool.serverName) ?? { name: tool.serverName, tokens: 0, children: [] };
    server.tokens += tool.tokens;
    server.children!.push({ name: tool.name, tokens: tool.tokens });
    group.set(tool.serverName, server);
  }
  const details: Record<string, ContextDetail[] | undefined> = {
    memory_files: r.memoryFiles?.map((f) => ({ name: f.path, tokens: f.tokens })),
    mcp_tools: [...tools.mcp_tools.values()],
    mcp_tools_deferred: [...tools.mcp_tools_deferred.values()],
    skills: r.skills?.skillFrontmatter.map((s) => ({ name: s.name, tokens: s.tokens })),
    custom_agents: r.agents?.map((a) => ({ name: a.agentType, tokens: a.tokens })),
    system_tools: r.systemTools?.map((t) => ({ name: t.name, tokens: t.tokens })),
    system_prompt: r.systemPromptSections?.map((s) => ({ name: s.name, tokens: s.tokens })),
    mcp_instructions: r.mcpInstructions?.map((s) => ({ name: s.serverName, tokens: s.tokens })),
  };
  if (r.messageBreakdown) {
    const m = r.messageBreakdown;
    details.messages = [
      { name: 'User messages', tokens: m.userMessageTokens },
      { name: 'Assistant messages', tokens: m.assistantMessageTokens },
      { name: 'Tool calls', tokens: m.toolCallTokens },
      { name: 'Tool results', tokens: m.toolResultTokens },
      { name: 'Attachments', tokens: m.attachmentTokens },
      { name: 'Redirected context', tokens: m.redirectedContextTokens },
      { name: 'Unattributed', tokens: m.unattributedTokens },
    ];
  }
  const categories: ContextCategory[] = (r.categories ?? []).map((c) => ({
    id: c.id, name: c.name, tokens: c.tokens, kind: c.kind,
    ...(c.id && details[c.id]?.length ? { details: details[c.id] } : {}),
  }));
  return { provider: 'claude', categories, estimated: true };
}
