/**
 * MCP tool definitions — message-anchored comment tools.
 */

export const COMMENT_TOOLS = [
  {
    name: 'list_message_comment_threads',
    description:
      'List bounded message-anchored comment threads for your current SAM chat session. Use this to find open user feedback tied to exact source messages before changing related work. Returns summaries with quoted source-message context; use get_message_comment_thread for full replies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
        status: {
          type: 'string',
          enum: ['open', 'sent', 'resolved', 'all'],
          description: 'Filter by thread status. Defaults to open.',
        },
        messageId: {
          type: 'string',
          description: 'Optional source message ID filter.',
        },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from the previous response.',
        },
        limit: {
          type: 'number',
          description: 'Max threads to return (default 10, server capped).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_message_comment_thread',
    description:
      'Inspect one message-anchored comment thread in your current SAM chat session, including replies and quoted source-message context. Calling this marks the thread observed by this agent through the comment read adapter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadId: {
          type: 'string',
          description: 'The comment thread ID to inspect.',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_message_comment_thread',
    description:
      'Create an agent-authored message-anchored comment thread in your current SAM chat session. Author identity and provenance are derived from your verified MCP token; do not provide author fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description: 'Source chat message ID to anchor the comment to.',
        },
        quote: {
          type: 'string',
          description: 'Optional short quote from the source message for citation context.',
        },
        body: {
          type: 'string',
          description: 'Comment body (server sanitized and length capped).',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
      },
      required: ['messageId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_to_message_comment_thread',
    description:
      'Add an agent-authored reply to an existing message comment thread in your current SAM chat session. Author identity and provenance are derived from your verified MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadId: {
          type: 'string',
          description: 'The comment thread ID to reply to.',
        },
        body: {
          type: 'string',
          description: 'Reply body (server sanitized and length capped).',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
      },
      required: ['threadId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_message_comment_thread',
    description:
      'Resolve a message comment thread in your current SAM chat session after the feedback has been addressed. Actor identity is derived from your verified MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadId: {
          type: 'string',
          description: 'The comment thread ID to resolve.',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reopen_message_comment_thread',
    description:
      'Reopen a resolved message comment thread in your current SAM chat session when more work is needed. Actor identity is derived from your verified MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadId: {
          type: 'string',
          description: 'The comment thread ID to reopen.',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional safety check. If provided, it must match your current chat session; other sessions are rejected.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
];
