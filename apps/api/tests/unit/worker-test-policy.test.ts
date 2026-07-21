import { describe, expect, it } from 'vitest';

import { isExpectedWorkerTestRejection } from '../workers/worker-test-policy';

function remoteError(message: string): Error {
  return Object.assign(new Error(message), { remote: true });
}

describe('worker test unhandled rejection policy', () => {
  it('accepts an exact expected remote DO rejection', () => {
    expect(
      isExpectedWorkerTestRejection(
        remoteError('Node mismatch: session assigned to node-a, heartbeat from node-b')
      )
    ).toBe(true);
  });

  it('does not accept a broad substring match', () => {
    expect(isExpectedWorkerTestRejection(remoteError('Node mismatch'))).toBe(false);
    expect(
      isExpectedWorkerTestRejection(
        remoteError('Unexpected Node mismatch: session assigned to node-a, heartbeat from node-b')
      )
    ).toBe(false);
  });

  it('does not suppress an unexpected remote failure', () => {
    expect(isExpectedWorkerTestRejection(remoteError('background RPC failed'))).toBe(false);
  });

  it('requires worker-RPC provenance even for an expected message', () => {
    expect(
      isExpectedWorkerTestRejection(
        new Error('Node mismatch: session assigned to node-a, heartbeat from node-b')
      )
    ).toBe(false);
  });
});
