import { ApiClientError } from '../../lib/api';

const RUNTIME_RECOVERY_CODES = new Set([
  'RUNTIME_RECOVERING',
  'RUNTIME_REQUEST_INTERRUPTED',
  'RUNTIME_RECOVERY_DEGRADED',
  'RUNTIME_STOPPED',
]);

/**
 * Terminal runtime code (HTTP 410): the Instant runtime is permanently stopped
 * and the agent session can never be resumed. Callers must reflect termination
 * in local session state (status → 'stopped') so the existing terminated
 * presentation takes over — never surface a dismissible "retry" banner, which
 * only invites endless futile retries against a dead runtime.
 */
export function isRuntimeStoppedError(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'RUNTIME_STOPPED';
}

/**
 * Fallback shown when a follow-up could not be confirmed delivered and the error
 * carries no recognized runtime-recovery code.
 */
export const DEFAULT_DELIVERY_ERROR_MESSAGE =
  'Your message is saved, but delivery could not be confirmed. Check the transcript and partial output before deciding whether to send it again.';

export function getRuntimeRecoveryMessage(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || !RUNTIME_RECOVERY_CODES.has(error.code)) {
    return null;
  }
  if (error.code === 'RUNTIME_RECOVERING') {
    return 'Waking and restoring the Instant session. Wait for restore to finish, then send your message.';
  }
  return error.message;
}

export function getResumeFailureMessage(error: unknown): string {
  const runtimeMessage = getRuntimeRecoveryMessage(error);
  if (runtimeMessage) return runtimeMessage;

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('404') || /not found/i.test(message)) {
    return 'Could not resume agent — workspace may have been cleaned up.';
  }
  return 'Could not resume agent — please try again.';
}
