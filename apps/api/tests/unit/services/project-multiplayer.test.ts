import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearProjectMultiplayerStateCache,
  getProjectMultiplayerState,
} from '../../../src/services/project-multiplayer';

function makeDb(counts: number[]) {
  let callIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ count: counts[callIndex++] ?? 0 }],
      }),
    }),
  };
}

describe('project multiplayer state service', () => {
  beforeEach(() => {
    clearProjectMultiplayerStateCache();
  });
  it('treats an owner-only project with no invite or request as solo', async () => {
    const state = await getProjectMultiplayerState(
      makeDb([1, 0, 0]) as never,
      'proj-solo',
      new Date('2026-07-05T00:00:00.000Z')
    );

    expect(state).toEqual({
      activeMemberCount: 1,
      hasActiveInviteLink: false,
      hasPendingAccessRequest: false,
      multiplayerActive: false,
    });
  });

  it('activates multiplayer affordances when a second active member exists', async () => {
    const state = await getProjectMultiplayerState(makeDb([2, 0, 0]) as never, 'proj-shared');

    expect(state.multiplayerActive).toBe(true);
    expect(state.activeMemberCount).toBe(2);
  });

  it('activates multiplayer affordances for an active invite before another member joins', async () => {
    const state = await getProjectMultiplayerState(makeDb([1, 1, 0]) as never, 'proj-invite');

    expect(state.multiplayerActive).toBe(true);
    expect(state.hasActiveInviteLink).toBe(true);
  });

  it('activates multiplayer affordances for a pending access request', async () => {
    const state = await getProjectMultiplayerState(makeDb([1, 0, 1]) as never, 'proj-request');

    expect(state.multiplayerActive).toBe(true);
    expect(state.hasPendingAccessRequest).toBe(true);
  });

  it('reuses cached state within the configured TTL', async () => {
    const db = makeDb([1, 0, 0, 2, 0, 0]);

    const first = await getProjectMultiplayerState(
      db as never,
      'proj-cache',
      new Date('2026-08-19T00:00:00.000Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );
    const second = await getProjectMultiplayerState(
      db as never,
      'proj-cache',
      new Date('2026-08-19T00:00:00.500Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );

    expect(first.multiplayerActive).toBe(false);
    expect(second).toBe(first);
  });

  it('expires cached state after the configured TTL', async () => {
    const db = makeDb([1, 0, 0, 2, 0, 0]);

    const first = await getProjectMultiplayerState(
      db as never,
      'proj-expire',
      new Date('2026-08-19T00:00:00.000Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );
    const second = await getProjectMultiplayerState(
      db as never,
      'proj-expire',
      new Date('2026-08-19T00:00:01.001Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );

    expect(first.multiplayerActive).toBe(false);
    expect(second.multiplayerActive).toBe(true);
  });

  it('supports explicit cache invalidation', async () => {
    const db = makeDb([1, 0, 0, 2, 0, 0]);

    const first = await getProjectMultiplayerState(
      db as never,
      'proj-invalidate',
      new Date('2026-08-19T00:00:00.000Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );
    clearProjectMultiplayerStateCache('proj-invalidate');
    const second = await getProjectMultiplayerState(
      db as never,
      'proj-invalidate',
      new Date('2026-08-19T00:00:00.500Z'),
      { PROJECT_MULTIPLAYER_CACHE_TTL_MS: '1000' }
    );

    expect(first.multiplayerActive).toBe(false);
    expect(second.multiplayerActive).toBe(true);
  });
});
