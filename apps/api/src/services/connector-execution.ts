import { protectedFormReceiptHash } from '../durable-objects/interaction-store-form';
import type { Env } from '../env';
import { takeRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { AppError } from '../middleware/error';
import { OperationError } from '../operations/errors';
import type { OperationContext } from '../operations/types';
import { operationReceiptId } from './cli-operation-receipts';
import { getConnectorSettings } from './connector-settings';
import { recordActivityEvent } from './project-data';

/** SQL upsert makes parallel requests compete for the same bounded budget. */
export async function consumeConnectorBudget(
  env: Env,
  userId: string,
  budget: string,
  limit: number,
  windowMs: number
): Promise<void> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const result = await env.DATABASE.prepare(
    `
    INSERT INTO connector_rate_limits (user_id, budget, window_start, used) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, budget) DO UPDATE SET window_start = excluded.window_start,
      used = CASE WHEN connector_rate_limits.window_start = excluded.window_start
        THEN connector_rate_limits.used + 1 ELSE 1 END
    WHERE connector_rate_limits.window_start != excluded.window_start OR connector_rate_limits.used < ?
  `
  )
    .bind(userId, budget, windowStart, limit)
    .run();
  if (!result.meta.changes) {
    throw new OperationError(
      'rate_limited',
      'Connector limit reached',
      `Try again after ${new Date(windowStart + windowMs).toISOString()}.`
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function hashIntent(input: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(input)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

/** Called inside an operation, after its current resource/capability checks.
 * An uncertain write stays reserved forever rather than provisioning twice. */
export async function executeConnectorWrite<T>(
  ctx: OperationContext,
  operation: string,
  input: Record<string, unknown>,
  run: () => Promise<T>,
  preflight?: () => Promise<void>
): Promise<T> {
  if (ctx.actor.via !== 'connector' && ctx.actor.via !== 'pat') {
    await preflight?.();
    return run();
  }
  const settings = ctx.connectorSettings ?? (await getConnectorSettings(ctx.env));
  if (!settings.enabled || !settings.writeEnabled || !ctx.actor.scopes.has('sam.write')) {
    throw new OperationError(
      'forbidden',
      'Connector writes are unavailable',
      'Check your grant and installation settings.'
    );
  }
  const projectId = safeId(input.projectId);
  const key = ctx.idempotencyKey;
  let receiptId: string | undefined;
  let intentHash: string | undefined;
  const readReceipt = async (): Promise<{ value: T } | null> => {
    if (!receiptId) return null;
    const receipt = await ctx.env.DATABASE.prepare(
      'SELECT intent_hash,state,response_json FROM cli_operation_receipts WHERE receipt_id=? AND project_id=? AND user_id=?'
    )
      .bind(receiptId, projectId, ctx.actor.userId)
      .first<{ intent_hash: string; state: string; response_json: string | null }>();
    if (!receipt) return null;
    if (receipt.intent_hash !== intentHash)
      throw new OperationError('conflict', 'requestKey already identifies a different request.');
    if (receipt.state !== 'completed' || receipt.response_json === null)
      throw new OperationError(
        'conflict',
        'Previous outcome is uncertain; do not submit a new start.',
        `Check work in SAM; receipt ${receiptId}.`
      );
    const value: unknown = JSON.parse(receipt.response_json);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new OperationError('unavailable', 'Saved operation receipt is invalid.');
    return { value: value as T };
  };
  if (key) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key) || !projectId)
      throw new OperationError(
        'invalid_input',
        'A requestKey requires a projectId and 1–128 safe characters.'
      );
    receiptId = await operationReceiptId(projectId, ctx.actor.userId, 'CONNECTOR', operation, key);
    intentHash = await hashIntent(input);
    // Forms may contain low-entropy secrets; retain only a keyed intent fingerprint.
    if (operation === 'sam_agent_answer' && input.formContent !== undefined)
      intentHash = await protectedFormReceiptHash(
        getCredentialEncryptionKey(ctx.env),
        String(input.interactionId),
        intentHash
      );
    const previous = await readReceipt();
    if (previous) return previous.value;
  }
  // Validation/authority preparation and budgets cannot poison a key: no receipt exists yet.
  // Once run() begins, unknown outcomes remain reserved; even a 4xx may follow a side effect.
  await preflight?.();
  await consumeConnectorBudget(
    ctx.env,
    ctx.actor.userId,
    'write',
    settings.writeRateLimitPerMinute,
    60_000
  );
  if (operation === 'sam_chat_start') {
    await consumeConnectorBudget(
      ctx.env,
      ctx.actor.userId,
      'starts_hour',
      settings.maxStartsPerUserPerHour,
      3_600_000
    );
    await consumeConnectorBudget(
      ctx.env,
      ctx.actor.userId,
      'starts_day',
      settings.maxStartsPerUserPerDay,
      86_400_000
    );
  }
  if (receiptId) {
    const reserved = await ctx.env.DATABASE.prepare(
      "INSERT OR IGNORE INTO cli_operation_receipts (receipt_id,project_id,user_id,intent_hash,state) VALUES (?,?,?,?,'pending')"
    )
      .bind(receiptId, projectId, ctx.actor.userId, intentHash)
      .run();
    if (!reserved.meta.changes) {
      const concurrent = await readReceipt();
      if (concurrent) return concurrent.value;
      throw new OperationError(
        'unavailable',
        'Operation receipt disappeared; inspect work before retrying'
      );
    }
  }
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Only an explicit in-process effect boundary can prove that no task work
    // started. A plain 4xx/5xx may follow persistence/provisioning and stays pending.
    const rejectedBeforeEffects = takeRejectedBeforeEffects(error);
    if (receiptId && rejectedBeforeEffects) {
      await ctx.env.DATABASE.prepare(
        "DELETE FROM cli_operation_receipts WHERE receipt_id=? AND project_id=? AND user_id=? AND intent_hash=? AND state='pending'"
      )
        .bind(receiptId, projectId, ctx.actor.userId, intentHash)
        .run();
    }
    throw error;
  }
  if (projectId) {
    const data =
      result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    await recordActivityEvent(
      ctx.env,
      projectId,
      'connector.operation',
      'user',
      ctx.actor.userId,
      null,
      safeId(input.sessionId) ?? safeId(data.sessionId),
      safeId(input.taskId) ?? safeId(data.taskId) ?? safeId(data.ideaId),
      { via: 'connector', clientName: ctx.actor.clientName ?? 'Connector', operation }
    );
  }
  if (receiptId) {
    const serialized = JSON.stringify(result);
    const maxBytes = Number(ctx.env.CLI_RECEIPT_RESPONSE_MAX_BYTES ?? 65536);
    if (
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      new TextEncoder().encode(serialized).length <= maxBytes
    ) {
      await ctx.env.DATABASE.prepare(
        `UPDATE cli_operation_receipts SET state = 'completed', response_json = ?, response_status = 200
          WHERE receipt_id = ? AND state = 'pending'`
      )
        .bind(serialized, receiptId)
        .run();
    }
  }
  return result;
}

