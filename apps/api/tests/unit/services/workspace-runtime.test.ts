import { describe, expect, it } from 'vitest';

import { decideWorkspaceRuntime } from '../../../src/services/workspace-runtime';

describe('decideWorkspaceRuntime', () => {
  it('forces vm when the sandbox kill switch is disabled', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: false,
        explicitRuntime: 'cf-container',
        credentialSource: 'platform',
      })
    ).toEqual({ runtime: 'vm', reason: 'sandbox-disabled' });
  });

  it('honors explicit vm runtime when sandbox is enabled', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        explicitRuntime: 'vm',
        credentialSource: 'platform',
      })
    ).toEqual({ runtime: 'vm', reason: 'explicit-vm' });
  });

  it('honors explicit cf-container runtime when sandbox is enabled', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        explicitRuntime: 'cf-container',
        credentialSource: 'user',
      })
    ).toEqual({ runtime: 'cf-container', reason: 'explicit-cf-container' });
  });

  it('keeps user cloud credential work on vm by default', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        credentialSource: 'user',
      })
    ).toEqual({ runtime: 'vm', reason: 'user-cloud-credential' });
  });

  it('keeps project cloud credential work on vm by default', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        credentialSource: 'project',
      })
    ).toEqual({ runtime: 'vm', reason: 'project-cloud-credential' });
  });

  it('uses cf-container for platform-credential zero-config users', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        credentialSource: 'platform',
      })
    ).toEqual({ runtime: 'cf-container', reason: 'zero-config' });
  });

  it('uses cf-container when no cloud credential exists', () => {
    expect(
      decideWorkspaceRuntime({
        sandboxEnabled: true,
        credentialSource: null,
      })
    ).toEqual({ runtime: 'cf-container', reason: 'zero-config' });
  });
});
