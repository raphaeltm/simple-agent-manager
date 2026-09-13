import { describe, expect, it } from 'vitest';

import { normalizeAgentActivityErrorMessage } from '../../../src/services/acp-activity-error-message';

describe('ACP activity error message normalization', () => {
  it('normalizes blank VM errors into a durable operator-facing failure', () => {
    expect(normalizeAgentActivityErrorMessage({} as never, '   ')).toBe(
      'Agent failed: Agent reported an error before producing a response'
    );
  });

  it('uses the configured lifecycle diagnostic cap before adding the agent prefix', () => {
    expect(
      normalizeAgentActivityErrorMessage(
        { SESSION_LIFECYCLE_ERROR_MAX_LENGTH: '8' } as never,
        'abcdefghijk'
      )
    ).toBe('Agent failed: abcde...');
  });

  it('does not double-prefix already-normalized agent failure text', () => {
    expect(normalizeAgentActivityErrorMessage({} as never, 'Agent failed: startup crashed')).toBe(
      'Agent failed: startup crashed'
    );
  });
});
