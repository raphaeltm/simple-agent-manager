import { ApiClientError } from '../../lib/api';

const RUNTIME_RECOVERY_CODES = new Set([
  'RUNTIME_RECOVERING',
  'RUNTIME_REQUEST_INTERRUPTED',
  'RUNTIME_RECOVERY_DEGRADED',
  'RUNTIME_STOPPED',
]);

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
