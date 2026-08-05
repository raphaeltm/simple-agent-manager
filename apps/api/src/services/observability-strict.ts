import type { Env } from '../env';
import type { PersistErrorInput } from './observability';

const DEFAULT_BATCH_SIZE = 25;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_STACK_LENGTH = 4096;
const MAX_USER_AGENT_LENGTH = 512;
const VALID_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);
const VALID_LEVELS = new Set<string>(['error', 'warn', 'info']);

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function maxBatchSize(env?: Env): number {
  const parsed = Number.parseInt(env?.OBSERVABILITY_ERROR_BATCH_SIZE ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE;
}

/** Strict, idempotent persistence for restart-safe VM outboxes. */
export async function persistErrorBatchStrict(
  db: D1Database,
  inputs: PersistErrorInput[],
  env?: Env
): Promise<void> {
  const limit = maxBatchSize(env);
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
          ip_address, user_agent, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        source,
        level,
        truncate(input.message, MAX_MESSAGE_LENGTH),
        input.stack ? truncate(input.stack, MAX_STACK_LENGTH) : null,
        input.context ? JSON.stringify(input.context) : null,
        input.userId ?? null,
        input.nodeId ?? null,
        input.workspaceId ?? null,
        input.ipAddress ?? null,
        input.userAgent ? truncate(input.userAgent, MAX_USER_AGENT_LENGTH) : null,
        input.timestamp ?? Date.now()
      );
  });
  if (statements.length > 0) await db.batch(statements);
  for (const input of inputs) {
    const row = await db
      .prepare(
        'SELECT source, level, message, node_id, workspace_id FROM platform_errors WHERE id = ?'
      )
      .bind(input.id)
      .first<{
        source: string;
        level: string;
        message: string;
        node_id: string | null;
        workspace_id: string | null;
      }>();
    const expectedLevel = input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';
    if (
      !row ||
      row.source !== input.source ||
      row.level !== expectedLevel ||
      row.message !== truncate(input.message, MAX_MESSAGE_LENGTH) ||
      row.node_id !== (input.nodeId ?? null) ||
      row.workspace_id !== (input.workspaceId ?? null)
    ) {
      throw new Error('Observability incident ID is already bound to different metadata');
    }
  }
}
