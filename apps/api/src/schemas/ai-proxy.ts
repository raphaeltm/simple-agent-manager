/**
 * Zod schemas for OpenAI-compatible AI proxy request/response validation.
 *
 * The proxy forwards requests to Cloudflare Workers AI binding,
 * which accepts standard OpenAI format including tools/function calling.
 * Schemas use .passthrough() to allow extra fields (stream_options,
 * top_p, top_k, etc.) that OpenCode/Vercel AI SDK sends, without rejecting
 * them as unknown keys.
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
}).passthrough();

/** Individual chat message in OpenAI format (all roles). */
export const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: z.union([z.string().max(MAX_MESSAGE_CONTENT_LENGTH), z.array(z.unknown())]),
  }).passthrough(),
  z.object({
    role: z.literal('user'),
    content: z.union([z.string().max(MAX_MESSAGE_CONTENT_LENGTH), z.array(z.unknown())]),
  }).passthrough(),
  z.object({
    role: z.literal('assistant'),
    content: z.union([z.string().max(MAX_MESSAGE_CONTENT_LENGTH), z.array(z.unknown())]).nullable().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  }).passthrough(),
  z.object({
    role: z.literal('tool'),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
    tool_call_id: z.string(),
  }).passthrough(),
]);

/** Function definition inside a tool. */
const functionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();

/** Tool definition (OpenAI format). */
const toolSchema = z.object({
  type: z.literal('function'),
  function: functionDefinitionSchema,
}).passthrough();

/** OpenAI-compatible chat completion request body.
 * Uses .passthrough() to accept extra fields like stream_options,
 * top_p, top_k, frequency_penalty, etc. that various AI SDK clients send. */
export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  tools: z.array(toolSchema).max(MAX_TOOLS_PER_REQUEST).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ]).optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
