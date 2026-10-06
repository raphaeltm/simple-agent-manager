/**
 * Reconciliation delivery gate over the shared task-runtime verdict.
 *
 * Split out of `task-runtime-liveness.ts` to keep that module under the 500-line
 * ceiling (`.claude/rules/18`). Re-exported from `task-runtime-liveness.ts` so
 * existing imports are unchanged.
 */
import type { TaskRuntimeLiveness } from './task-runtime-liveness-types';

const PROBEABLE_DELIVERY_REASONS = new Set([
  'task_acp_session_missing',
  'task_acp_session_stale',
  'task_acp_session_suspect',
]);

export type TaskRuntimeDeliveryDisposition =
  | { kind: 'deliverable'; target: { nodeId: string; userId: string } }
  | { kind: 'terminal'; reason: string; nodeId: string | null }
  | { kind: 'inconclusive'; reason: string };

/**
 * Convert the shared task-runtime verdict into a reconciliation delivery gate.
 *
 * Task-scoped ACP absence/staleness is allowed to make one bounded delivery
 * attempt: acceptance is positive reachability evidence, while timeout/error is
 * still inconclusive. Every other uncertain verdict stays deferred. Keeping
 * this adapter beside the classifier prevents reconciliation from growing a
 * second D1-heartbeat death policy.
 */
export function classifyTaskRuntimeDelivery(
  liveness: TaskRuntimeLiveness
): TaskRuntimeDeliveryDisposition {
  if (liveness.conclusive && !liveness.live) {
    return { kind: 'terminal', reason: liveness.reason, nodeId: liveness.nodeId };
  }

  const target = liveness.deliveryTarget;
  if (
    target &&
    (liveness.live || (!liveness.conclusive && PROBEABLE_DELIVERY_REASONS.has(liveness.reason)))
  ) {
    return { kind: 'deliverable', target };
  }

  return { kind: 'inconclusive', reason: liveness.reason };
}
