import { expectJsonRecord } from '../../lib/runtime-validation';
import type { EventBusCursor } from './event-bus-contracts';
import { EventBusCursorError } from './event-bus-contracts';

export const DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH = 512;
const EVENT_BUS_CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING = '=';

export function encodeEventBusCursor(cursor: EventBusCursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function isEventBusCursorToken(
  raw: string,
  maxLength = DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH
): boolean {
  return raw.length <= maxLength && EVENT_BUS_CURSOR_ALPHABET.test(raw);
}

export function decodeEventBusCursor(
  raw: string,
  subscriptionId: string,
  maxLength = DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH
): EventBusCursor {
  if (!isEventBusCursorToken(raw, maxLength)) {
    throw new EventBusCursorError();
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as unknown;
    const record = expectJsonRecord(parsed, 'event_bus.cursor');
    if (record.version !== 1) throw new EventBusCursorError();
    if (record.subscriptionId !== subscriptionId) throw new EventBusCursorError();
    if (
      typeof record.afterSequence !== 'number' ||
      !Number.isSafeInteger(record.afterSequence) ||
      record.afterSequence < 0
    ) {
      throw new EventBusCursorError();
    }
    if (typeof record.afterDeliveryId !== 'string') throw new EventBusCursorError();
    return {
      version: 1,
      subscriptionId,
      afterSequence: record.afterSequence,
      afterDeliveryId: record.afterDeliveryId,
    };
  } catch (error) {
    if (error instanceof EventBusCursorError) throw error;
    throw new EventBusCursorError();
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return stripBase64Padding(btoa(binary).replaceAll('+', '-').replaceAll('/', '_'));
}

function decodeBase64Url(value: string): string {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return new TextDecoder().decode(bytes);
}

function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === BASE64_PADDING) end -= 1;
  return value.slice(0, end);
}
