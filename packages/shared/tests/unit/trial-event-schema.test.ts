import { describe, expect, it } from 'vitest';

import { parseTrialEvent } from '../../src/trial';

describe('parseTrialEvent', () => {
  it('accepts a valid trial event', () => {
    expect(
      parseTrialEvent({
        type: 'trial.progress',
        stage: 'Analyzing',
        progress: 0.5,
        at: 123,
      })
    ).toEqual({
      type: 'trial.progress',
      stage: 'Analyzing',
      progress: 0.5,
      at: 123,
    });
  });

  it('rejects an invalid trial event payload', () => {
    expect(() =>
      parseTrialEvent({
        type: 'trial.ready',
        trialId: 'trial_123',
        at: 123,
      })
    ).toThrow();
  });
});
