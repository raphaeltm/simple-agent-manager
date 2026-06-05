import { vi } from 'vitest';

import { profileRuntimeRoutes } from '../../../src/routes/profile-runtime';
import { runRuntimeRouteTests } from './runtime-routes-test-suite';

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: mocks.encrypt,
}));

runRuntimeRouteTests({
  entityLabel: 'profile',
  basePath: '/api/projects/:projectId/agent-profiles/:profileId/runtime',
  routes: profileRuntimeRoutes,
  requestPrefix: '/api/projects/proj-1/agent-profiles/prof-1/runtime',
  outsideEntityEnvVarsPath: '/api/projects/proj-1/agent-profiles/other-prof/runtime/env-vars',
  entityRow: { id: 'prof-1', projectId: 'proj-1', userId: 'user-1' },
  rowTimestamp: '2026-05-16T00:00:00.000Z',
  expectedInsertEntity: { profileId: 'prof-1' },
  mocks,
});
