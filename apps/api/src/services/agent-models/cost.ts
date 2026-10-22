/**
 * Spend estimates for agent model calls, from Cloudflare's published per-model prices.
 *
 * A call reserves a deliberately generous estimate before it runs and settles a cost computed
 * from the usage the model reports afterwards. Amounts are integer micro-USD. Everything here
 * is an estimate from published prices, not an invoice line.
 */
import type { AgentModelPrice } from '@simple-agent-manager/shared';

import { maybeJsonRecord } from '../../lib/runtime-validation';

export type PriceMeasure =
  | 'input-tokens'
  | 'output-tokens'
  | 'cached-input-tokens'
  | 'audio-minutes'
  | 'characters'
  | 'tiles'
  | 'steps'
  | 'requests';

interface PricedMeasure {
  measure: PriceMeasure;
  /** USD per measured quantity (already divided for per-million and per-1k units). */
  usdPerUnit: number;
}

/** Workers AI image models default to 1024×1024 output when width/height are omitted. */
const DEFAULT_IMAGE_EDGE_PX = 1024;
const TILE_EDGE_PX = 512;
/** Generous step count reserved when the input does not say. */
const DEFAULT_RESERVED_STEPS = 50;
/** Text is estimated at 3 characters per token, which over- rather than under-counts. */
const CHARS_PER_TOKEN = 3;
/** Long base64-looking strings are media, not prompt text. Counted as a fixed token block. */
const MEDIA_STRING_MIN_LENGTH = 4_096;
const MEDIA_TOKENS_PER_BLOB = 2_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;
/** Conservative audio size for reservations: 32 kbit/s ≈ 240 KB per minute. */
const RESERVED_AUDIO_BYTES_PER_MINUTE = 240_000;
const MICRO_USD_PER_USD = 1_000_000;

export function classifyPrice(price: AgentModelPrice): PricedMeasure | null {
  const unit = price.unit.trim().toLowerCase();
  // Websocket-only prices do not apply to request/response calls.
  if (unit.includes('websocket')) return null;
  const perMillion = /\bper\s+m(illion)?\b/.test(unit);
  if (perMillion && unit.includes('cached') && unit.includes('token')) {
    return { measure: 'cached-input-tokens', usdPerUnit: price.usd / 1_000_000 };
  }
  if (perMillion && unit.includes('input') && unit.includes('token')) {
    return { measure: 'input-tokens', usdPerUnit: price.usd / 1_000_000 };
  }
  if (perMillion && unit.includes('output') && unit.includes('token')) {
    return { measure: 'output-tokens', usdPerUnit: price.usd / 1_000_000 };
  }
  if (unit.includes('audio minute')) return { measure: 'audio-minutes', usdPerUnit: price.usd };
  if (/per\s+1k\s+char/.test(unit)) return { measure: 'characters', usdPerUnit: price.usd / 1000 };
  if (unit.includes('tile')) return { measure: 'tiles', usdPerUnit: price.usd };
  if (/\bper\s+step\b/.test(unit)) return { measure: 'steps', usdPerUnit: price.usd };
  if (unit.includes('request')) return { measure: 'requests', usdPerUnit: price.usd };
  return null;
}

export function classifyPrices(prices: readonly AgentModelPrice[]): PricedMeasure[] {
  return prices.map(classifyPrice).filter((entry): entry is PricedMeasure => entry !== null);
}

export type Quantities = Partial<Record<PriceMeasure, number>>;

interface InputScan {
  textChars: number;
  mediaBlobs: number;
  mediaBytes: number;
  promptChars: number;
}