const AUDIT_INPUT_FIELDS = new Set([
  'projectId',
  'taskId',
  'sessionId',
  'ideaId',
  'message',
  'content',
  'title',
  'priority',
  'status',
  'append',
  'taskMode',
  'agentProfileId',
  'skillId',
  'requestKey',
  'interactionId',
  'optionId',
  'decline',
  'formContent',
  'markerId',
  'answer',
]);
function auditResourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(
    value
  )
    ? value
    : null;
}

/** Every write invocation, including denied requests and receipt replays, is audited.
 * Called by defineOperation before authority checks; no input values are retained. */
export async function auditConnectorWrite<T>(
  ctx: OperationContext,
  operation: string,
  rawInput: unknown,
  run: () => Promise<T>
): Promise<T> {
  if (ctx.actor.via !== 'connector' && ctx.actor.via !== 'pat') return run();
  const input =
    rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
  const projectId = auditResourceId(input.projectId);
  const auditId = crypto.randomUUID();
  // Only names of input fields and strictly validated resource identifiers are retained.
  await ctx.env.DATABASE.prepare(
    `INSERT INTO connector_operation_audit
    (id, user_id, via, client_id, client_name, operation, project_id, target_id, input_summary, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(
      auditId,
      ctx.actor.userId,
      ctx.actor.via,
      ctx.actor.clientId ?? null,
      ctx.actor.clientName ?? null,
      operation,
      projectId,
      auditResourceId(input.taskId) ??
        auditResourceId(input.sessionId) ??
        auditResourceId(input.ideaId),
      JSON.stringify(
        Object.keys(input)
          .filter((name) => AUDIT_INPUT_FIELDS.has(name))
          .sort((left, right) => left.localeCompare(right))
      )
    )
    .run();
  try {
    const result = await run();
    await ctx.env.DATABASE.prepare(
      "UPDATE connector_operation_audit SET result = 'success' WHERE id = ?"
    )
      .bind(auditId)
      .run();
    return result;
  } catch (error) {
    const code =
      error instanceof OperationError
        ? error.code
        : error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)
          ? 'forbidden'
          : 'unavailable';
    await ctx.env.DATABASE.prepare('UPDATE connector_operation_audit SET result = ? WHERE id = ?')
      .bind(code, auditId)
      .run();
    throw error;
  }
}
