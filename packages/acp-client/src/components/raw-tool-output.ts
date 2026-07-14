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

function extractRawOutputText(
  value: unknown,
  depth = 0,
  remaining = MAX_ITEM_TEXT_LENGTH
): string {
  if (depth > 5 || remaining <= 0 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, remaining).trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, remaining);
  }
  if (Array.isArray(value)) {
    let output = '';
    for (const entry of value) {
      const text = extractRawOutputText(entry, depth + 1, remaining - output.length);
      if (!text) continue;
      output += `${output ? '\n' : ''}${text}`;
      if (output.length >= remaining) break;
    }
    return output.slice(0, remaining);
  }
  if (!isJsonRecord(value)) return '';
  for (const key of ['text', 'output', 'content', 'message', 'result']) {
    const text = extractRawOutputText(value[key], depth + 1, remaining);
    if (text) return text;
  }
  let output = '';
  for (const key of Object.keys(value).sort()) {
    const separator = output ? '\n' : '';
    const budget = remaining - output.length - separator.length;
    if (budget <= 0) break;
    const text = sensitiveOutputKey(key)
      ? '[redacted]'
      : extractRawOutputText(value[key], depth + 1, budget);
    if (!text) continue;
    output += `${separator}${key}: ${text}`.slice(0, remaining - output.length);
  }
  return output;
}

function sensitiveOutputKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[_\-.]/g, '');
  return [
    'token',
    'secret',
    'credential',
    'password',
    'authorization',
    'apikey',
    'privatekey',
    'accesskey',
    'command',
    'argument',
    'args',
  ].some((marker) => normalized.includes(marker));
}

function truncateLiveOutput(value: string): string {
  return value.length <= MAX_ITEM_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_ITEM_TEXT_LENGTH)}\n... [truncated]`;
}
