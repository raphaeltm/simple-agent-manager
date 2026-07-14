import type { ToolCallContentItem } from '../hooks/useAcpMessages';
import { MAX_ITEM_TEXT_LENGTH } from '../hooks/useAcpMessages.helpers';
import { isJsonRecord } from '../runtime-validation';

/** Live-only fallback for reviewed ACP wrapper result shapes. Persisted history
 * receives the equivalent normalized content from the VM-agent boundary. */
export function normalizeRawToolOutput(rawOutput: unknown): ToolCallContentItem | null {
  if (!isJsonRecord(rawOutput)) return null;
  if (typeof rawOutput.formatted_output === 'string' && rawOutput.formatted_output.trim()) {
    const output = truncateLiveOutput(rawOutput.formatted_output);
    return {
      type: 'terminal',
      text: output,
      data: {
        type: 'terminal',
        output,
        ...(typeof rawOutput.exit_code === 'number' ? { exitCode: rawOutput.exit_code } : {}),
      },
    };
  }
  const isError = rawOutput.error !== undefined && rawOutput.error !== null;
  const text = extractRawOutputText(isError ? rawOutput.error : rawOutput.result);
  if (!text) return null;
  const displayText = truncateLiveOutput(isError ? `Error: ${text}` : text);
  return {
    type: 'content',
    text: displayText,
    data: { type: 'content', content: { type: 'text', text: displayText } },
  };
}

function extractRawOutputText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => extractRawOutputText(entry, depth + 1)).filter(Boolean).join('\n');
  }
  if (!isJsonRecord(value)) return '';
  for (const key of ['text', 'output', 'content', 'message', 'result']) {
    const text = extractRawOutputText(value[key], depth + 1);
    if (text) return text;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function truncateLiveOutput(value: string): string {
  return value.length <= MAX_ITEM_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_ITEM_TEXT_LENGTH)}\n... [truncated]`;
}
