/**
 * MCP tool definitions — library-file comment tools.
 *
 * Project-scoped (not session-scoped). Agents can list and create comment
 * threads on library files without needing a chat session.
 */

export const LIBRARY_FILE_COMMENT_TOOLS = [
  {
    name: 'list_library_file_comment_threads',
    description:
      'List comment threads on a project library file. Unlike message comments, these are project-scoped and do not require a chat session. Returns thread summaries; use get_message_comment_thread for full replies on message threads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The library file ID to list comments for (required).',
        },
        status: {
          type: 'string',
          enum: ['open', 'sent', 'resolved', 'all'],
          description: 'Filter by thread status. Defaults to open.',
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
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_library_file_comment_thread',
    description:
      'Create an agent-authored comment thread on a project library file. Author identity and provenance are derived from your verified MCP token; do not provide author fields. The comment is project-scoped and does not require a chat session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The library file ID to comment on (required).',
        },
        body: {
          type: 'string',
          description: 'Comment body (server sanitized and length capped).',
        },
        quote: {
          type: 'string',
          description: 'Optional short quote from the file for citation context.',
        },
      },
      required: ['fileId', 'body'],
      additionalProperties: false,
    },
  },
];
