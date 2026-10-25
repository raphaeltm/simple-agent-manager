/**
 * Byte budgets for app-facing results that can grow with the data they read (transcripts, team
 * status). `routes/connector-mcp.ts` rejects any response over `CONNECTOR_RESPONSE_MAX_BYTES`, and
 * a response carries its result twice: as structured content, and as text holding the result's
 * JSON escaped once more, where a quote or backslash costs 4 bytes instead of 2. Results are
 * therefore measured the way that check counts them, never by characters alone.
 */
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { utf8ByteLength } from '../lib/utf8';
import {
  DEFAULT_CONNECTOR_RESPONSE_MAX_BYTES,
  MIN_CONNECTOR_RESPONSE_MAX_BYTES,
} from '../services/connector-limits';

/** Share of the response cap a result may use; the rest is the adapter's own framing. */
const RESULT_SHARE_OF_RESPONSE_CAP = 0.9;

/** Bytes kept free in a result for the fields around a trimmed list (cursors, notes, flags). */
export const RESULT_FRAMING_RESERVE_BYTES = 4_000;

/** Bytes `value` adds to a Connector response: its JSON, plus that JSON escaped as text. */
export function responseBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? 'null';
  return utf8ByteLength(json) + utf8ByteLength(JSON.stringify(json));
}

/** Response bytes one result may use. */
export function resultByteBudget(env: Env): number {
  const cap = Math.max(
    MIN_CONNECTOR_RESPONSE_MAX_BYTES,
    parsePositiveInt(env.CONNECTOR_RESPONSE_MAX_BYTES, DEFAULT_CONNECTOR_RESPONSE_MAX_BYTES)
  );
  return Math.floor(cap * RESULT_SHARE_OF_RESPONSE_CAP);
}

/** The longest prefix of `text` that adds at most `maxBytes` to a response. */
export function fitText(text: string, maxBytes: number): string {
  if (responseBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (responseBytes(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}
