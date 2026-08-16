import type { Env } from '../env';
import type { PersistErrorInput } from './observability';
import { serializeBoundedContext } from './observability';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MESSAGE_MAX_LENGTH = 2048;
const DEFAULT_STACK_MAX_LENGTH = 4096;
const DEFAULT_USER_AGENT_MAX_LENGTH = 512;
const DEFAULT_CONTEXT_MAX_LENGTH = 8192;
const VALID_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);
const VALID_LEVELS = new Set<string>(['error', 'warn', 'info']);

interface StrictErrorRow {
  source: string;
  level: string;
  message: string;
  node_id: string | null;
  workspace_id: string | null;
  task_id: string | null;
  session_id: string | null;
  timestamp: number;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function maxBatchSize(env?: Env): number {
  const parsed = Number.parseInt(env?.OBSERVABILITY_ERROR_BATCH_SIZE ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expectedLevel(input: PersistErrorInput): string {
  return input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';
}

function hasCorrelationConflict(row: StrictErrorRow | null, input: PersistErrorInput): boolean {
  const taskIdConflict = Boolean(input.taskId && row?.task_id && row.task_id !== input.taskId);
  const sessionIdConflict = Boolean(
    input.sessionId && row?.session_id && row.session_id !== input.sessionId
  );
  return taskIdConflict || sessionIdConflict;
}

function strictRowMatchesInput(
  row: StrictErrorRow | null,
  input: PersistErrorInput,
  timestamp: number,
  messageMaxLength: number
): boolean {
  return Boolean(
    row &&
    row.source === input.source &&
    row.level === expectedLevel(input) &&
    row.message === truncate(input.message, messageMaxLength) &&
    row.node_id === (input.nodeId ?? null) &&
    row.workspace_id === (input.workspaceId ?? null) &&
    row.timestamp === timestamp &&
    !hasCorrelationConflict(row, input)
  );
}

function needsCorrelationEnrichment(row: StrictErrorRow, input: PersistErrorInput): boolean {
  return Boolean((input.taskId && !row.task_id) || (input.sessionId && !row.session_id));
}

function hasRequestedCorrelation(row: StrictErrorRow | null, input: PersistErrorInput): boolean {
  return Boolean(
    row &&
    (!input.taskId || row.task_id === input.taskId) &&
    (!input.sessionId || row.session_id === input.sessionId)
  );
}

/** Strict, idempotent persistence for restart-safe VM outboxes. */
export async function persistErrorBatchStrict(
  db: D1Database,
  inputs: PersistErrorInput[],
  env?: Env
): Promise<void> {
  const limit = maxBatchSize(env);
  const messageMaxLength = positiveInteger(
    env?.OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH,
    DEFAULT_MESSAGE_MAX_LENGTH
  );
  const stackMaxLength = positiveInteger(
    env?.OBSERVABILITY_ERROR_STACK_MAX_LENGTH,
    DEFAULT_STACK_MAX_LENGTH
  );
  const userAgentMaxLength = positiveInteger(
    env?.OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH,
    DEFAULT_USER_AGENT_MAX_LENGTH
  );
  const contextMaxLength = positiveInteger(
    env?.OBSERVABILITY_ERROR_CONTEXT_MAX_LENGTH,
    DEFAULT_CONTEXT_MAX_LENGTH
  );
  if (inputs.length > limit) {
    throw new Error(`Strict observability batch exceeds configured limit of ${limit}`);
  }
  if (inputs.some((input) => !input.id)) {
    throw new Error('Strict observability persistence requires caller-supplied IDs');
  }
  const defaultTimestamp = Date.now();
  const stableInputs = inputs.map((input) => ({
    input,
    timestamp: input.timestamp ?? defaultTimestamp,
  }));
  const statements = stableInputs.map(({ input, timestamp }) => {
    const source = VALID_SOURCES.has(input.source) ? input.source : 'api';
    const level = input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';
    return db
      .prepare(
        `INSERT OR IGNORE INTO platform_errors
         (id, source, level, message, stack, context, user_id, node_id, workspace_id,
          task_id, session_id, ip_address, user_agent, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        source,
        level,
        truncate(input.message, messageMaxLength),
        input.stack ? truncate(input.stack, stackMaxLength) : null,
        input.context ? serializeBoundedContext(input.context, contextMaxLength) : null,
        input.userId ?? null,
        input.nodeId ?? null,
        input.workspaceId ?? null,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.ipAddress ?? null,
        input.userAgent ? truncate(input.userAgent, userAgentMaxLength) : null,
        timestamp
      );
  });
  if (statements.length > 0) await db.batch(statements);
  for (const { input, timestamp } of stableInputs) {
    const readRow = () =>
      db
        .prepare(
          `SELECT source, level, message, node_id, workspace_id, task_id, session_id, timestamp
             FROM platform_errors WHERE id = ?`
        )
        .bind(input.id)
        .first<StrictErrorRow>();
    let row = await readRow();
    if (!row || !strictRowMatchesInput(row, input, timestamp, messageMaxLength)) {
      throw new Error('Observability incident ID is already bound to different metadata');
    }

    // Task/session IDs are monotonic enrichment: the VM's durable report is
    // stable before the control plane joins it to D1. A retry may therefore add
    // missing correlation, but it must never replace an existing non-null ID.
    if (needsCorrelationEnrichment(row, input)) {
      await db
        .prepare(
          `UPDATE platform_errors
              SET task_id = COALESCE(task_id, ?),
                  session_id = COALESCE(session_id, ?)
            WHERE id = ?
              AND (? IS NULL OR task_id IS NULL OR task_id = ?)
              AND (? IS NULL OR session_id IS NULL OR session_id = ?)`
        )
        .bind(
          input.taskId ?? null,
          input.sessionId ?? null,
          input.id,
          input.taskId ?? null,
          input.taskId ?? null,
          input.sessionId ?? null,
          input.sessionId ?? null
        )
        .run();
      row = await readRow();
      if (!hasRequestedCorrelation(row, input)) {
        throw new Error('Observability incident ID is already bound to different metadata');
      }
    }
  }
}
