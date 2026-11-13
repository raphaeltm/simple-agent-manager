// Moved to @simple-agent-manager/worker-core (worker modularization W0). This re-export keeps
// existing importers unchanged; new code imports from the package entry point directly.
export {
  classifyDurableObjectError,
  computeDurableObjectRetryDelayMs,
  DEFAULT_DO_RETRY_BASE_DELAY_MS,
  DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS,
  DEFAULT_DO_RETRY_MAX_ATTEMPTS,
  DEFAULT_DO_RETRY_MAX_DELAY_MS,
  type DurableObjectErrorClass,
  type DurableObjectRetryConfig,
  type DurableObjectRetryEnv,
  getDurableObjectRetryConfig,
  isDurableObjectConnectionLostError,
  isDurableObjectCpuLimitResetError,
  isDurableObjectSqliteNoMemError,
  isDurableObjectStorageFullError,
  isRetryableForIdempotentDurableObjectOperation,
  isTransientDurableObjectError,
} from '@simple-agent-manager/worker-core';
