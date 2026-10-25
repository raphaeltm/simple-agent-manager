/**
 * Byte budgets for app-facing results that can grow with the data they read (transcripts, team
 * status). `routes/connector-mcp.ts` rejects any response over `CONNECTOR_RESPONSE_MAX_BYTES`,
 * and the MCP envelope carries a result twice (as text and as structured content) with the text
 * copy escaped once more, so a result must stay well under half of that cap. Character limits
 * alone cannot guarantee the fit, because text can be multi-byte.
 */
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { utf8ByteLength } from '../lib/utf8';
import {
  DEFAULT_CONNECTOR_RESPONSE_MAX_BYTES,
  MIN_CONNECTOR_RESPONSE_MAX_BYTES,
} from '../services/connector-limits';

/** Share of the Connector response cap one result may use (the envelope doubles it). */
const RESULT_SHARE_OF_RESPONSE_CAP = 0.4;

/** Bytes kept free in a result for the fields around a trimmed list (cursors, notes, flags). */
export const RESULT_FRAMING_RESERVE_BYTES = 2_000;

/** UTF-8 size of `value` serialized as JSON. */
export function jsonBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) ?? '');
}

export function resultByteBudget(env: Env): number {
  const cap = Math.max(
    MIN_CONNECTOR_RESPONSE_MAX_BYTES,
    parsePositiveInt(env.CONNECTOR_RESPONSE_MAX_BYTES, DEFAULT_CONNECTOR_RESPONSE_MAX_BYTES)
  );
  return Math.floor(cap * RESULT_SHARE_OF_RESPONSE_CAP);
}

/** The longest prefix of `text` whose UTF-8 encoding fits `maxBytes`. */
export function fitUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}
