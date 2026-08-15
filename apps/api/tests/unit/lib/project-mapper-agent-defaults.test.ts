import { describe, expect, it } from 'vitest';

import type * as schema from '../../../src/db/schema';
import { toProjectResponse } from '../../../src/lib/mappers';

function makeProjectRow(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'project-1',
    userId: 'user-1',
    name: 'Test project',
    normalizedName: 'test-project',
    description: null,
    installationId: 'install-1',
    repository: 'acme/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    artifactsRepoId: null,
    githubRepoId: null,
    githubRepoNodeId: null,
    defaultVmSize: null,
    defaultAgentType: null,
    defaultWorkspaceProfile: null,
    defaultDevcontainerConfigName: null,
    defaultProvider: null,
    defaultLocation: null,
    agentDefaults: null,
    workspaceIdleTimeoutMs: null,
    nodeIdleTimeoutMs: null,
    taskExecutionTimeoutMs: null,
    maxConcurrentTasks: null,
    maxDispatchDepth: null,
    maxSubTasksPerTask: null,
    warmNodeTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 0,
    createdBy: 'user-1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...overrides,
  } as schema.Project;
}

describe('toProjectResponse — agentDefaults parsing', () => {
  it('returns null when agentDefaults column is null', () => {
    const res = toProjectResponse(makeProjectRow({ agentDefaults: null }));
    expect(res.agentDefaults).toBeNull();
  });

  it('parses a well-formed agentDefaults record', () => {
    const raw = JSON.stringify({
      'claude-code': { model: 'claude-opus-4-7', permissionMode: 'acceptEdits' },
      'openai-codex': { model: 'gpt-5-codex' },
    });
    const res = toProjectResponse(makeProjectRow({ agentDefaults: raw }));
    expect(res.agentDefaults).toEqual({
      'claude-code': { model: 'claude-opus-4-7', permissionMode: 'acceptEdits' },
      'openai-codex': { model: 'gpt-5-codex' },
    });
  });

  it('returns null for JSON-syntax-invalid agentDefaults (unchanged behavior)', () => {
    const res = toProjectResponse(makeProjectRow({ agentDefaults: '{not valid json' }));
    expect(res.agentDefaults).toBeNull();
  });

  it('returns null for a JSON array agentDefaults (unchanged behavior)', () => {
    const res = toProjectResponse(makeProjectRow({ agentDefaults: '[]' }));
    expect(res.agentDefaults).toBeNull();
  });

  it('returns null for a per-agent entry that is not an object', () => {
    // Regression: the old blind cast (`parsed as ProjectAgentDefaults`) never
    // validated that each entry looked like { model?, permissionMode? } — a
    // string/number entry would have been handed to callers unchanged and
    // ProjectAgentsSection.tsx would read `.model`/`.permissionMode` off it.
    const raw = JSON.stringify({ 'claude-code': 'not-an-object' });
    const res = toProjectResponse(makeProjectRow({ agentDefaults: raw }));
    expect(res.agentDefaults).toBeNull();
  });

  it('returns null when an entry has an out-of-enum permissionMode', () => {
    const raw = JSON.stringify({ 'claude-code': { permissionMode: 'notAValidMode' } });
    const res = toProjectResponse(makeProjectRow({ agentDefaults: raw }));
    expect(res.agentDefaults).toBeNull();
  });

  it('preserves a null model/permissionMode within an otherwise well-formed entry', () => {
    const raw = JSON.stringify({ 'claude-code': { model: null, permissionMode: 'plan' } });
    const res = toProjectResponse(makeProjectRow({ agentDefaults: raw }));
    expect(res.agentDefaults).toEqual({ 'claude-code': { model: null, permissionMode: 'plan' } });
  });
});
