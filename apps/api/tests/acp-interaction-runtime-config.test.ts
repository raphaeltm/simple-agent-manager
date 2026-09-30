import { describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import { buildAcpInteractionRuntimeConfig } from '../src/services/acp-interaction-runtime-config';

describe('ACP interaction runtime start config', () => {
  it('keeps rollout disabled by default and selects the task deadline', () => {
    expect(buildAcpInteractionRuntimeConfig({} as Env, 'task')).toMatchObject({
      enabled: false,
      protocolVersion: 1,
      permissionDeadlineMs: 30 * 60 * 1000,
      maxDeadlineMs: 4 * 60 * 60 * 1000,
      deadlineMarginMs: 60 * 1000,
      optionsMaxCount: 16,
      receiptLimit: 256,
    });
  });

  it('uses the conversation deadline only for conversation sessions', () => {
    expect(
      buildAcpInteractionRuntimeConfig(
        { ACP_INTERACTIONS_ENABLED: 'true' } as Env,
        'conversation'
      )
    ).toMatchObject({
      enabled: true,
      permissionDeadlineMs: 2 * 60 * 60 * 1000,
    });
  });
});