function scanInput(value: unknown, scan: InputScan, key = ''): void {
  if (typeof value === 'string') {
    if (value.length >= MEDIA_STRING_MIN_LENGTH && BASE64_PATTERN.test(value.slice(0, 4_096))) {
      scan.mediaBlobs += 1;
      scan.mediaBytes += Math.floor((value.length * 3) / 4);
      return;
    }
    scan.textChars += value.length;
    if (key === 'text' || key === 'prompt' || key === 'content') scan.promptChars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    // A long array of byte values is binary media (some models take audio/images as int arrays).
    if (value.length >= MEDIA_STRING_MIN_LENGTH && typeof value[0] === 'number') {
      scan.mediaBlobs += 1;
      scan.mediaBytes += value.length;
      return;
    }
    for (const item of value) scanInput(item, scan, key);
    return;
  }
  const record = maybeJsonRecord(value);
  if (!record) return;
  for (const [childKey, child] of Object.entries(record)) scanInput(child, scan, childKey);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function requestedOutputTokens(input: Record<string, unknown>): number | null {
  return (
    positiveInteger(input.max_tokens) ??
    positiveInteger(input.max_completion_tokens) ??
    positiveInteger(input.max_output_tokens)
  );
}

function imageTiles(input: Record<string, unknown>): number {
  const width = positiveInteger(input.width) ?? DEFAULT_IMAGE_EDGE_PX;
  const height = positiveInteger(input.height) ?? DEFAULT_IMAGE_EDGE_PX;
  return Math.ceil(width / TILE_EDGE_PX) * Math.ceil(height / TILE_EDGE_PX);
}

/** Upper-bound quantities for a reservation, before the call runs. */
export function estimateReservationQuantities(
  input: Record<string, unknown>,
  options: { reservationOutputTokens: number }
): Quantities {
  const scan: InputScan = { textChars: 0, mediaBlobs: 0, mediaBytes: 0, promptChars: 0 };
  scanInput(input, scan);
  return {
    'input-tokens':
      Math.ceil(scan.textChars / CHARS_PER_TOKEN) + scan.mediaBlobs * MEDIA_TOKENS_PER_BLOB,
    'output-tokens': requestedOutputTokens(input) ?? options.reservationOutputTokens,
    'audio-minutes': Math.max(1, Math.ceil(scan.mediaBytes / RESERVED_AUDIO_BYTES_PER_MINUTE)),
    characters: Math.max(1, scan.promptChars || scan.textChars),
    tiles: imageTiles(input),
    steps:
      positiveInteger(input.num_steps) ?? positiveInteger(input.steps) ?? DEFAULT_RESERVED_STEPS,
    requests: 1,
  };
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Quantities the model reported. Output tokens it did not report are estimated from the size
 * of what it returned; anything else unreported falls back to the reservation.
 */
export function reportedQuantities(
  output: unknown,
  reserved: Quantities,
  observed: { outputChars: number }
): Quantities {
  const record = maybeJsonRecord(output);
  const usage = maybeJsonRecord(record?.usage);
  const details = maybeJsonRecord(usage?.prompt_tokens_details);
  const clairicInput = ['state_tokens', 'schema_tokens', 'image_tokens']
    .map((key) => numberAt(usage, key))
    .filter((value): value is number => value !== null);
  const inputTokens =
    numberAt(usage, 'prompt_tokens') ??
    numberAt(usage, 'input_tokens') ??
    (clairicInput.length > 0 ? clairicInput.reduce((sum, value) => sum + value, 0) : null);
  const outputTokens =
    numberAt(usage, 'completion_tokens') ??
    numberAt(usage, 'output_tokens') ??
    Math.ceil(observed.outputChars / CHARS_PER_TOKEN);
  const cachedTokens = numberAt(details, 'cached_tokens');
  const transcription = maybeJsonRecord(record?.transcription_info);
  const durationSeconds = numberAt(transcription, 'duration') ?? numberAt(record, 'duration');
  return {
    ...reserved,
    ...(inputTokens !== null ? { 'input-tokens': inputTokens } : {}),
    'output-tokens': outputTokens,
    ...(cachedTokens !== null ? { 'cached-input-tokens': cachedTokens } : {}),
    ...(durationSeconds !== null ? { 'audio-minutes': durationSeconds / 60 } : {}),
  };
}

/**
 * Cost of `quantities` at `prices`, in micro-USD, rounded up and at least 1 for a priced call.
 * Models without a usable published price cost `unpricedMicroUsd` per call.
 */
export function costMicroUsd(
  prices: readonly AgentModelPrice[],
  quantities: Quantities,
  unpricedMicroUsd: number
): number {
  const priced = classifyPrices(prices);
  if (priced.length === 0) return unpricedMicroUsd;
  const hasCachedRate = priced.some((entry) => entry.measure === 'cached-input-tokens');
  const cached = hasCachedRate ? (quantities['cached-input-tokens'] ?? 0) : 0;
  let usd = 0;
  for (const { measure, usdPerUnit } of priced) {
    let quantity = quantities[measure] ?? 0;
    // Cached prompt tokens are part of the input count; bill them once, at the cached rate.
    if (measure === 'input-tokens') quantity = Math.max(0, quantity - cached);
    usd += quantity * usdPerUnit;
  }
  return Math.max(1, Math.ceil(usd * MICRO_USD_PER_USD));
}
