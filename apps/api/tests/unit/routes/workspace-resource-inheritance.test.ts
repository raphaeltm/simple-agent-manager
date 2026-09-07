import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerWorkspaceCreateRoute } from '../../../src/routes/workspaces/workspace-create';
import { fixture } from './node-pool-upgrade-test-helpers';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({ user: { id: 'user-1', name: 'User One', email: 'user-1@example.com', role: 'user', status: 'active' } }),
}));
vi.mock('../../../src/routes/projects/_helpers', async (load) => ({
  ...(await load<typeof import('../../../src/routes/projects/_helpers')>()),
  requireRepositoryUserAccess: vi.fn(async () => undefined),
}));

afterEach(() => vi.unstubAllGlobals());

describe('direct workspace resource inheritance through HTTP and persisted reservations', () => {
  it.each([
    { label: 'blank', body: {}, cpu: 1000, memory: 1024, disk: 2048, source: 'project' },
    { label: 'partial', body: { resourceRequirements: { minMemoryGb: 2 } }, cpu: 1000, memory: 2048, disk: 2048, source: 'project' },
    { label: 'explicit legacy', body: { vmSize: 'small' }, cpu: 1000, memory: 2048, disk: 20480, source: 'task' },
  ])('$label requirements preserve field precedence', async ({ body, cpu, memory, disk, source }) => {
    const f = fixture();
    f.sqlite.prepare('UPDATE projects SET resource_requirements_json = ?').run(JSON.stringify({
      minVcpu: 1, minMemoryGb: 1, minDiskGb: 2, exclusiveNode: false, maxCoTenants: 8,
    }));
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500));
    registerWorkspaceCreateRoute(app);
    // No external provider or VM call is allowed; the failed asynchronous
    // provisioning path still retains the reservation created by the HTTP route.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External HTTP unavailable in test'); }));
    const pending: Promise<unknown>[] = [];
    const response = await app.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Inherited workspace', projectId: 'project-1', ...body }),
    }, f.env, {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);
    const result = await response.json();
    await Promise.allSettled(pending);
    expect(response.status, JSON.stringify(result)).toBe(201);
    const workspace = f.sqlite.prepare('SELECT resolved_reservation_json FROM workspaces').get() as { resolved_reservation_json: string };
    const reservation = JSON.parse(workspace.resolved_reservation_json);
    expect(reservation).toMatchObject({ cpuMillis: cpu, memoryMb: memory, diskMb: disk });
    expect(reservation.fieldProvenance.minVcpu.source).toBe(source);
    const task = f.sqlite.prepare("SELECT resolved_reservation_json FROM tasks WHERE title = 'Inherited workspace'").get();
    expect(task).toEqual(workspace);
  });
});
