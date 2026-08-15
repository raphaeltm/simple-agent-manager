import { describe, expect, it } from 'vitest';

import {
  buildVmPromptDeliveryCapabilitiesPath,
  buildVmPromptDeliveryReceiptPath,
  DEFAULT_ACP_LONG_TURN_SUPERVISOR_ENABLED,
  DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED,
  DEFAULT_PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED,
  VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
} from '../src';

describe('durable execution contracts', () => {
  it('keeps all rollout-sensitive execution behavior inert by default', () => {
    expect(DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED).toBe(true);
    expect(DEFAULT_PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED).toBe(false);
    expect(DEFAULT_ACP_LONG_TURN_SUPERVISOR_ENABLED).toBe(false);
    expect(VM_PROMPT_DELIVERY_PROTOCOL_VERSION).toBe(1);
  });

  it('builds encoded VM capability and receipt contract paths', () => {
    expect(buildVmPromptDeliveryCapabilitiesPath('workspace/a')).toBe(
      '/workspaces/workspace%2Fa/agent-capabilities'
    );
    expect(buildVmPromptDeliveryReceiptPath('workspace/a', 'session b', 'delivery/c')).toBe(
      '/workspaces/workspace%2Fa/agent-sessions/session%20b/prompt-receipts/delivery%2Fc'
    );
  });
});
