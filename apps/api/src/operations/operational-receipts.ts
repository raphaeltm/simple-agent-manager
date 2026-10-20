import { operationReceiptId } from '../services/cli-operation-receipts';
import { requireSessionWriter } from '../services/session-access';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import type { OperationContext } from './types';

const keyedWrites = new Set([
  'sam_chat_start',
  'sam_chat_send',
  'sam_chat_interrupt',
  'sam_agent_answer',
  'sam_work_stop',
  'sam_idea_create',
  'sam_idea_update',
]);
const safeStatuses = new Set([
  'queued',
  'running',
  'completed',
  'cancelled',
  'idle',
  'answered',
  'already_answered',
  'pending',
  'draft',
  'ready',
  'failed',
  'sleeping',
  'in_progress',
]);
/** Deliberately not the saved response: it may contain user text or permission material. */
export async function readOperation(
  ctx: OperationContext,
  input: { projectId: string; operation: string; requestKey: string }
) {
  await authorizeProjectOperation(ctx, input.projectId);
  if (!keyedWrites.has(input.operation))
    throw new OperationError(
      'invalid_input',
      'Operation has no inspectable Connector write receipt'
    );
  const receiptId = await operationReceiptId(
    input.projectId,
    ctx.actor.userId,
    'CONNECTOR',
    input.operation,
    input.requestKey
  );
  const row = await ctx.env.DATABASE.prepare(
    `SELECT state,response_json,created_at
    FROM cli_operation_receipts WHERE receipt_id=? AND project_id=? AND user_id=?`
  )
    .bind(receiptId, input.projectId, ctx.actor.userId)
    .first<{ state: string; response_json: string | null; created_at: string }>();
  if (!row) return { receiptId, state: 'unknown', evidence: 'no_retained_receipt', result: null };
  const result: Record<string, string | boolean> = {};
  try {
    const value: unknown = JSON.parse(row.response_json ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const saved = value as Record<string, unknown>;
      if (typeof saved.sessionId === 'string') {
        await requireSessionWriter(ctx.env, input.projectId, saved.sessionId, ctx.actor.userId, {
          action: 'inspect this operation result',
        });
      }
      for (const key of ['sessionId', 'taskId', 'messageId', 'deliveryId', 'ideaId']) {
        const field = saved[key];
        if (typeof field === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(field)) result[key] = field;
      }
      for (const key of ['status', 'state']) {
        const field = saved[key];
        if (typeof field === 'string' && safeStatuses.has(field)) result[key] = field;
      }
      if (typeof saved.accepted === 'boolean') result.accepted = saved.accepted;
    }
  } catch (error) {
    // Authorization errors must not be swallowed as corrupt receipt data.
    if (error instanceof Error && error.name !== 'SyntaxError') throw error;
  }
  return {
    receiptId,
    state: row.state === 'completed' ? 'completed' : 'pending_uncertain',
    createdAt: row.created_at,
    result,
    completionMeaning: 'handler_response_saved_not_runtime_completion',
  };
}
