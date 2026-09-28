import {
  DEFAULT_SAM_SEARCH_LIMIT,
  DEFAULT_SAM_SEARCH_MAX_LIMIT,
} from '@simple-agent-manager/shared';

import { normalizeSearchQuery } from '../../../lib/search-query-limits';
import type { AnthropicToolDef, ToolContext } from '../types';

export const searchConversationHistoryDef: AnthropicToolDef = {
  name: 'search_conversation_history',
  description:
    'Search your conversation history with the user. Long input is truncated to the configured search query length and term limits. The response reports the effective query and whether truncation occurred.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: `Search query — keywords or phrases to find in past messages.`,
      },
      limit: {
        type: 'number',
        description: `Max results to return. Defaults to ${DEFAULT_SAM_SEARCH_LIMIT}.`,
      },
    },
    required: ['query'],
  },
};

export async function searchConversationHistory(
  input: { query: string; limit?: number },
  ctx: ToolContext
): Promise<unknown> {
  if (!input.query?.trim()) {
    return { error: 'Query is required' };
  }

  if (!ctx.searchMessages) {
    return { error: 'Search is not available in this context' };
  }

  const limit = Math.min(input.limit || DEFAULT_SAM_SEARCH_LIMIT, DEFAULT_SAM_SEARCH_MAX_LIMIT);
  const normalizedQuery = normalizeSearchQuery(
    input.query,
    ctx.env as { SEARCH_QUERY_MAX_LENGTH?: string; SEARCH_QUERY_MAX_TERMS?: string }
  );
  const results = ctx.searchMessages(normalizedQuery.query, limit);

  return {
    results,
    count: results.length,
    ...normalizedQuery,
  };
}
