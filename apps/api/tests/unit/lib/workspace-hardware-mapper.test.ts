import { describe, expect, it } from 'vitest';

import type * as schema from '../../../src/db/schema';
import { toWorkspaceResponse } from '../../../src/lib/mappers';

// Mapper-only fixtures: unrelated workspace fields are intentionally absent.
const workspace = {
  id: 'workspace',
  nodeId: 'node',
  vmSize: 'small',
  vmLocation: 'nbg1',
} as schema.Workspace;
describe('workspace public hardware mapping', () => {
  it('returns configured and observed numbers independently without exposing node authority', () => {
    const node = {
      vmSize: 'small',
      cloudProvider: 'hetzner',
      providerInstanceType: 'cx53',
      providerInstanceVcpuCount: 16,
      observedProviderInstanceVcpuCount: 12,
      observedProviderInstanceMemoryMb: 30720,
      placementCredentialReference: 'secret-reference',
      cloudCredentialId: 'secret-id',
      userId: 'other-user',
    } as unknown as schema.Node;
    const response = toWorkspaceResponse(workspace, 'example.com', node);
    expect(response.hardware?.providerInstanceVcpuCount).toBe(16);
    expect(response.hardware?.observedProviderInstanceVcpuCount).toBe(12);
    expect(JSON.stringify(response.hardware)).not.toMatch(/secret|other-user|Credential/);
    expect(response.vmSize).toBe('small');
  });
  it('does not imply historical workspace offering metadata is observed host hardware', () => {
    const response = toWorkspaceResponse(
      { ...workspace, providerInstanceType: 'legacy-native' },
      'example.com'
    );
    expect(response.hardware).toBeUndefined();
    expect(response.providerInstanceType).toBe('legacy-native');
  });
});
