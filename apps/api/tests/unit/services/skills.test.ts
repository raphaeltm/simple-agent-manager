import { beforeEach, describe, expect, it, vi } from 'vitest';

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `mock-ulid-${++ulidCounter}`,
}));

import { resolveSkillProfile } from '../../../src/services/skills';

function createMockDB() {
  const queryResults: unknown[] = [];
  let queryIndex = 0;
  // Resolves to the next queued query result, mirroring Drizzle's lazy execution.
  const nextResult = () => Promise.resolve(queryResults[queryIndex++] ?? []);

  // Drizzle query builders are thenable: a chain ending at `.where()` (with no
  // `.limit()`/`.orderBy()`) is awaited directly. We model that with a Proxy so
  // the `then` handler is supplied via the get-trap rather than as an object
  // literal property (which would be a thenable foot-gun and a SonarCloud bug).
  function makeChain(): any {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (
              resolve: (value: unknown) => unknown,
              reject?: (reason: unknown) => unknown
            ) => nextResult().then(resolve, reject);
          }
          if (prop === 'limit' || prop === 'orderBy') {
            return () => nextResult();
          }
          // from / where and any other builder method stay chainable.
          return () => makeChain();
        },
      }
    );
  }

  const db: any = {
    _pushResult(value: unknown) {
      queryResults.push(value);
    },
    select: vi.fn(() => makeChain()),
  };
  return db;
}

const NOW = '2026-05-31T00:00:00.000Z';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'implementer',
    description: null,
    agentType: 'claude-code',
    model: 'profile-model',
    permissionMode: 'acceptEdits',
    systemPromptAppend: 'Profile prompt',
    maxTurns: 20,
    timeoutMinutes: 60,
    vmSizeOverride: 'small',
    provider: 'hetzner',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    taskMode: 'conversation',
    isBuiltin: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    ...makeProfile(),
    id: 'skill-1',
    name: 'ship-it',
    systemPromptAppend: 'Skill prompt',
    model: 'skill-model',
    vmSizeOverride: 'large',
    taskMode: 'task',
    resourceRequirementsJson: '{"minVcpu":4}',
    defaultProfileId: 'profile-1',
    ...overrides,
  };
}

describe('resolveSkillProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ulidCounter = 0;
  });

  it('lets skill fields override profile fields and concatenates system prompt append', async () => {
    const db = createMockDB();
    db._pushResult([makeSkill()]);
    db._pushResult([{ id: 'builtin' }]);
    db._pushResult([makeProfile()]);

    const resolved = await resolveSkillProfile(
      db,
      'project-1',
      null,
      'skill-1',
      'user-1',
      { DEFAULT_TASK_AGENT_TYPE: 'opencode' } as any
    );

    expect(resolved.skillId).toBe('skill-1');
    expect(resolved.profileId).toBe('profile-1');
    expect(resolved.model).toBe('skill-model');
    expect(resolved.vmSizeOverride).toBe('large');
    expect(resolved.taskMode).toBe('task');
    expect(resolved.systemPromptAppend).toBe('Profile prompt\n\nSkill prompt');
    expect(resolved.resourceRequirementsJson).toBe('{"minVcpu":4}');
  });

  it('keeps profile values when the skill leaves a field unset', async () => {
    const db = createMockDB();
    db._pushResult([makeSkill({ model: null, vmSizeOverride: null, systemPromptAppend: null })]);
    db._pushResult([{ id: 'builtin' }]);
    db._pushResult([makeProfile()]);

    const resolved = await resolveSkillProfile(
      db,
      'project-1',
      null,
      'skill-1',
      'user-1',
      { DEFAULT_TASK_AGENT_TYPE: 'opencode' } as any
    );

    expect(resolved.model).toBe('profile-model');
    expect(resolved.vmSizeOverride).toBe('small');
    expect(resolved.systemPromptAppend).toBe('Profile prompt');
  });
});
