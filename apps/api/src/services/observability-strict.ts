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
  const statements = inputs.map((input) => {
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
        input.timestamp ?? Date.now()
      );
  });
  if (statements.length > 0) await db.batch(statements);
  for (const input of inputs) {
    const row = await db
      .prepare(
        `SELECT source, level, message, node_id, workspace_id, task_id, session_id
         FROM platform_errors WHERE id = ?`
      )
      .bind(input.id)
      .first<{
        source: string;
        level: string;
        message: string;
        node_id: string | null;
        workspace_id: string | null;
        task_id: string | null;
        session_id: string | null;
      }>();
    const expectedLevel = input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';
    if (
      !row ||
      row.source !== input.source ||
      row.level !== expectedLevel ||
      row.message !== truncate(input.message, messageMaxLength) ||
      row.node_id !== (input.nodeId ?? null) ||
      row.workspace_id !== (input.workspaceId ?? null) ||
      row.task_id !== (input.taskId ?? null) ||
      row.session_id !== (input.sessionId ?? null)
    ) {
      throw new Error('Observability incident ID is already bound to different metadata');
    }
  }
}
