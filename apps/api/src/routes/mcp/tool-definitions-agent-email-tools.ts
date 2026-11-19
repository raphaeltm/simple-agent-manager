/**
 * MCP tool definitions — agent email (preview).
 */

export const AGENT_EMAIL_TOOLS = [
  {
    name: 'reply_to_email',
    description:
      'Reply by email to the person whose email started this task. Only works in a task started by an email trigger. ' +
      'The reply goes only to the original sender, from the trigger’s own address, threaded under their email. ' +
      'Plain text only. Each run has a small reply limit, and failed attempts count toward it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: {
          type: 'string',
          description: 'Plain-text body of the reply. Do not repeat the original email.',
        },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
];
