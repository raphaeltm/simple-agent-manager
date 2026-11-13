// Moved to @simple-agent-manager/worker-core: the ProjectData package's ensure memo needs it too
// (packages/project-data/src/client/project-data-ensure-memo.ts). This re-export keeps the
// worker's existing importers, and the generated celld entry module, unchanged. The celld resume
// mode lives in that one worker-core module, so the entry's call reaches every joiner.
export {
  __setSharedFlightResumeOnOwnTimerForTest,
  DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS,
  joinSharedFlight,
  resumeSharedFlightJoinsOnOwnTimer,
  settleSharedFlight,
  SHARED_FLIGHT_POLL_MS,
  SharedFlightAbandonedError,
} from '@simple-agent-manager/worker-core';
