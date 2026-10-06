import { describe, expect, it } from 'vitest';

import {
  getResumeFailureMessage,
  getRuntimeRecoveryMessage,
} from '../../../src/components/project-message-view/runtimeRecoveryMessages';
import { ApiClientError } from '../../../src/lib/api';

describe('runtime recovery user messages', () => {
  it('shows an explicit waking/restoring state', () => {
    const error = new ApiClientError(
      'RUNTIME_RECOVERING',
      'Instant session interrupted; restoring the last safe checkpoint.',
      503
    );

    expect(getRuntimeRecoveryMessage(error)).toBe(
      'Waking and restoring the Instant session. Wait for restore to finish, then send your message.'
    );
  });

  it('preserves the server-sanitized manual-retry and degraded messages', () => {
    const interrupted = new ApiClientError(
      'RUNTIME_REQUEST_INTERRUPTED',
      'Your message is saved, but it was not replayed automatically.',
      409
    );
    const degraded = new ApiClientError(
      'RUNTIME_RECOVERY_DEGRADED',
      'The Instant session could not restore its last safe checkpoint. Your transcript is available.',
      409
    );

    expect(getRuntimeRecoveryMessage(interrupted)).toBe(interrupted.message);
    expect(getRuntimeRecoveryMessage(degraded)).toBe(degraded.message);
  });

  it('keeps internal non-recovery errors out of regular-user messaging', () => {
    const error = new Error('R2 key snapshots/private-user/home.tar was corrupt');

    expect(getRuntimeRecoveryMessage(error)).toBeNull();
    expect(getResumeFailureMessage(error)).toBe('Could not resume agent — please try again.');
  });
});
