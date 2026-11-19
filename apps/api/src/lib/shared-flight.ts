// The Worker's import path for @simple-agent-manager/worker-core's shared-flight helpers. The
// self-host build's generated celld entry imports this file through its `src` link to apps/api/src,
// because that entry module lives outside the workspace and cannot resolve the package name
// itself. The celld resume mode lives in the one worker-core module, so the entry's call reaches
// every joiner, including packages/project-data's compact-r2 joins.
export {
  __setSharedFlightResumeOnOwnTimerForTest,
  DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS,
  joinSharedFlight,
  resumeSharedFlightJoinsOnOwnTimer,
  settleSharedFlight,
  SHARED_FLIGHT_POLL_MS,
  SharedFlightAbandonedError,
} from '@simple-agent-manager/worker-core';
