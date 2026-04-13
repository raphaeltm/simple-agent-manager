/**
 * Zod schemas for OpenAI-compatible AI proxy request/response validation.
 */
import { z } from 'zod';

/** Max content length per message (128 KB). */
const MAX_MESSAGE_CONTENT_LENGTH = 131_072;

/** Max messages per request. */
const MAX_MESSAGES_PER_REQUEST = 100;

/** Individual chat message in OpenAI format. */
export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
});

/** OpenAI-compatible chat completion request body. */
export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
