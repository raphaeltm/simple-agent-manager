import { beforeEach, describe, expect, it, vi } from 'vitest';

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `mock-ulid-${++ulidCounter}`,
}));

import { deleteSkill, resolveSkillProfile, updateSkill } from '../../../src/services/skills';

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

  it('applies skill fields over platform defaults when no profile resolves', async () => {
    const db = createMockDB();
    // Skill with no default profile and no explicit profile hint: resolveAgentProfile
    // short-circuits to platform defaults without querying the profiles table.
    db._pushResult([makeSkill({ defaultProfileId: null })]);

    const resolved = await resolveSkillProfile(
      db,
      'project-1',
      null,
      'skill-1',
      'user-1',
      { DEFAULT_TASK_AGENT_TYPE: 'opencode' } as any
    );

    expect(resolved.skillId).toBe('skill-1');
    expect(resolved.profileId).toBeNull();
    // taskMode default of 'task' on the skill row wins over the null platform default.
    expect(resolved.taskMode).toBe('task');
    // Skill scalar fields fill in over null platform defaults.
    expect(resolved.model).toBe('skill-model');
    expect(resolved.vmSizeOverride).toBe('large');
    expect(resolved.systemPromptAppend).toBe('Skill prompt');
    expect(resolved.resourceRequirementsJson).toBe('{"minVcpu":4}');
  });

  it('falls back to skill-by-name lookup when the id lookup misses', async () => {
    const db = createMockDB();
    db._pushResult([]); // by-id lookup misses
    db._pushResult([makeSkill({ id: 'skill-7', name: 'ship-it', defaultProfileId: null })]); // by-name hit

    const resolved = await resolveSkillProfile(
      db,
      'project-1',
      null,
      'ship-it',
      'user-1',
      { DEFAULT_TASK_AGENT_TYPE: 'opencode' } as any
    );

    expect(resolved.skillId).toBe('skill-7');
    expect(resolved.skillName).toBe('ship-it');
    // skillHint preserves the raw lookup value the caller supplied.
    expect(resolved.skillHint).toBe('ship-it');
  });
});

describe('builtin skill guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ulidCounter = 0;
  });

  it('rejects updateSkill on a builtin skill with a 403 before issuing any write', async () => {
    const db = createMockDB();
    db._pushResult([makeSkill({ isBuiltin: 1 })]); // getSkill lookup
    db.update = vi.fn();

    await expect(
      updateSkill(db, 'project-1', 'skill-1', 'user-1', { name: 'renamed' })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects deleteSkill on a builtin skill with a 403 before issuing any write', async () => {
    const db = createMockDB();
    db._pushResult([makeSkill({ isBuiltin: 1 })]); // getSkill lookup
    db.delete = vi.fn();

    await expect(
      deleteSkill(db, 'project-1', 'skill-1', 'user-1')
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.delete).not.toHaveBeenCalled();
  });
});
