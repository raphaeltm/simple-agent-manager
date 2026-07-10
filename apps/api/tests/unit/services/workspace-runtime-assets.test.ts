import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
}));

vi.mock('../../../src/services/encryption', () => ({
  decrypt: mocks.decrypt,
}));

import { getWorkspaceRuntimeAssets } from '../../../src/services/workspace-runtime-assets';

function makeDbWithLimitAwareness(rowsBySelect: unknown[][]) {
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      const rows = rowsBySelect[selectCall] ?? [];
      selectCall += 1;
      const whereResult = Promise.resolve(rows) as Promise<unknown[]> & {
        limit: ReturnType<typeof vi.fn>;
      };
      whereResult.limit = vi.fn().mockResolvedValue(rows);
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(whereResult),
        }),
      };
    }),
  };
}

describe('workspace runtime asset resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockResolvedValue('decrypted-secret');
  });

  it('returns project-only runtime assets for a workspace without profile or skill context', async () => {
    const db = makeDbWithLimitAwareness([
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [],
      [{ key: 'API_TOKEN', storedValue: 'encrypted-token', valueIv: 'iv', isSecret: true }],
      [{ path: '.env.local', storedContent: 'FOO=bar', contentIv: null, isSecret: false }],
    ]);

    const assets = await getWorkspaceRuntimeAssets(db as never, { workspaceId: 'ws-1' }, 'enc-key');

    expect(assets).toEqual({
      workspaceId: 'ws-1',
      envVars: [{ key: 'API_TOKEN', value: 'decrypted-secret', isSecret: true }],
      files: [{ path: '.env.local', content: 'FOO=bar', isSecret: false }],
    });
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-token', 'iv', 'enc-key');
  });

  it('merges project, task profile, and skill runtime assets with skill precedence', async () => {
    const db = makeDbWithLimitAwareness([
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ profileId: 'profile-1', skillId: 'skill-1' }],
      [{ id: 'profile-1' }],
      [{ id: 'skill-1' }],
      [
        { key: 'SHARED_KEY', storedValue: 'project-value', valueIv: null, isSecret: false },
        { key: 'PROJECT_ONLY', storedValue: 'project-only', valueIv: null, isSecret: false },
      ],
      [
        { path: 'shared.txt', storedContent: 'project-file', contentIv: null, isSecret: false },
        { path: 'project.txt', storedContent: 'project-only-file', contentIv: null, isSecret: false },
      ],
      [
        { key: 'SHARED_KEY', storedValue: 'profile-value', valueIv: null, isSecret: false },
        { key: 'PROFILE_ONLY', storedValue: 'profile-only', valueIv: null, isSecret: false },
      ],
      [
        { path: 'shared.txt', storedContent: 'profile-file', contentIv: null, isSecret: false },
        { path: 'profile.txt', storedContent: 'profile-only-file', contentIv: null, isSecret: false },
      ],
      [
        { key: 'SHARED_KEY', storedValue: 'skill-value', valueIv: null, isSecret: false },
        { key: 'SKILL_ONLY', storedValue: 'skill-only', valueIv: null, isSecret: false },
      ],
      [
        { path: 'shared.txt', storedContent: 'skill-file', contentIv: null, isSecret: false },
        { path: 'skill.txt', storedContent: 'skill-only-file', contentIv: null, isSecret: false },
      ],
    ]);

    const assets = await getWorkspaceRuntimeAssets(db as never, { workspaceId: 'ws-1' }, 'enc-key');

    expect(assets.envVars).toEqual([
      { key: 'SHARED_KEY', value: 'skill-value', isSecret: false },
      { key: 'PROJECT_ONLY', value: 'project-only', isSecret: false },
      { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
      { key: 'SKILL_ONLY', value: 'skill-only', isSecret: false },
    ]);
    expect(assets.files).toEqual([
      { path: 'shared.txt', content: 'skill-file', isSecret: false },
      { path: 'project.txt', content: 'project-only-file', isSecret: false },
      { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
      { path: 'skill.txt', content: 'skill-only-file', isSecret: false },
    ]);
  });

  it('uses taskless agent session runtime context when agentSessionId is supplied', async () => {
    const db = makeDbWithLimitAwareness([
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{
        id: 'agent-session-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        profileId: 'profile-1',
        skillId: 'skill-1',
      }],
      [{ id: 'profile-1' }],
      [{ id: 'skill-1' }],
      [],
      [],
      [{ key: 'PROFILE_ONLY', storedValue: 'profile-only', valueIv: null, isSecret: false }],
      [],
      [{ key: 'SKILL_ONLY', storedValue: 'skill-only', valueIv: null, isSecret: false }],
      [],
    ]);

    const assets = await getWorkspaceRuntimeAssets(
      db as never,
      { workspaceId: 'ws-1', agentSessionId: 'agent-session-1' },
      'enc-key'
    );

    expect(assets.envVars).toEqual([
      { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
      { key: 'SKILL_ONLY', value: 'skill-only', isSecret: false },
    ]);
  });

  it('fails closed when supplied agentSessionId belongs to another workspace', async () => {
    const db = makeDbWithLimitAwareness([
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{
        id: 'agent-session-2',
        workspaceId: 'ws-2',
        userId: 'user-1',
        profileId: 'profile-1',
        skillId: null,
      }],
    ]);

    await expect(
      getWorkspaceRuntimeAssets(
        db as never,
        { workspaceId: 'ws-1', agentSessionId: 'agent-session-2' },
        'enc-key'
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('fails closed when supplied agentSessionId references a profile outside the workspace project', async () => {
    const db = makeDbWithLimitAwareness([
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{ id: 'ws-1', userId: 'user-1', projectId: 'project-1', agentProfileHint: null }],
      [{
        id: 'agent-session-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        profileId: 'profile-from-other-project',
        skillId: null,
      }],
      [],
      [],
    ]);

    await expect(
      getWorkspaceRuntimeAssets(
        db as never,
        { workspaceId: 'ws-1', agentSessionId: 'agent-session-1' },
        'enc-key'
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
