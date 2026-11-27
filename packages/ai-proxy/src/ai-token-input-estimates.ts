/**
 * Input-token estimates for calls whose upstream reported no usage. Split out of
 * ai-token-usage-accounting.ts (rule 18), which re-exports both functions.
 */
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

export const UTF8 = new TextEncoder();

export function estimateInputTokensFromMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;

  const totalChars = messages.reduce((sum: number, message: unknown) => {
    const record = maybeJsonRecord(message);
    return sum + estimateContentChars(record?.content);
  }, 0);

  return Math.ceil(totalChars / 4);
}

/**
 * Missing-usage estimate for a parsed passthrough request. Include system prompts, schemas,
 * names and structured tool history, not only message text. Serialized control fields add
 * small overhead; their numeric values never multiply the estimate. Measured usage wins.
 */
export function estimateInputTokensFromRequest(body: Record<string, unknown>): number {
  return Math.ceil(UTF8.encode(JSON.stringify(body)).byteLength / 4);
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;

  return content.reduce((sum: number, part: unknown) => {
    const record = maybeJsonRecord(part);
    if (typeof record?.text === 'string') return sum + record.text.length;
    if (typeof record?.content === 'string') return sum + record.content.length;
    return sum;
  }, 0);
}
