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
      responseMaxBytes: 64 * 1024,
    });
  });

  it('serializes operator overrides into the trusted runtime contract', () => {
    expect(
      buildAcpInteractionRuntimeConfig(
        {
          ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS: '120000',
          ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS: '240000',
          ACP_INTERACTION_DEADLINE_MARGIN_MS: '5000',
          ACP_INTERACTION_OPTION_ID_MAX_CHARS: '96',
          ACP_INTERACTION_RUNTIME_RECEIPT_LIMIT: '64',
          ACP_INTERACTION_RUNTIME_RESPONSE_MAX_BYTES: '8192',
        } as Env,
        'task'
      )
    ).toMatchObject({
      permissionDeadlineMs: 120000,
      deadlineMarginMs: 5000,
      optionIdMaxChars: 96,
      receiptLimit: 64,
      responseMaxBytes: 8192,
    });
  });

  it('uses the conversation deadline only for conversation sessions', () => {
    expect(
      buildAcpInteractionRuntimeConfig({ ACP_INTERACTIONS_ENABLED: 'true' } as Env, 'conversation')
    ).toMatchObject({
      enabled: true,
      permissionDeadlineMs: 2 * 60 * 60 * 1000,
    });
  });
});
