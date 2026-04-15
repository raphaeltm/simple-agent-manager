/**
 * Zod schemas for OpenAI-compatible AI proxy request/response validation.
 */
import { z } from 'zod';

/** Max content length per message (128 KB). */
const MAX_MESSAGE_CONTENT_LENGTH = 131_072;

/** Max messages per request. */
const MAX_MESSAGES_PER_REQUEST = 100;

/** Max tool definitions per request. */
const MAX_TOOLS_PER_REQUEST = 128;

/** Tool call reference in an assistant message. */
const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/** Individual chat message in OpenAI format. */
export const chatMessageSchema = z.discriminatedUnion('role', [
  // System message
  z.object({
    role: z.literal('system'),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
  }),
  // User message
  z.object({
    role: z.literal('user'),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
  }),
  // Assistant message (may include tool_calls)
  z.object({
    role: z.literal('assistant'),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).nullable().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  // Tool result message
  z.object({
    role: z.literal('tool'),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
    tool_call_id: z.string(),
  }),
]);

/** Function definition inside a tool. */
const functionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().nullable().optional(),
});

/** Tool definition (OpenAI format). */
const toolSchema = z.object({
  type: z.literal('function'),
  function: functionDefinitionSchema,
});

/** OpenAI-compatible chat completion request body. */
export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(toolSchema).max(MAX_TOOLS_PER_REQUEST).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ]).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
