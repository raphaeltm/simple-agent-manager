import type { AgentHostStatus, AgentSession } from '@simple-agent-manager/shared';

/** Host statuses that indicate the agent process is alive on the VM. */
const ACTIVE_HOST_STATUSES: ReadonlySet<AgentHostStatus> = new Set([
  'idle',
  'starting',
  'ready',
  'prompting',
]);
const RECOVERABLE_SESSION_STATUSES: ReadonlySet<AgentSession['status']> = new Set([
  'running',
  'recovery',
  'sleeping',
]);

/**
 * Determines if a session should be treated as active (visible in tabs).
 * Returns true for sessions with status='running' OR whose SessionHost
 * is still alive despite a non-running status (orphan recovery).
 */
export function isSessionActive(session: AgentSession): boolean {
  if (RECOVERABLE_SESSION_STATUSES.has(session.status)) return true;
  if (!session.hostStatus) return false;
  return ACTIVE_HOST_STATUSES.has(session.hostStatus);
}

/**
 * Identifies sessions that are active by hostStatus but not by recorded status.
 * These are "orphaned" sessions -- alive on the VM but previously hidden.
 */
export function isOrphanedSession(session: AgentSession): boolean {
  if (RECOVERABLE_SESSION_STATUSES.has(session.status)) return false;
  if (!session.hostStatus) return false;
  return ACTIVE_HOST_STATUSES.has(session.hostStatus);
}
