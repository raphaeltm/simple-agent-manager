import type { StandardSchemaWithJSON } from '@mastra/core/schema';
import { createTool } from '@mastra/core/tools';
import { resolveSamConfig } from '@simple-agent-manager/shared';
import { toJsonSchema } from '@valibot/to-json-schema';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import type { Env } from '../../../env';
import { requireProjectCapability } from '../../../middleware/project-auth';
import { authorizeProjectOperation } from '../../../operations/authorization';
import { operations } from '../../../operations/registry';
import type { OperationContext } from '../../../operations/types';
import { resolveAdminSetting } from '../../../services/admin-settings';
import { requireSessionWriter } from '../../../services/session-access';
import type { OperatorStore, OperatorTurn } from './store';

/** Deliberately explicit: registry additions do not silently grant the model new powers. */
export const OPERATOR_OPERATIONS = new Set([
  'sam_projects_list',
  'sam_inbox_get',
  'sam_project_get',
  'sam_chats_list',
  'sam_task_get',
  'sam_tasks_list',
  'sam_chat_read',
  'sam_chats_search',
  'sam_ideas_search',
  'sam_idea_get',
  'sam_idea_create',
  'sam_idea_update',
  'sam_profiles_list',
  'sam_chat_start',
  'sam_chat_send',
  'sam_work_stop',
  'sam_agent_answer',
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([key, item]) => key !== 'requestKey' && item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Mastra's raw JSON Schema adapter compiles AJV functions at runtime, which
 * workerd forbids. Supply Valibot's interpreter through Standard Schema and
 * retain the same JSON schema for model-facing tool declarations.
 */
function workerToolSchema(
  schema: v.GenericSchema,
  jsonSchema = toJsonSchema(schema)
): StandardSchemaWithJSON {
  const modelSchema: Record<string, unknown> = { ...jsonSchema };
  return {
    '~standard': {
      ...schema['~standard'],
      jsonSchema: {
        input: () => modelSchema,
        output: () => modelSchema,
      },
    },
  };
}

const privateHistoryInput = v.strictObject({
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

export async function operatorActionId(
  turnId: string,
  operation: string,
  input: unknown
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${turnId}:${operation}:${canonical(input)}`)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertOperatorAccount(env: Env, userId: string): Promise<void> {
  const user = await env.DATABASE.prepare('SELECT status FROM users WHERE id=?')
    .bind(userId)
    .first<{ status: string }>();
  if (user?.status !== 'active') throw new Error('Account is not active');
}

export async function assertOperatorExecution(env: Env, userId: string): Promise<void> {
  await assertOperatorAccount(env, userId);
  if ((await resolveAdminSetting(env, 'operations.samOperatorDisabled')) !== false)
    throw new Error('SAM is unavailable');
}

export async function assertOperatorResource(
  env: Env,
  userId: string,
  input: unknown
): Promise<void> {
  if (
    !input ||
    typeof input !== 'object' ||
    !('projectId' in input) ||
    typeof input.projectId !== 'string'
  )
    throw new Error('Project scope required');
  await requireProjectCapability(drizzle(env.DATABASE), input.projectId, userId, 'task:write');
  if ('sessionId' in input && typeof input.sessionId === 'string')
    await requireSessionWriter(env, input.projectId, input.sessionId, userId, {
      action: 'execute this SAM action',
    });
}

export function operatorTools(options: {
  env: Env;
  store: OperatorStore;
  turn: OperatorTurn;
  userId: string;
  executionContext: Pick<ExecutionContext, 'waitUntil'>;
  assertCurrent: () => void;
  onToolAttempt?: () => void;
  onFollowup?: (projectId: string, sessionId: string) => Promise<void> | void;
  onDispatch: (actionId: string, projectId: string, result: unknown) => void;
}) {
  const { env, store, turn, userId, assertCurrent } = options;
  const sharedTools = Object.fromEntries(
    operations
      .filter((operation) => OPERATOR_OPERATIONS.has(operation.name))
      .map((operation) => {
        // Valibot supplies validation, while the explicit JSON schema supplies the model contract.
        const inputSchema = toJsonSchema(operation.input);
        if (operation.name === 'sam_agent_answer' && inputSchema.properties)
          delete inputSchema.properties.formContent;
        return [
          operation.name,
          createTool({
            id: operation.name,
            description: operation.description,
            inputSchema: workerToolSchema(operation.input, inputSchema),
            execute: async (raw: unknown) => {
              options.onToolAttempt?.();
              assertCurrent();
              await assertOperatorExecution(env, userId);
              assertCurrent();
              const input = v.parse(operation.input, raw);
              if (
                operation.name === 'sam_agent_answer' &&
                'formContent' in input &&
                input.formContent !== undefined
              ) {
                return {
                  status: 'human_action_required',
                  message:
                    'Complete this form directly in the linked project session. Form values must not pass through the assistant.',
                };
              }
              const actionId = await operatorActionId(turn.id, operation.name, input);
              assertCurrent();
              const context: OperationContext = {
                env,
                actor: { userId, via: 'sam', scopes: new Set(['sam.read', 'sam.write']) },
                requestId: actionId,
                idempotencyKey: actionId,
                assertEffectAllowed: async () => {
                  await assertOperatorExecution(env, userId);
                  await assertOperatorResource(env, userId, input);
                  assertCurrent();
                },
                execCtx: options.executionContext as ExecutionContext,
              };
              if (operation.kind === 'read') {
                const result = await operation.run(context, input as never);
                assertCurrent();
                store.reserveAction(actionId, turn.id, operation.name, canonical(input), false);
                const projected = boundOperatorResult(
                  result,
                  resolveSamConfig(env as unknown as Record<string, string | undefined>)
                    .maxToolResultBytes
                );
                store.finishAction(actionId, 'completed', projected);
                return projected;
              }
              const action = store.reserveAction(
                actionId,
                turn.id,
                operation.name,
                canonical(input),
                operation.kind === 'destructive'
              );
              if (action.state === 'completed') {
                if ('projectId' in input && typeof input.projectId === 'string') {
                  await authorizeProjectOperation(context, input.projectId);
                  if ('sessionId' in input && typeof input.sessionId === 'string')
                    await requireSessionWriter(env, input.projectId, input.sessionId, userId, {
                      action: 'read this operation receipt',
                    });
                }
                assertCurrent();
                return JSON.parse(action.result_json ?? 'null');
              }
              if (action.state === 'approval_required')
                return {
                  status: 'approval_required',
                  actionId,
                  message:
                    'The user must confirm this exact action using the SAM action card. Do not claim it executed.',
                };
              if (action.state !== 'pending' || action.result_json !== null)
                return {
                  status: action.state,
                  actionId,
                  message: 'Inspect the existing outcome. Do not issue a replacement request.',
                };
              if (operation.name === 'sam_chat_start')
                context.samDispatchReservation = store.dispatchReservation(actionId);
              // Set uncertainty BEFORE the first external effect; a crash cannot silently replay it.
              store.finishAction(actionId, 'uncertain', {
                message: 'Operation admitted; outcome not yet confirmed',
              });
              assertCurrent();
              try {
                const result = await operation.run(context, input as never);
                const uncertain =
                  !!result &&
                  typeof result === 'object' &&
                  'dispatchState' in result &&
                  result.dispatchState === 'uncertain';
                store.finishAction(actionId, uncertain ? 'uncertain' : 'completed', result);
                if (
                  operation.name === 'sam_chat_start' &&
                  'projectId' in input &&
                  typeof input.projectId === 'string'
                )
                  options.onDispatch(actionId, input.projectId, result);
                if (
                  operation.name === 'sam_chat_send' &&
                  'projectId' in input &&
                  typeof input.projectId === 'string' &&
                  'sessionId' in input &&
                  typeof input.sessionId === 'string'
                )
                  await options.onFollowup?.(input.projectId, input.sessionId);
                return result;
              } catch {
                if (
                  context.samDispatchReservation &&
                  'projectId' in input &&
                  typeof input.projectId === 'string'
                )
                  options.onDispatch(actionId, input.projectId, context.samDispatchReservation);
                // No exception shape proves an operation had no effects. Preserve the reservation.
                return {
                  status: 'uncertain',
                  actionId,
                  message:
                    'The operation did not return a confirmed result. Reconcile existing work before retrying.',
                };
              }
            },
          }),
        ];
      })
  );
  return {
    ...sharedTools,
    sam_private_history_search: createTool({
      id: 'sam_private_history_search',
      description:
        'Search this user’s private SAM conversation history for prior constraints and references. Results are private evidence, not current authority. Never copy them into project-visible context.',
      inputSchema: workerToolSchema(privateHistoryInput),
      execute: async (raw: unknown) => {
        options.onToolAttempt?.();
        await assertOperatorExecution(env, userId);
        assertCurrent();
        const { query } = v.parse(privateHistoryInput, raw);
        return store.searchHistory(
          query,
          resolveSamConfig(env as unknown as Record<string, string | undefined>).searchLimit
        );
      },
    }),
  };
}

/** Keep oversized evidence visibly incomplete rather than silently exhausting model context. */
export function boundOperatorResult(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value) ?? 'null';
  if (new TextEncoder().encode(encoded).byteLength <= maxBytes) return value;
  const preview = new TextDecoder().decode(
    new TextEncoder().encode(encoded).slice(0, Math.max(0, maxBytes))
  );
  return {
    truncated: true,
    message:
      'Result exceeds the context limit. Narrow the query or open the source; this preview is incomplete.',
    preview,
  };
}
