import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { terminalRoutes } from '../../../src/routes/terminal';
import { signTerminalToken } from '../../../src/services/jwt';
import { updateTerminalActivity } from '../../../src/services/project-data';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () =>
    vi.fn((c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'Test User',
          avatarUrl: null,
          role: 'user',
          status: 'active',
        },
        session: {
          id: 'session-1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      return next();
    }),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/services/jwt', () => ({
  signTerminalToken: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  updateTerminalActivity: vi.fn(),
}));

interface WorkspaceRow {
  id: string;
  userId?: string;
  projectId: string | null;
  chatSessionId: string | null;
  status: string;
}

interface SelectChain {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

interface KvEntry {
  value: string;
}

function createMemoryKv(): Pick<KVNamespace, 'get' | 'put'> {
  const entries = new Map<string, KvEntry>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = entries.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      entries.set(key, { value });
    }),
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {} as D1Database,
    KV: createMemoryKv() as KVNamespace,
    BASE_DOMAIN: 'sammy.party',
    REQUIRE_APPROVAL: 'false',
    RATE_LIMIT_TERMINAL_TOKEN: '60',
    ...overrides,
  } as Env;
}

function createDb(workspaces: WorkspaceRow[]): SelectChain {
  const chain: SelectChain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => workspaces),
  };
  return chain;
}

function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 429 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/terminal', terminalRoutes);
  return app;
}

async function postJson(
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  env: Env
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('terminal routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    vi.mocked(signTerminalToken).mockResolvedValue({
      token: 'terminal.jwt',
      expiresAt: '2026-05-10T03:00:00.000Z',
    });
    vi.mocked(updateTerminalActivity).mockResolvedValue(undefined);
  });

  it('mints a terminal token for an accessible workspace owned by the user', async () => {
    const env = createEnv();
    vi.mocked(drizzle).mockReturnValue(
      createDb([
        {
          id: 'ws-123',
          userId: 'user-1',
          projectId: null,
          chatSessionId: null,
          status: 'running',
        },
      ]) as unknown as ReturnType<typeof drizzle>
    );

    const response = await postJson(app, '/api/terminal/token', { workspaceId: 'ws-123' }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'terminal.jwt',
      expiresAt: '2026-05-10T03:00:00.000Z',
      workspaceUrl: 'https://ws-ws-123.sammy.party',
    });
    expect(signTerminalToken).toHaveBeenCalledWith('user-1', 'ws-123', env);
    expect(updateTerminalActivity).not.toHaveBeenCalled();
  });

  it('rejects terminal token requests for workspaces not owned by the user', async () => {
    const env = createEnv();
    vi.mocked(drizzle).mockReturnValue(createDb([]) as unknown as ReturnType<typeof drizzle>);

    const response = await postJson(app, '/api/terminal/token', { workspaceId: 'ws-other' }, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'NOT_FOUND',
      message: 'Workspace not found',
    });
    expect(signTerminalToken).not.toHaveBeenCalled();
  });

  it('rejects terminal token requests for inaccessible workspace statuses', async () => {
    const env = createEnv();
    vi.mocked(drizzle).mockReturnValue(
      createDb([
        {
          id: 'ws-stopped',
          userId: 'user-1',
          projectId: 'proj-1',
          chatSessionId: 'sess-1',
          status: 'stopped',
        },
      ]) as unknown as ReturnType<typeof drizzle>
    );

    const response = await postJson(app, '/api/terminal/token', { workspaceId: 'ws-stopped' }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'BAD_REQUEST',
      message: 'Workspace is not accessible (status: stopped)',
    });
    expect(signTerminalToken).not.toHaveBeenCalled();
  });

  it('rate-limits terminal token generation per authenticated user', async () => {
    const env = createEnv({ RATE_LIMIT_TERMINAL_TOKEN: '1' });
    vi.mocked(drizzle).mockReturnValue(
      createDb([
        {
          id: 'ws-123',
          userId: 'user-1',
          projectId: null,
          chatSessionId: null,
          status: 'running',
        },
      ]) as unknown as ReturnType<typeof drizzle>
    );

    const first = await postJson(app, '/api/terminal/token', { workspaceId: 'ws-123' }, env);
    const second = await postJson(app, '/api/terminal/token', { workspaceId: 'ws-123' }, env);

    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    expect(await second.json()).toMatchObject({
      error: 'RATE_LIMIT_EXCEEDED',
    });
    expect(signTerminalToken).toHaveBeenCalledTimes(1);
  });

  it('does not apply the token minting limiter to terminal activity heartbeats', async () => {
    const env = createEnv({ RATE_LIMIT_TERMINAL_TOKEN: '1' });
    vi.mocked(drizzle).mockReturnValue(
      createDb([
        {
          id: 'ws-123',
          userId: 'user-1',
          projectId: 'proj-1',
          chatSessionId: 'sess-1',
          status: 'running',
        },
      ]) as unknown as ReturnType<typeof drizzle>
    );

    const first = await postJson(app, '/api/terminal/activity', { workspaceId: 'ws-123' }, env);
    const second = await postJson(app, '/api/terminal/activity', { workspaceId: 'ws-123' }, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(updateTerminalActivity).toHaveBeenCalledTimes(2);
    expect(signTerminalToken).not.toHaveBeenCalled();
  });
});
