import type { SessionLifecyclePort } from '../durable-objects/project-data/ports';
import {
  classifySessionIdleness,
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from '../services/session-idleness';
import { isSessionRecoverySourceTaskGuardValid } from '../services/session-recovery-authority';
import { stoppingTaskSleepOwnsCleanup } from '../services/session-sleep-task-convergence';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from '../services/session-snapshot-artifacts';
import { hasAuthorizedRestorableSnapshotWakeClaim } from '../services/session-snapshot-recovery-lifecycle';
import { findRestorableOrInFlightSleepSnapshot } from '../services/session-snapshot-sleep-predicate';
import { isSleepPreservedTerminalTaskStatus } from '../services/sleep-preserved-task-status';
import { workerEnv } from './worker-env';

/** Session sleep, idleness and recovery authority. */
export const sessionsPort: SessionLifecyclePort = {
  defaultSleepAfterMs: DEFAULT_SESSION_SLEEP_AFTER_MS,
  classifyIdleness: (env, input) =>
    classifySessionIdleness({ ...input, harnessWorkConfig: parseHarnessWorkConfig(env) }),
  hasFreshHarnessWorkLease(env, state, now) {
    const config = parseHarnessWorkConfig(env);
    return (
      getFreshHarnessWorkLeaseExpiry(state, now, config.leaseMs, config.maxDurationMs) !== null
    );
  },
  isSleepPreservedTerminalTaskStatus,
  isSourceTaskGuardValid: (env, guard) =>
    isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard),
  hasAuthorizedRestorableSnapshotWakeClaim: (env, input) =>
    hasAuthorizedRestorableSnapshotWakeClaim(env.DATABASE, input),
  findRestorableOrInFlightSleepSnapshot: (env, input) =>
    findRestorableOrInFlightSleepSnapshot(env.DATABASE, workerEnv(env), input),
  stoppingTaskSleepOwnsCleanup: (env, identity) =>
    stoppingTaskSleepOwnsCleanup(env.DATABASE, identity),
};
