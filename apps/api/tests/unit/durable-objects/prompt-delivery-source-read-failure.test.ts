/**
 * A source check that cannot read its authority has learned nothing about the delivery: a
 * submit retries, and a receipt reconciliation stays ambiguous. The parent-wake, project-event
 * and checkpoint-continuation checks share `sourceValidationReadFailure`; this pins the error
 * text each one reports.
 */
import { describe, expect, it } from 'vitest';

import type { PromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery';
import { sourceValidationReadFailure } from '../../../src/durable-objects/project-data/prompt-delivery-source-guards';

function claimIn(mode: PromptDeliveryClaim['mode']): PromptDeliveryClaim {
  return {
    mode,
    attemptId: 'attempt-1',
    message: { runtimeIdentity: 'runtime-1' },
  } as unknown as PromptDeliveryClaim;
}

describe('sourceValidationReadFailure', () => {
  it.each([
    'Parent wake target validation',
    'Project event wake source authority validation',
    'Checkpoint continuation task check',
  ])('%s: a submit retries, a reconciliation stays ambiguous', (check) => {
    const failure = new Error('D1 unavailable');

    expect(sourceValidationReadFailure(claimIn('submit'), failure, check)).toStrictEqual({
      kind: 'retry',
      reason: 'not_ready',
      error: `${check} temporarily failed: D1 unavailable`,
      runtimeIdentity: 'runtime-1',
      capabilities: null,
    });
    expect(sourceValidationReadFailure(claimIn('reconcile'), failure, check)).toStrictEqual({
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      error: `${check} failed during receipt reconciliation: D1 unavailable`,
      runtimeIdentity: 'runtime-1',
      capabilities: null,
      receipt: null,
    });
  });

  it('reports a non-Error failure as text', () => {
    expect(
      sourceValidationReadFailure(
        claimIn('submit'),
        'binding missing',
        'Parent wake target validation'
      )
    ).toMatchObject({ error: 'Parent wake target validation temporarily failed: binding missing' });
  });
});
