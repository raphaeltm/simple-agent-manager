import { expectJsonRecord } from '../../lib/runtime-validation';
import type { EventBusCursor } from './event-bus-contracts';
import { EventBusCursorError } from './event-bus-contracts';

export function encodeEventBusCursor(cursor: EventBusCursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function decodeEventBusCursor(raw: string, subscriptionId: string): EventBusCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(raw)) as unknown;
  } catch {
    throw new EventBusCursorError();
  }
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
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
