// Moved to @simple-agent-manager/worker-core (worker modularization W0). This re-export keeps
// existing importers unchanged; new code imports from the package entry point directly.
export {
  fetchWithTimeout,
  getTimeoutMs,
  IoTimeoutError,
  withDeadline,
} from '@simple-agent-manager/worker-core';
