// Moved to @simple-agent-manager/worker-core: the ProjectData package's ensure memo needs it too
// (packages/project-data/src/client/project-data-ensure-memo.ts). This re-export keeps the
// worker's existing importers unchanged.
export {
  DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS,
  joinSharedFlight,
  SharedFlightAbandonedError,
  settleSharedFlight,
} from '@simple-agent-manager/worker-core';
