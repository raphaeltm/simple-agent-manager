import type { MiddlewareHandler } from 'hono';
import { cloneRawRequest } from 'hono/request';

import type { Env } from '../env';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function operationReceiptId(
  projectId: string,
  userId: string,
  method: string,
  path: string,
  key: string
): Promise<string> {
  return digest(JSON.stringify([projectId, userId, method, path, key]));
}

/** Invoked only after route auth/capability checks. A reserved intent is never
 * retried after an uncertain outcome, including a crash between side effects
 * and receipt completion. The caller reconciles using the stable receipt ID. */
export const cliOperationReceipt: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header('Idempotency-Key');
  if (!key) return next();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw errors.badRequest('Invalid Idempotency-Key');
  const projectId = c.req.param('projectId');
  if (!projectId) throw errors.badRequest('projectId is required');
  const requestLimit = receiptLimit(c.env.CLI_RECEIPT_REQUEST_MAX_BYTES, 256 * 1024);
  const responseLimit = receiptLimit(c.env.CLI_RECEIPT_RESPONSE_MAX_BYTES, 64 * 1024);
  const userId = getUserId(c);
  const path = new URL(c.req.url).pathname;
  const receiptId = await operationReceiptId(projectId, userId, c.req.method, path, key);
  const body = await boundedReceiptText(await cloneRawRequest(c.req), requestLimit);
  if (body === null) throw errors.badRequest('Keyed intent exceeds receipt boundary');
  const intentHash = await digest(body);
  const reservation = await c.env.DATABASE.prepare(
    `INSERT OR IGNORE INTO cli_operation_receipts
     (receipt_id, project_id, user_id, intent_hash, state) VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(receiptId, projectId, userId, intentHash)
    .run();
  c.header('SAM-Receipt-ID', receiptId);
  c.header('Cache-Control', 'private, no-store');
  if (!reservation.meta.changes) {
    const receipt = await c.env.DATABASE.prepare(
      'SELECT intent_hash, state, response_json, response_status FROM cli_operation_receipts WHERE receipt_id = ? AND project_id = ? AND user_id = ?'
    )
      .bind(receiptId, projectId, userId)
      .first<{
        intent_hash: string;
        state: string;
        response_json: string | null;
        response_status: number | null;
      }>();
    if (receipt?.intent_hash !== intentHash)
      throw errors.conflict('Idempotency key was used for a different intent');
    if (receipt.state !== 'completed' || receipt.response_json === null) {
      return c.json(
        {
          error: 'OUTCOME_UNKNOWN',
          message: 'Intent reserved; reconcile before submitting new work',
          receiptId,
        },
        409
      );
    }
    return new Response(receipt.response_json, {
      status: receipt.response_status ?? 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
        'SAM-Receipt-ID': receiptId,
        'SAM-Receipt-Replayed': 'true',
      },
    });
  }
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    const response = await boundedReceiptText(c.res.clone(), responseLimit);
    if (response === null) return;
    await c.env.DATABASE.prepare(
      "UPDATE cli_operation_receipts SET state = 'completed', response_json = ?, response_status = ? WHERE receipt_id = ? AND state = 'pending'"
    )
      .bind(response, c.res.status, receiptId)
      .run();
  }
};

function receiptLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw errors.internal('Invalid receipt size configuration');
  return value;
}

async function boundedReceiptText(
  source: Request | Response,
  maxBytes: number
): Promise<string | null> {
  if (!source.body) return '';
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
