import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  isSignupApprovalRequired: vi.fn(),
}));

vi.mock('../../../src/services/signup-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/signup-approval')>();
  return {
    ...actual,
    isSignupApprovalRequired: mocks.isSignupApprovalRequired,
  };
});

import { requireApproved } from '../../../src/middleware/auth';

function authContext(
  role: AuthContext['user']['role'],
  status: AuthContext['user']['status']
): AuthContext {
  return {
    user: {
      id: `${role}-${status}`,
      email: `${role}-${status}@example.com`,
      name: null,
      avatarUrl: null,
      role,
      status,
    },
    session: {
      id: 'session-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    },
  };
}

function buildApp(auth: AuthContext) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get('/protected', requireApproved(), (c) => c.json({ ok: true }));
  return app;
}

describe('requireApproved account-status boundary', () => {
  beforeEach(() => {
    mocks.isSignupApprovalRequired.mockReset();
  });

  it.each([
    {
      requireApproval: false,
      role: 'user',
      status: 'active',
      expectedStatus: 200,
      expectedError: undefined,
    },
    {
      requireApproval: true,
      role: 'user',
      status: 'active',
      expectedStatus: 200,
      expectedError: undefined,
    },
    {
      requireApproval: false,
      role: 'user',
      status: 'pending',
      expectedStatus: 200,
      expectedError: undefined,
    },
    {
      requireApproval: true,
      role: 'user',
      status: 'pending',
      expectedStatus: 403,
      expectedError: 'APPROVAL_REQUIRED',
    },
    {
      requireApproval: false,
      role: 'admin',
      status: 'pending',
      expectedStatus: 200,
      expectedError: undefined,
    },
    {
      requireApproval: true,
      role: 'admin',
      status: 'pending',
      expectedStatus: 200,
      expectedError: undefined,
    },
    {
      requireApproval: false,
      role: 'user',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
    {
      requireApproval: true,
      role: 'user',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
    {
      requireApproval: false,
      role: 'admin',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
    {
      requireApproval: true,
      role: 'admin',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
    {
      requireApproval: false,
      role: 'superadmin',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
    {
      requireApproval: true,
      role: 'superadmin',
      status: 'suspended',
      expectedStatus: 403,
      expectedError: 'FORBIDDEN',
    },
  ] as const)(
    '$role/$status with approval=$requireApproval returns $expectedStatus',
    async ({ requireApproval, role, status, expectedStatus, expectedError }) => {
      mocks.isSignupApprovalRequired.mockResolvedValue(requireApproval);

      const res = await buildApp(authContext(role, status)).request('/protected');

      expect(res.status).toBe(expectedStatus);
      if (expectedError) {
        await expect(res.json()).resolves.toMatchObject({ error: expectedError });
      } else {
        await expect(res.json()).resolves.toEqual({ ok: true });
      }
    }
  );
});
