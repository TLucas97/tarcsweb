import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextBreakdown, ContextCategory, ContextDetail } from './protocol.ts';

// Summary already includes categories and local estimates; it does not call the token-count API.
// The map gets only the category totals; details holds each category's list for context-load.
export function claudeContext(r: SDKControlGetContextUsageResponse): { breakdown: ContextBreakdown; details: Map<string, ContextDetail[]> } {
  const tools = { mcp_tools: new Map<string, ContextDetail>(), mcp_tools_deferred: new Map<string, ContextDetail>() };
  for (const tool of r.mcpTools ?? []) {
    if (tool.tokens <= 0) continue;
    const group = tool.isLoaded === false ? tools.mcp_tools_deferred : tools.mcp_tools;
    const server = group.get(tool.serverName) ?? { name: tool.serverName, tokens: 0, children: [] };
    server.tokens += tool.tokens;
    server.children!.push({ name: tool.name, tokens: tool.tokens });
    group.set(tool.serverName, server);
  }
  const m = r.messageBreakdown;
  const lists: Record<string, ContextDetail[] | undefined> = {
    memory_files: r.memoryFiles?.map((f) => ({ name: f.path, tokens: f.tokens })),
    mcp_tools: [...tools.mcp_tools.values()],
    mcp_tools_deferred: [...tools.mcp_tools_deferred.values()],
    skills: r.skills?.skillFrontmatter.map((s) => ({ name: s.name, tokens: s.tokens })),
    custom_agents: r.agents?.map((a) => ({ name: a.agentType, tokens: a.tokens })),
    system_tools: r.systemTools?.map((t) => ({ name: t.name, tokens: t.tokens })),
    system_prompt: r.systemPromptSections?.map((s) => ({ name: s.name, tokens: s.tokens })),
    mcp_instructions: r.mcpInstructions?.map((s) => ({ name: s.serverName, tokens: s.tokens })),
    messages: m && [
      { name: 'User messages', tokens: m.userMessageTokens },
      { name: 'Assistant messages', tokens: m.assistantMessageTokens },
      { name: 'Tool calls', tokens: m.toolCallTokens },
      { name: 'Tool results', tokens: m.toolResultTokens },
      { name: 'Attachments', tokens: m.attachmentTokens },
      { name: 'Redirected context', tokens: m.redirectedContextTokens },
      { name: 'Unattributed', tokens: m.unattributedTokens },
    ],
  };
  const details = new Map<string, ContextDetail[]>();
  for (const [id, items] of Object.entries(lists)) {
    const kept = items?.filter((d) => d.tokens > 0);
    if (kept?.length) details.set(id, kept);
  }
  const categories: ContextCategory[] = (r.categories ?? []).map((c) => ({
    id: c.id, name: c.name, tokens: c.tokens, kind: c.kind, ...(c.id && details.has(c.id) ? { more: true as const } : {}),
  }));
  return { breakdown: { provider: 'claude', categories, at: Date.now() }, details };
}
