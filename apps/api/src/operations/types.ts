import type * as v from 'valibot';

import type { Env } from '../env';
import { AppError } from '../middleware/error';
import { auditConnectorWrite } from '../services/connector-execution';
import type { ConnectorSettings } from '../services/connector-settings';
import { OperationError } from './errors';

export type OperationKind = 'read' | 'write' | 'destructive';
export type OperationScope = 'sam.read' | 'sam.write';

export interface Actor {
  userId: string;
  via: 'web' | 'pat' | 'connector' | 'sam' | 'workspace-agent';
  clientId?: string;
  clientName?: string;
  scopes: ReadonlySet<OperationScope>;
  workspace?: { workspaceId: string; taskId?: string; projectId: string };
}

export interface OperationContext {
  env: Env;
  actor: Actor;
  requestId: string;
  idempotencyKey?: string;
  connectorSettings?: ConnectorSettings;
  execCtx?: ExecutionContext;
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
