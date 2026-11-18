// Moved to @simple-agent-manager/worker-core (worker modularization W0). This re-export keeps
// existing importers unchanged; new code imports from the package entry point directly.
export {
  d1CauseCode,
  type D1ErrorCategory,
  d1ErrorCategory,
  isFailedQueryError,
} from '@simple-agent-manager/worker-core';
