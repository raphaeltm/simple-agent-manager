/**
 * Payload size management for the SAM agent loop.
 *
 * Two layers of protection against HTTP 413 errors:
 * 1. Truncate individual tool results before adding to LLM context
 * 2. Estimate total payload size and trim older messages before each LLM call
 *
 * Full tool results are always persisted to DB and streamed via SSE —
 * only the LLM's copy is truncated/trimmed.
 */

/** OpenAI message shape used by the agent loop and payload-size helpers. */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Truncate a tool result string if it exceeds maxBytes, preserving a notice. */
export function truncateToolResult(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) return content;
  return content.slice(0, maxBytes) +
    `\n\n[truncated — original was ${content.length} bytes, showing first ${maxBytes} bytes]`;
}

/** Estimate the byte size of the messages array for payload budgeting. */
export function estimateMessagesBytes(messages: OpenAIMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += m.content?.length ?? 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += tc.function.arguments.length + tc.function.name.length + 50;
      }
    }
    total += 50; // role, structure overhead
  }
  return total;
}

/**
 * Trim messages to fit within a byte budget.
 *
 * Strategy (applied in order):
 * 1. Truncate tool result content in older messages (keep last 3 turns intact)
 * 2. Drop oldest complete turns (user + assistant + tool_results as a group)
 * 3. Never drop the most recent user message or the current turn's messages
 */
export function trimMessagesToFit(
  messages: OpenAIMessage[],
  maxBytes: number,
  fixedOverheadBytes: number,
): OpenAIMessage[] {
  const budget = maxBytes - fixedOverheadBytes;
  if (estimateMessagesBytes(messages) <= budget) return messages;

  const trimmed = messages.map((m) => ({ ...m }));

  // Pass 1: Truncate tool results in older messages (skip last 6 messages ~3 turns)
  const protectedTail = 6;
  const truncateLimit = Math.max(0, trimmed.length - protectedTail);
  for (let i = 0; i < truncateLimit; i++) {
    const m = trimmed[i]!;
    if (m.role === 'tool' && m.content && m.content.length > 500) {
      m.content = m.content.slice(0, 500) + '\n\n[trimmed for context budget]';
    }
  }

  if (estimateMessagesBytes(trimmed) <= budget) return trimmed;

  // Pass 2: Drop oldest complete turns from the front
  // Find turn boundaries (a turn = user msg + optional assistant + optional tool results)
  while (trimmed.length > 2 && estimateMessagesBytes(trimmed) > budget) {
    // Always keep at least the last user message
    if (trimmed.length <= 1) break;

    // Find the end of the first turn: skip user, then skip assistant+tool messages
    let end = 0;
    // Skip first message (should be user)
    end++;
    // Skip following assistant and tool messages that belong to this turn
    while (end < trimmed.length && (trimmed[end]?.role === 'assistant' || trimmed[end]?.role === 'tool')) {
      end++;
    }

    // Don't drop if it would leave us with fewer than 2 messages
    if (trimmed.length - end < 2) break;

    trimmed.splice(0, end);
  }

  return trimmed;
}
