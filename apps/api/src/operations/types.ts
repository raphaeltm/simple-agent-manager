import type * as v from 'valibot';

import type { Env } from '../env';

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
  return operation;
}
