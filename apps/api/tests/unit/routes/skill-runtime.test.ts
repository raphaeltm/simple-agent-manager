import { vi } from 'vitest';

import { skillRuntimeRoutes } from '../../../src/routes/skill-runtime';
import { runRuntimeRouteTests } from './runtime-routes-test-suite';

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: mocks.encrypt,
}));

runRuntimeRouteTests({
  entityLabel: 'skill',
  basePath: '/api/projects/:projectId/skills/:skillId/runtime',
  routes: skillRuntimeRoutes,
  requestPrefix: '/api/projects/proj-1/skills/skill-1/runtime',
  outsideEntityEnvVarsPath: '/api/projects/proj-1/skills/other-skill/runtime/env-vars',
  entityRow: { id: 'skill-1', projectId: 'proj-1', userId: 'user-1' },
  rowTimestamp: '2026-05-31T00:00:00.000Z',
  expectedInsertEntity: { skillId: 'skill-1' },
  mocks,
});
