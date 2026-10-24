import type * as v from 'valibot';

import type { Env } from '../env';
import { AppError } from '../middleware/error';
import { auditConnectorWrite } from '../services/connector-execution';
import type { ConnectorSettings } from '../services/connector-settings';
import type { SamDispatchReservation } from '../services/sam-dispatch-reservation';
import { OperationError } from './errors';

export type OperationKind = 'read' | 'write' | 'destructive';
export type OperationScope = 'sam.read' | 'sam.write';

export interface Actor {
  userId: string;
  via: 'web' | 'pat' | 'connector' | 'sam' | 'workspace-agent';
  clientId?: string;
  clientName?: string;
  scopes: ReadonlySet<OperationScope>;
  workspace?: { workspaceId: string; taskId?: string; projectId: string; agentSessionId?: string };
}

export interface OperationContext {
  env: Env;
  actor: Actor;
  requestId: string;
  idempotencyKey?: string;
  connectorSettings?: ConnectorSettings;
  execCtx?: ExecutionContext;
  /** SAM-owned durable identities; never populated from model or HTTP tool arguments. */
  samDispatchReservation?: SamDispatchReservation;
  /** Rechecks the SAM enablement generation immediately before dispatch effects. */
  assertEffectAllowed?: () => Promise<void>;
}

export interface Operation<I, O> {
  name: string;
  title: string;
  description: string;
  kind: OperationKind;
  input: v.GenericSchema<I>;
  output?: v.GenericSchema<O>;
  run(ctx: OperationContext, input: I): Promise<O>;
}

export function defineOperation<I, O>(operation: Operation<I, O>): Operation<I, O> {
  if (!/^[a-z0-9_]{1,64}$/.test(operation.name)) {
    throw new Error(`Invalid operation name: ${operation.name}`);
  }
  return {
    ...operation,
    async run(ctx, input) {
      try {
        return await (operation.kind === 'read'
          ? operation.run(ctx, input)
          : auditConnectorWrite(ctx, operation.name, input, () => operation.run(ctx, input)));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const code =
          error.statusCode === 400 || error.statusCode === 422
            ? 'invalid_input'
            : error.statusCode === 401 || error.statusCode === 403
              ? 'forbidden'
              : error.statusCode === 404 || error.statusCode === 410
                ? 'not_found'
                : error.statusCode === 409
                  ? 'conflict'
                  : error.statusCode === 429
                    ? 'rate_limited'
                    : 'unavailable';
        throw new OperationError(
          code,
          code === 'unavailable' ? 'Operation is temporarily unavailable' : error.message
        );
      }
    },
  };
}

/**
 * The operation context for a request a person made in the browser.
 *
 * One definition, because two call sites writing the same actor literal is how the second one
 * quietly loses something — the first copy of this in `routes/tasks/crud.ts` dropped
 * `execCtx`, which is what lets an operation schedule bounded background work.
 *
 * `c.executionCtx` is a getter that throws when there is no execution context, which a
 * unit-test Hono app has; `lib/wait-until.ts` guards it for the same reason. The cast
 * reconciles Hono's `ExecutionContext` type, which omits the runtime's newer tracing field.
 */
export function webOperationContext(
  c: {
    env: Env;
    req: { header(name: string): string | undefined };
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
  userId: string
): OperationContext {
  let execCtx: ExecutionContext | undefined;
  try {
    execCtx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    execCtx = undefined;
  }
  return {
    env: c.env,
    requestId: c.req.header('cf-ray') ?? '',
    actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    execCtx,
  };
}
