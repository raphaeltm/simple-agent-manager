import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import { UpdateProjectSchema } from '../../../src/schemas/projects';
import { RunTaskSchema, SubmitTaskSchema } from '../../../src/schemas/tasks';
import { CreateWorkspaceSchema } from '../../../src/schemas/workspaces';

const validNodeId = '01KZR2JAP92AK3SKW951E4H21M';

describe('placement request boundaries', () => {
  it.each([SubmitTaskSchema, RunTaskSchema])(
    'accepts canonical task placement inputs',
    (schema) => {
      expect(
        safeParse(schema, { message: 'run', nodeId: validNodeId, vmLocation: 'us-central1-a' })
          .success
      ).toBe(true);
    }
  );

  it('accepts canonical manual workspace placement inputs', () => {
    expect(
      safeParse(CreateWorkspaceSchema, {
        name: 'workspace',
        projectId: 'project-1',
        nodeId: validNodeId,
        vmLocation: 'hel1',
      }).success
    ).toBe(true);
  });

  it.each(['not-a-node-id', `${validNodeId}CANARY_SECRET`, `01KZR2JAP92AK3SKW951E4H2\n`])(
    'rejects non-canonical node identifier %j',
    (nodeId) => {
      expect(safeParse(SubmitTaskSchema, { message: 'run', nodeId }).success).toBe(false);
      expect(
        safeParse(CreateWorkspaceSchema, { name: 'workspace', projectId: 'project-1', nodeId })
          .success
      ).toBe(false);
    }
  );

  it.each(['', 'hel1\nCANARY_SECRET', 'x'.repeat(65)])(
    'rejects unsafe VM location %j',
    (vmLocation) => {
      expect(safeParse(SubmitTaskSchema, { message: 'run', vmLocation }).success).toBe(false);
      expect(
        safeParse(CreateWorkspaceSchema, {
          name: 'workspace',
          projectId: 'project-1',
          vmLocation,
        }).success
      ).toBe(false);
    }
  );

  it('accepts large positive project limits without undocumented ceilings', () => {
    expect(
      safeParse(UpdateProjectSchema, {
        maxWorkspacesPerNode: 20000,
        nodeCpuThresholdPercent: 100,
        nodeMemoryThresholdPercent: 0,
      }).success
    ).toBe(true);
  });

  it.each([
    { maxWorkspacesPerNode: 0 },
    { maxWorkspacesPerNode: 1.5 },
    { nodeCpuThresholdPercent: -1 },
    { nodeMemoryThresholdPercent: 101 },
  ])('rejects invalid project placement limit %j', (input) => {
    expect(safeParse(UpdateProjectSchema, input).success).toBe(false);
  });
});
