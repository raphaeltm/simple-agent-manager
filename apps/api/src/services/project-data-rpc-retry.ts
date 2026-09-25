/**
 * The one retry loop every ProjectData RPC wrapper uses, parameterized by how the stub is resolved.
 * Split out of `project-data.ts` so the policy (which failures may be repeated, for which calls)
 * and its telemetry live in one place.
 */
import { log } from '../lib/logger';
import { AppError } from '../middleware/error';
import {
  classifyDurableObjectError,
  computeDurableObjectRetryDelayMs,
  type DurableObjectErrorClass,
  type DurableObjectRetryEnv,
  getDurableObjectRetryConfig,
  isDurableObjectStorageFullError,
  isRetryableForIdempotentDurableObjectOperation,
  isTransientDurableObjectError,
} from './durable-object-retry';
import { toProjectDataStorageFullError } from './project-data-storage-errors';

/**
 * How a ProjectData RPC may be retried. `mutation` (the default) retries only failures the object
 * rejected before doing anything (`isTransientDurableObjectError`). `idempotent_read` may also retry
 * a CPU-limit reset or a lost connection, whose outcome is ambiguous — safe only when repeating the
 * call cannot duplicate an effect. Heavy calls must never be marked idempotent_read: a request that
 * itself burned the CPU allowance would reset the object again.
 */
export type ProjectDataRpcRetryPolicy = 'idempotent_read' | 'mutation';

export const PROJECT_DATA_UNAVAILABLE = 'PROJECT_DATA_UNAVAILABLE';

/**
 * An idempotent read ran out of attempts because the object kept being reset or could not be
 * reached — nothing about the request itself. Callers get a stable, retryable 503 instead of the
 * platform's error text. Mutations never get here: those failures are not retried for them, and
 * their raw error is kept, because whether they took effect is unknown.
 */
export class ProjectDataUnavailableError extends AppError {
  constructor(
    projectId: string,
    operation: string,
    errorClass: 'cpu_limit_reset' | 'connection_lost'
  ) {
    super(
      503,
      PROJECT_DATA_UNAVAILABLE,
      'Project data is temporarily unavailable. Retry shortly.',
      {
        projectId,
        operation,
        errorClass,
      }
    );
    this.name = 'ProjectDataUnavailableError';
  }
}

export async function retryProjectDataRpc<T, S>(input: {
  env: DurableObjectRetryEnv;
  projectId: string;
  operation: string;
  policy: ProjectDataRpcRetryPolicy;
  resolveStub: () => Promise<S>;
  /** Any DO failure means this isolate could not observe the DO's state: forget ensure memos. */
  forgetEnsured: () => void;
  /** Applied to the error that ends the loop, e.g. mapping RPC-serialized domain errors. */
  normalizeError: (err: unknown) => unknown;
  call: (stub: S) => Promise<T>;
}): Promise<T> {
  const { env, projectId, operation, policy } = input;
  const retryConfig = getDurableObjectRetryConfig(env);
  const retryable =
    policy === 'idempotent_read'
      ? isRetryableForIdempotentDurableObjectOperation
      : isTransientDurableObjectError;
  let lastError: unknown;
  let firstErrorClass: DurableObjectErrorClass = null;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      const stub = await input.resolveStub();
      const result = await input.call(stub);
      if (attempt > 1) {
        log.info('project_data.do_rpc_retry_succeeded', {
          projectId,
          operation,
          policy,
          attempts: attempt,
          firstErrorClass,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      input.forgetEnsured();

      if (isDurableObjectStorageFullError(err)) {
        throw toProjectDataStorageFullError(projectId, operation, err);
      }

      const errorClass = classifyDurableObjectError(err);
      firstErrorClass ??= errorClass;
      if (!retryable(err)) throw err;
      const attemptBudget =
        errorClass === 'connection_lost'
          ? retryConfig.connectionLostMaxAttempts
          : retryConfig.maxAttempts;
      if (attempt >= attemptBudget) {
        log.warn('project_data.do_rpc_retry_exhausted', {
          projectId,
          operation,
          policy,
          attempts: attempt,
          errorClass,
        });
        if (errorClass === 'cpu_limit_reset' || errorClass === 'connection_lost') {
          throw new ProjectDataUnavailableError(projectId, operation, errorClass);
        }
        throw err;
      }

      const delayMs = computeDurableObjectRetryDelayMs(
        attempt,
        retryConfig.baseDelayMs,
        retryConfig.maxDelayMs
      );
      log.warn('project_data.do_rpc_retry', {
        projectId,
        operation,
        policy,
        attempt,
        maxAttempts: attemptBudget,
        delayMs,
        errorClass,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }

  throw input.normalizeError(
    lastError ?? new Error('ProjectData DO retry exhausted without an error')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
