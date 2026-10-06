import { isJsonRecord } from '@simple-agent-manager/shared';

import { ProjectEventCursorError } from './project-events-contracts';

const PROJECT_EVENT_CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING = '=';

export type ProjectEventSubscriptionEventsCursor = {
  version: 1;
  subscriptionId: string;
  afterMatchedAt: number;
  afterMatchId: string;
};

export function encodeProjectEventSubscriptionEventsCursor(
  cursor: ProjectEventSubscriptionEventsCursor
): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function isProjectEventSubscriptionEventsCursorToken(
  raw: string,
  maxLength: number
): boolean {
  return raw.length <= maxLength && PROJECT_EVENT_CURSOR_ALPHABET.test(raw);
}

export function decodeProjectEventSubscriptionEventsCursor(
  raw: string,
  subscriptionId: string,
  maxLength: number
): ProjectEventSubscriptionEventsCursor {
  if (!isProjectEventSubscriptionEventsCursorToken(raw, maxLength)) {
    throw new ProjectEventCursorError();
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as unknown;
    if (!isJsonRecord(parsed)) throw new ProjectEventCursorError();
    if (parsed.version !== 1) throw new ProjectEventCursorError();
    if (parsed.subscriptionId !== subscriptionId) throw new ProjectEventCursorError();
    if (
      typeof parsed.afterMatchedAt !== 'number' ||
      !Number.isSafeInteger(parsed.afterMatchedAt) ||
      parsed.afterMatchedAt < 0
    ) {
      throw new ProjectEventCursorError();
    }
    if (typeof parsed.afterMatchId !== 'string') throw new ProjectEventCursorError();
    return {
      version: 1,
      subscriptionId,
      afterMatchedAt: parsed.afterMatchedAt,
      afterMatchId: parsed.afterMatchId,
    };
  } catch (error) {
    if (error instanceof ProjectEventCursorError) throw error;
    throw new ProjectEventCursorError();
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
    .padEnd(Math.ceil(value.length / 4) * 4, BASE64_PADDING);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return new TextDecoder().decode(bytes);
}

function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === BASE64_PADDING) end -= 1;
  return value.slice(0, end);
}
