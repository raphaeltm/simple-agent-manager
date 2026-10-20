/** Shared submission entry point: preserve admission diagnostics across runtime paths. */
import type { SubmitTaskResponse } from '@simple-agent-manager/shared';
import type * as v from 'valibot';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { markRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { markTaskSubmitOperation, type TaskSubmitOperation } from '../lib/task-submit-diagnostics';
import { AppError } from '../middleware/error';
import type { SubmitTaskSchema } from '../schemas';
import type { ReconciledSamDispatch, SamDispatchReservation } from './sam-dispatch-reservation';
import { submitTaskImplementation } from './submit-task-implementation';

export async function submitTask(
  env: Env,
  user: { id: string; name: string | null; email: string },
  projectId: string,
  body: v.InferOutput<typeof SubmitTaskSchema>,
  waitUntil: (promise: Promise<unknown>) => void,
  via: string = 'web',
  clientName?: string,
  repositoryAccess?: (project: schema.Project) => Promise<unknown>,
  samReservation?: SamDispatchReservation,
  assertEffectAllowed?: () => Promise<void>
): Promise<SubmitTaskResponse | ReconciledSamDispatch> {
  let taskEffectsStarted = false;
  let operation: TaskSubmitOperation = 'project_authorization';
  try {
    return await submitTaskImplementation(
      env,
      user,
      projectId,
      body,
      waitUntil,
      via,
      clientName,
      repositoryAccess,
      samReservation,
      assertEffectAllowed,
      () => {
        taskEffectsStarted = true;
      },
      (nextOperation) => {
        operation = nextOperation;
      },
      () => operation
    );
  } catch (error) {
    markTaskSubmitOperation(error, operation);
    // Admission may initialize idempotent placement metadata, but has not created
    // task/session work. Only a known rejection in this phase proves safe retry.
    if (
      !taskEffectsStarted &&
      (via === 'connector' || via === 'pat' || body.sourceSessionId) &&
      error instanceof AppError
    )
      markRejectedBeforeEffects(error);
    throw error;
  }
}
