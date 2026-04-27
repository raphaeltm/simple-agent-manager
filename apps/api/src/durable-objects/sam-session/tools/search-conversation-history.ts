import type { AnthropicToolDef, ToolContext } from '../types';

export const searchConversationHistoryDef: AnthropicToolDef = {
  name: 'search_conversation_history',
  description:
    'Search your conversation history with the user. Use this when the user references something from an earlier conversation that is not in the current context window, or when you need to recall a past discussion, decision, or preference.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — keywords or phrases to find in past messages.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Defaults to 10.',
      },
    },
    required: ['query'],
  },
};

export async function searchConversationHistory(
  input: { query: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.query?.trim()) {
    return { error: 'Query is required' };
  }

  if (!ctx.searchMessages) {
    return { error: 'Search is not available in this context' };
  }

  const limit = Math.min(input.limit || 10, 50);
  const results = ctx.searchMessages(input.query, limit);

  return {
    results,
    count: results.length,
    query: input.query,
  };
}
