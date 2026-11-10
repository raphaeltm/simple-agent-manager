import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { isInstantRuntimeAvailable } from '../../../src/services/vm-agent-container';

// Onboarding skips the cloud-account question only when this is true, so a flag without the
// container binding must not count: the first chat would fail to start.
describe('isInstantRuntimeAvailable', () => {
  const binding = {} as Env['VM_AGENT_CONTAINER'];

  it.each([
    [
      'flag on and binding present',
      { CF_CONTAINER_ENABLED: 'true', VM_AGENT_CONTAINER: binding },
      true,
    ],
    ['legacy SANDBOX_ENABLED flag', { SANDBOX_ENABLED: 'true', VM_AGENT_CONTAINER: binding }, true],
    ['flag on, binding missing', { CF_CONTAINER_ENABLED: 'true' }, false],
    [
      'binding present, flag off',
      { CF_CONTAINER_ENABLED: 'false', VM_AGENT_CONTAINER: binding },
      false,
    ],
    ['nothing configured', {}, false],
  ])('%s → %s', (_label, env, expected) => {
    expect(isInstantRuntimeAvailable(env as unknown as Env)).toBe(expected);
  });
});
