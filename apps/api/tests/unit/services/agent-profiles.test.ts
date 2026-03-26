import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock drizzle before importing the service
vi.mock('drizzle-orm/d1');

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `mock-ulid-${++ulidCounter}`,
}));

import * as agentProfileService from '../../../src/services/agent-profiles';

/**
 * Build a mock DB that tracks all queries and allows configuring
 * return values for each chained query call.
 */
function createMockDB() {
  const queryResults: unknown[] = [];
  let queryIndex = 0;

  const db: any = {
    _pushResult(value: unknown) {
      queryResults.push(value);
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  // Each query builder chain ends with a terminal that returns the next result
  function makeChain() {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => {
        // If followed by .limit(), return chain; otherwise this is terminal
        const result = queryResults[queryIndex];
        if (result !== undefined && Array.isArray(result)) {
          // This might be a terminal call (no .limit)
          // Return a thenable that also has .limit()
          const thenable = Promise.resolve(result);
          (thenable as any).limit = vi.fn().mockImplementation(() => {
            return Promise.resolve(result);
          });
          (thenable as any).orderBy = vi.fn().mockImplementation(() => {
            return Promise.resolve(result);
          });
          queryIndex++;
          return thenable;
        }
        return chain;
      }),
      limit: vi.fn(() => {
        const result = queryResults[queryIndex] ?? [];
        queryIndex++;
        return Promise.resolve(result);
      }),
      orderBy: vi.fn(() => {
        const result = queryResults[queryIndex] ?? [];
        queryIndex++;
        return Promise.resolve(result);
      }),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
    };
    return chain;
  }

  db.select.mockImplementation(() => makeChain());
  db.insert.mockImplementation(() => makeChain());
  db.update.mockImplementation(() => makeChain());
  db.delete.mockImplementation(() => makeChain());

  return db;
}

const NOW = '2026-03-15T12:00:00.000Z';

function makeProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'default',
    description: 'General-purpose',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'acceptEdits',
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    taskMode: null,
    isBuiltin: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Agent Profile Service', () => {
  const env = { DEFAULT_TASK_AGENT_TYPE: 'claude-code' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    ulidCounter = 0;
  });

  describe('resolveAgentProfile', () => {

    it('returns platform defaults when profileNameOrId is null', async () => {
      const db = createMockDB();
      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', null, 'user-1', env
      );

      expect(result.profileId).toBeNull();
      expect(result.profileName).toBeNull();
      expect(result.agentType).toBe('claude-code');
    });

    it('returns platform defaults when profileNameOrId is empty string', async () => {
      const db = createMockDB();
      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', '', 'user-1', env
      );

      expect(result.profileId).toBeNull();
      expect(result.agentType).toBe('claude-code');
    });

    it('uses DEFAULT_TASK_AGENT_TYPE env var as fallback', async () => {
      const db = createMockDB();
      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', null, 'user-1',
        { DEFAULT_TASK_AGENT_TYPE: 'openai-codex' }
      );

      expect(result.agentType).toBe('openai-codex');
    });

    it('resolves profile by ID', async () => {
      const db = createMockDB();
      const profile = makeProfileRow({
        id: 'profile-abc',
        name: 'planner',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
      });

      // seedBuiltinProfiles: existing built-in profiles (all 4 present)
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId query
      db._pushResult([profile]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'profile-abc', 'user-1', env
      );

      expect(result.profileId).toBe('profile-abc');
      expect(result.profileName).toBe('planner');
      expect(result.model).toBe('claude-opus-4-6');
      expect(result.permissionMode).toBe('plan');
    });

    it('resolves profile by name when ID match not found', async () => {
      const db = createMockDB();

      // seedBuiltinProfiles
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId — not found
      db._pushResult([]);
      // byName in project — found
      db._pushResult([
        makeProfileRow({
          name: 'reviewer',
          model: 'claude-opus-4-6',
          permissionMode: 'plan',
          systemPromptAppend: 'Review code for correctness.',
        }),
      ]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'reviewer', 'user-1', env
      );

      expect(result.profileName).toBe('reviewer');
      expect(result.systemPromptAppend).toBe('Review code for correctness.');
    });

    it('falls back to valid agent type when no profile matches', async () => {
      const db = createMockDB();

      // seedBuiltinProfiles
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId — not found
      db._pushResult([]);
      // byName project — not found
      db._pushResult([]);
      // byName global — not found
      db._pushResult([]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'google-gemini', 'user-1', env
      );

      expect(result.profileId).toBeNull();
      expect(result.agentType).toBe('google-gemini');
    });

    it('falls back to DEFAULT_TASK_AGENT_TYPE when hint is not a valid agent type', async () => {
      const db = createMockDB();

      // seedBuiltinProfiles
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId — not found
      db._pushResult([]);
      // byName project — not found
      db._pushResult([]);
      // byName global — not found
      db._pushResult([]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'nonexistent-profile', 'user-1',
        { DEFAULT_TASK_AGENT_TYPE: 'openai-codex' }
      );

      expect(result.agentType).toBe('openai-codex');
    });

    it('propagates all profile fields to resolved output', async () => {
      const db = createMockDB();
      const profile = makeProfileRow({
        id: 'full-profile',
        name: 'custom',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        systemPromptAppend: 'Do amazing things.',
        maxTurns: 50,
        timeoutMinutes: 120,
        vmSizeOverride: 'cx22',
      });

      // seedBuiltinProfiles
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId — found
      db._pushResult([profile]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'full-profile', 'user-1', env
      );

      expect(result).toEqual({
        profileId: 'full-profile',
        profileName: 'custom',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        systemPromptAppend: 'Do amazing things.',
        maxTurns: 50,
        timeoutMinutes: 120,
        vmSizeOverride: 'cx22',
        provider: null,
        vmLocation: null,
        workspaceProfile: null,
        taskMode: null,
      });
    });

    it('propagates extended fields (provider, vmLocation, workspaceProfile, taskMode)', async () => {
      const db = createMockDB();
      const profile = makeProfileRow({
        id: 'extended-profile',
        name: 'infra-heavy',
        provider: 'hetzner',
        vmLocation: 'fsn1',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
        vmSizeOverride: 'cx32',
      });

      // seedBuiltinProfiles
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // byId — found
      db._pushResult([profile]);

      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', 'extended-profile', 'user-1', env
      );

      expect(result.provider).toBe('hetzner');
      expect(result.vmLocation).toBe('fsn1');
      expect(result.workspaceProfile).toBe('lightweight');
      expect(result.taskMode).toBe('conversation');
      expect(result.vmSizeOverride).toBe('cx32');
    });

    it('returns null for extended fields when not set on profile', async () => {
      const db = createMockDB();
      const result = await agentProfileService.resolveAgentProfile(
        db, 'project-1', null, 'user-1', env
      );

      expect(result.provider).toBeNull();
      expect(result.vmLocation).toBeNull();
      expect(result.workspaceProfile).toBeNull();
      expect(result.taskMode).toBeNull();
    });
  });

  describe('createProfile', () => {
    it('rejects empty name', async () => {
      const db = createMockDB();
      await expect(
        agentProfileService.createProfile(db, 'project-1', 'user-1', {
          name: '   ',
        }, env)
      ).rejects.toThrow('name is required');
    });

    it('rejects invalid agent type', async () => {
      const db = createMockDB();
      await expect(
        agentProfileService.createProfile(db, 'project-1', 'user-1', {
          name: 'test',
          agentType: 'invalid-type',
        }, env)
      ).rejects.toThrow('Invalid agent type');
    });

    it('rejects duplicate profile name in same project', async () => {
      const db = createMockDB();
      // Duplicate check returns existing
      db._pushResult([{ id: 'existing' }]);

      await expect(
        agentProfileService.createProfile(db, 'project-1', 'user-1', {
          name: 'default',
        }, env)
      ).rejects.toThrow('already exists');
    });
  });

  describe('listProfiles', () => {
    it('seeds built-in profiles and returns all profiles for a project', async () => {
      const db = createMockDB();
      // seedBuiltinProfiles: all 4 already exist
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      // listProfiles query (select + from + where + orderBy)
      db._pushResult([
        makeProfileRow({ id: 'p1', name: 'default' }),
        makeProfileRow({ id: 'p2', name: 'planner', isBuiltin: 1 }),
      ]);

      const result = await agentProfileService.listProfiles(db, 'project-1', 'user-1', env);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('p1');
      expect(result[1].id).toBe('p2');
      // isBuiltin should be converted from integer to boolean
      expect(result[0].isBuiltin).toBe(true);
    });

    it('converts isBuiltin from integer 0 to boolean false', async () => {
      const db = createMockDB();
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);
      db._pushResult([
        makeProfileRow({ id: 'p1', isBuiltin: 0 }),
      ]);

      const result = await agentProfileService.listProfiles(db, 'project-1', 'user-1', env);

      expect(result[0].isBuiltin).toBe(false);
    });
  });

  describe('getProfile', () => {
    it('returns a profile by ID', async () => {
      const db = createMockDB();
      const row = makeProfileRow({ id: 'profile-abc', name: 'my-profile' });
      db._pushResult([row]);

      const result = await agentProfileService.getProfile(db, 'project-1', 'profile-abc', 'user-1');

      expect(result.id).toBe('profile-abc');
      expect(result.name).toBe('my-profile');
      expect(result.isBuiltin).toBe(true); // isBuiltin: 1 -> true
    });

    it('throws NOT_FOUND when profile does not exist', async () => {
      const db = createMockDB();
      db._pushResult([]);

      await expect(
        agentProfileService.getProfile(db, 'project-1', 'nonexistent', 'user-1')
      ).rejects.toThrow();
    });
  });

  describe('updateProfile', () => {
    it('updates profile fields', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', name: 'custom', isBuiltin: 0 });
      // getProfile (verify exists) — select + from + where + limit
      db._pushResult([existingRow]);
      // update().set().where() consumes a result from queue
      db._pushResult([]);
      // getProfile (return updated) — select + from + where + limit
      db._pushResult([makeProfileRow({ id: 'profile-1', name: 'custom', isBuiltin: 0, model: 'claude-opus-4-6' })]);

      const result = await agentProfileService.updateProfile(
        db, 'project-1', 'profile-1', 'user-1',
        { model: 'claude-opus-4-6' }
      );

      expect(result.model).toBe('claude-opus-4-6');
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('updates extended fields (provider, vmLocation, workspaceProfile, taskMode)', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', name: 'custom', isBuiltin: 0 });
      db._pushResult([existingRow]);
      db._pushResult([]);
      db._pushResult([makeProfileRow({
        id: 'profile-1',
        name: 'custom',
        isBuiltin: 0,
        provider: 'scaleway',
        vmLocation: 'nl-ams-1',
        workspaceProfile: 'lightweight',
        taskMode: 'conversation',
      })]);

      const result = await agentProfileService.updateProfile(
        db, 'project-1', 'profile-1', 'user-1',
        { provider: 'scaleway', vmLocation: 'nl-ams-1', workspaceProfile: 'lightweight', taskMode: 'conversation' }
      );

      expect(result.provider).toBe('scaleway');
      expect(result.vmLocation).toBe('nl-ams-1');
      expect(result.workspaceProfile).toBe('lightweight');
      expect(result.taskMode).toBe('conversation');
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('rejects updates to built-in profiles', async () => {
      const db = createMockDB();
      const builtinRow = makeProfileRow({ id: 'profile-1', isBuiltin: 1 });
      db._pushResult([builtinRow]);

      await expect(
        agentProfileService.updateProfile(
          db, 'project-1', 'profile-1', 'user-1',
          { model: 'claude-opus-4-6' }
        )
      ).rejects.toThrow('Built-in profiles cannot be modified');
    });

    it('rejects invalid agent type on update', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', isBuiltin: 0 });
      db._pushResult([existingRow]);

      await expect(
        agentProfileService.updateProfile(
          db, 'project-1', 'profile-1', 'user-1',
          { agentType: 'invalid-type' }
        )
      ).rejects.toThrow('Invalid agent type');
    });

    it('rejects empty name on update', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', isBuiltin: 0 });
      db._pushResult([existingRow]);

      await expect(
        agentProfileService.updateProfile(
          db, 'project-1', 'profile-1', 'user-1',
          { name: '   ' }
        )
      ).rejects.toThrow('name cannot be empty');
    });

    it('rejects duplicate name when renaming', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', name: 'old-name', isBuiltin: 0 });
      // getProfile (verify exists)
      db._pushResult([existingRow]);
      // duplicate name check
      db._pushResult([{ id: 'other-profile' }]);

      await expect(
        agentProfileService.updateProfile(
          db, 'project-1', 'profile-1', 'user-1',
          { name: 'taken-name' }
        )
      ).rejects.toThrow('already exists');
    });
  });

  describe('deleteProfile', () => {
    it('deletes an existing profile', async () => {
      const db = createMockDB();
      const existingRow = makeProfileRow({ id: 'profile-1', isBuiltin: 0 });
      // getProfile (verify exists)
      db._pushResult([existingRow]);

      await agentProfileService.deleteProfile(db, 'project-1', 'profile-1', 'user-1');

      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('throws when profile does not exist', async () => {
      const db = createMockDB();
      db._pushResult([]);

      await expect(
        agentProfileService.deleteProfile(db, 'project-1', 'nonexistent', 'user-1')
      ).rejects.toThrow();
    });

    it('rejects deletion of built-in profiles', async () => {
      const db = createMockDB();
      const builtinRow = makeProfileRow({ id: 'profile-1', isBuiltin: 1 });
      db._pushResult([builtinRow]);

      await expect(
        agentProfileService.deleteProfile(db, 'project-1', 'profile-1', 'user-1')
      ).rejects.toThrow('Built-in profiles cannot be deleted');
    });
  });

  describe('createProfile (success path)', () => {
    it('creates a profile with default agent type from env', async () => {
      const db = createMockDB();
      // duplicate check — none found
      db._pushResult([]);
      // insert (void)
      // getProfile after insert — returns the created row
      db._pushResult([makeProfileRow({
        id: 'mock-ulid-1',
        name: 'my-custom',
        isBuiltin: 0,
        agentType: 'claude-code',
      })]);

      const result = await agentProfileService.createProfile(
        db, 'project-1', 'user-1',
        { name: 'my-custom' },
        env
      );

      expect(result.id).toBe('mock-ulid-1');
      expect(result.name).toBe('my-custom');
      expect(result.isBuiltin).toBe(false);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('seedBuiltinProfiles', () => {
    it('seeds 4 built-in profiles when none exist', async () => {
      const db = createMockDB();
      // No existing built-in profiles
      db._pushResult([]);

      await agentProfileService.seedBuiltinProfiles(db, 'project-1', 'user-1', env);

      // Should have called insert 4 times (default, planner, implementer, reviewer)
      expect(db.insert).toHaveBeenCalledTimes(4);
    });

    it('skips already existing built-in profiles', async () => {
      const db = createMockDB();
      // Two built-in profiles already exist
      db._pushResult([{ name: 'default' }, { name: 'planner' }]);

      await agentProfileService.seedBuiltinProfiles(db, 'project-1', 'user-1', env);

      // Should only insert 2 (implementer, reviewer)
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('does nothing when all built-in profiles exist', async () => {
      const db = createMockDB();
      db._pushResult([
        { name: 'default' }, { name: 'planner' }, { name: 'implementer' }, { name: 'reviewer' },
      ]);

      await agentProfileService.seedBuiltinProfiles(db, 'project-1', 'user-1', env);

      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
