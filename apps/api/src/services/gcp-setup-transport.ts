import * as v from 'valibot';

import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';

export const SERVICE_USAGE_URL = 'https://serviceusage.googleapis.com/v1';

export const IAM_URL = 'https://iam.googleapis.com/v1';

const pollOperationSchema = v.object({
  done: v.optional(v.boolean()),
  error: v.optional(v.object({ message: v.string() })),
});

/**
 * Poll a GCP long-running operation until complete.
 */
export async function pollOperation(
  oauthToken: string,
  operationName: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min max
  let delayMs = 2000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // Some operations use different base URLs depending on the API
    let url: string;
    if (operationName.startsWith('operations/')) {
      url = `${SERVICE_USAGE_URL}/${operationName}`;
    } else {
      url = `${IAM_URL}/${operationName}`;
    }

    const res = await fetchWithTimeout(
      url,
      {
        headers: { Authorization: `Bearer ${oauthToken}` },
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.text();
      throw new GcpApiError({
        step: 'poll_operation',
        message: `Failed to poll operation (${res.status})`,
        statusCode: res.status,
        rawBody: body,
      });
    }

    const op = await readResponseJson(res, pollOperationSchema, 'gcp.operation.poll');
    if (op.error) {
      throw new GcpApiError({
        step: 'poll_operation',
        message: 'GCP operation failed',
        rawBody: op.error.message,
      });
    }
    if (op.done) {
      return;
    }

    delayMs = Math.min(delayMs * 1.5, 10_000);
  }

  throw new GcpApiError({ step: 'poll_operation', message: 'GCP operation timed out' });
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
