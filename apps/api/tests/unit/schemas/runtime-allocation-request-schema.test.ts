import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { CreateNodeSchema } from '../../../src/schemas/nodes';
import { CreateWorkspaceSchema } from '../../../src/schemas/workspaces';

describe('runtime allocation request schemas', () => {
  it('accepts provider-native node creation without vmSize alias authority', () => {
    const parsed = v.parse(CreateNodeSchema, {
      name: 'native-node',
      provider: 'hetzner',
      providerInstanceType: 'arbitrary-provider-sku-without-alias',
      bootDiskSizeGb: 120,
      image: 'ubuntu-24.04',
      architecture: 'arm64',
    });

    expect(parsed).toMatchObject({
      providerInstanceType: 'arbitrary-provider-sku-without-alias',
      bootDiskSizeGb: 120,
      image: 'ubuntu-24.04',
      architecture: 'arm64',
    });
    expect(parsed.vmSize).toBeUndefined();
  });

  it('accepts modern workspace resource requirements with explicit false exclusivity', () => {
    const parsed = v.parse(CreateWorkspaceSchema, {
      name: 'native-workspace',
      projectId: 'project-1',
      repository: 'owner/repo',
      providerInstanceType: 'custom-provider-shape',
      bootDiskSizeGb: 64,
      architecture: 'x86_64',
      resourceRequirements: {
        minVcpu: 2,
        minMemoryGb: 4,
        minDiskGb: 0,
        exclusiveNode: false,
        maxCoTenants: 3,
      },
    });

    expect(parsed.resourceRequirements).toEqual({
      minVcpu: 2,
      minMemoryGb: 4,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 3,
    });
  });

  it.each([
    ['node boot disk zero', CreateNodeSchema, { name: 'bad', bootDiskSizeGb: 0 }],
    ['node boot disk fractional', CreateNodeSchema, { name: 'bad', bootDiskSizeGb: 1.5 }],
    [
      'workspace min vcpu zero',
      CreateWorkspaceSchema,
      { name: 'bad', projectId: 'project-1', resourceRequirements: { minVcpu: 0 } },
    ],
    [
      'workspace disk negative',
      CreateWorkspaceSchema,
      { name: 'bad', projectId: 'project-1', resourceRequirements: { minDiskGb: -1 } },
    ],
    [
      'workspace max co-tenants fractional',
      CreateWorkspaceSchema,
      { name: 'bad', projectId: 'project-1', resourceRequirements: { maxCoTenants: 1.5 } },
    ],
  ])('rejects invalid numeric native/resource field: %s', (_name, schema, payload) => {
    expect(v.safeParse(schema, payload).success).toBe(false);
  });
});
