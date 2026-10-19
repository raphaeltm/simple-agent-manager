import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionAccessResolution } from '../../../src/durable-objects/project-data/session-access';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

/**
 * `requireSessionWriter` decides who may drive a chat session. The SQL that resolves the
 * owner/grantee role is tested against real SQLite in
 * `tests/unit/durable-objects/session-access.test.ts`; this file covers what the service adds
 * on top: live membership for both people — and nothing else (product rule, 2026-10-19).
 */

const mocks = vi.hoisted(() => ({
  getSessionAccess: vi.fn(),
  hasProjectCapability: vi.fn(),
  requireRepositoryAccess: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({ mockedDb: true })) }));
vi.mock('../../../src/services/project-data', () => ({
  getSessionAccess: mocks.getSessionAccess,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  hasProjectCapability: mocks.hasProjectCapability,
}));
vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryAccess: mocks.requireRepositoryAccess,
}));

const { requireSessionWriter } = await import('../../../src/services/session-access');

const env = { DATABASE: {} } as unknown as Env;
const session = { id: 'session-1', topic: 'Fix the build' };

function access(overrides: Partial<SessionAccessResolution> = {}): SessionAccessResolution {
  return {
    found: true,
    ownerUserId: 'owner-1',
    sessionStatus: 'active',
    role: 'none',
    grant: null,
    ...overrides,
  };
}

const grant = {
  id: 'grant-1',
  sessionId: 'session-1',
  granteeUserId: 'grantee-1',
  grantedByUserId: 'owner-1',
  parentGrantId: null,
  createdAt: 1,
};

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('requireSessionWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasProjectCapability.mockResolvedValue(true);
    mocks.requireRepositoryAccess.mockResolvedValue(undefined);
  });

  it('returns the owner as both actor and credential owner, with no extra checks', async () => {
    mocks.getSessionAccess.mockResolvedValue({ session, access: access({ role: 'owner' }) });

    await expect(requireSessionWriter(env, 'project-1', 'session-1', 'owner-1')).resolves.toEqual({
      projectId: 'project-1',
      sessionId: 'session-1',
      session,
      role: 'owner',
      actorUserId: 'owner-1',
      ownerUserId: 'owner-1',
      grantId: null,
    });
    expect(mocks.getSessionAccess).toHaveBeenCalledWith(env, 'project-1', 'session-1', 'owner-1');
    expect(mocks.hasProjectCapability).not.toHaveBeenCalled();
    expect(mocks.requireRepositoryAccess).not.toHaveBeenCalled();
  });

  it('keeps the grantee as actor and the owner as credential owner', async () => {
    mocks.getSessionAccess.mockResolvedValue({
      session,
      access: access({ role: 'grantee', grant }),
    });

    await expect(
      requireSessionWriter(env, 'project-1', 'session-1', 'grantee-1')
    ).resolves.toMatchObject({
      role: 'grantee',
      actorUserId: 'grantee-1',
      ownerUserId: 'owner-1',
      grantId: 'grant-1',
    });
    expect(mocks.hasProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'grantee-1',
      'task:write'
    );
    expect(mocks.hasProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'owner-1',
      'task:write'
    );
    // Once shared, nothing else is checked: no repository access of the grantee's own.
    expect(mocks.requireRepositoryAccess).not.toHaveBeenCalled();
  });

  it('maps a missing session to 404', async () => {
    mocks.getSessionAccess.mockResolvedValue({
      session: null,
      access: access({ found: false, ownerUserId: null }),
    });

    const error = await rejection(requireSessionWriter(env, 'project-1', 'session-1', 'owner-1'));
    expect(error.statusCode).toBe(404);
  });

  it('rejects a project member who neither owns nor was granted the session', async () => {
    mocks.getSessionAccess.mockResolvedValue({ session, access: access({ role: 'none' }) });

    const error = await rejection(
      requireSessionWriter(env, 'project-1', 'session-1', 'reader-1', {
        action: 'stop this session',
      })
    );
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Only the session owner or someone they shared it with can stop this session'
    );
    expect(mocks.hasProjectCapability).not.toHaveBeenCalled();
  });

  it('fails closed when the grantee role arrives without its grant row', async () => {
    mocks.getSessionAccess.mockResolvedValue({
      session,
      access: access({ role: 'grantee', grant: null }),
    });

    const error = await rejection(requireSessionWriter(env, 'project-1', 'session-1', 'grantee-1'));
    expect(error.statusCode).toBe(403);
  });

  it('rejects a grantee who is no longer an active member', async () => {
    mocks.getSessionAccess.mockResolvedValue({
      session,
      access: access({ role: 'grantee', grant }),
    });
    mocks.hasProjectCapability.mockImplementation(
      async (_db: unknown, _projectId: string, userId: string) => userId !== 'grantee-1'
    );

    const error = await rejection(requireSessionWriter(env, 'project-1', 'session-1', 'grantee-1'));
    expect(error.statusCode).toBe(403);
  });

  it('rejects every grantee once the owner has left the project', async () => {
    mocks.getSessionAccess.mockResolvedValue({
      session,
      access: access({ role: 'grantee', grant }),
    });
    mocks.hasProjectCapability.mockImplementation(
      async (_db: unknown, _projectId: string, userId: string) => userId !== 'owner-1'
    );

    const error = await rejection(requireSessionWriter(env, 'project-1', 'session-1', 'grantee-1'));
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('The owner of this session is no longer a member of this project');
  });
});
