import { describe, expect, it, vi } from 'vitest';

// Runtime timeout configuration must not load auth, deployment or their loggers.
// This catches accidentally routing the lightweight getter through node-agent.
vi.mock('../../../src/lib/logger', () => {
  throw new Error('Timeout configuration must not initialize application loggers');
});
import { getCfContainerCreateWorkspaceTimeoutMs } from '../../../src/services/cf-container-timeouts';

describe('lightweight Instant workspace creation timeout configuration', () => {
  it.each([undefined, '', 'invalid', '0', '-1', 'Infinity'])(
    'retains the existing fallback for invalid value %s',
    (value) => {
      expect(
        getCfContainerCreateWorkspaceTimeoutMs({ CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: value })
      ).toBe(120000);
    }
  );
  it.each([
    ['45000', 45000],
    ['1', 1],
    ['90001', 90001],
    ['45000.9', 45000],
    ['45000ms', 45000],
  ])('preserves existing positive integer parsing for %s', (value, expected) => {
    expect(
      getCfContainerCreateWorkspaceTimeoutMs({ CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: value })
    ).toBe(expected);
  });
});
