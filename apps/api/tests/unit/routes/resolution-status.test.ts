import type { CCCompositionSnapshot } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  buildSnapshot: vi.fn(),
  lazyBackfillIfNeeded: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: mocks.lazyBackfillIfNeeded,
}));
vi.mock('../../../src/services/composable-credentials/snapshot', () => ({
  buildSnapshot: mocks.buildSnapshot,
}));

import { resolutionStatusRoute } from '../../../src/routes/resolution-status';

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/credentials', resolutionStatusRoute);
  return app;
}

describe('resolution-status route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    mocks.lazyBackfillIfNeeded.mockResolvedValue(false);
  });

  it('reports a freshly mirrored Hetzner user default as user-attachment, not platform', async () => {
    const snapshot: CCCompositionSnapshot = {
      credentials: [
        {
          id: 'cc-cred-user-hetzner',
          ownerId: 'test-user-id',
          name: 'Hetzner cloud credential',
          kind: 'cloud-provider',
          secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'user-token' },
          isActive: true,
        },
      ],
      configurations: [
        {
          id: 'cc-cfg-user-hetzner',
          ownerId: 'test-user-id',
          name: 'Hetzner default',
          consumer: { kind: 'compute', provider: 'hetzner' },
          credentialId: 'cc-cred-user-hetzner',
          settings: {},
          isActive: true,
        },
      ],
      attachments: [
        {
          id: 'cc-att-user-hetzner',
          configurationId: 'cc-cfg-user-hetzner',
          consumer: { kind: 'compute', provider: 'hetzner' },
          target: { scope: 'user', userId: 'test-user-id' },
          isActive: true,
        },
      ],
      platform: {
        'compute:hetzner': {
          mode: 'credential',
          credential: {
            id: 'platform-hetzner',
            ownerId: 'platform',
            name: 'SAM Hetzner',
            kind: 'cloud-provider',
            secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'platform-token' },
            isActive: true,
          },
        },
      },
    };
    mocks.buildSnapshot.mockResolvedValue(snapshot);

    const res = await makeApp().request(
      '/api/credentials/resolution-status',
      { method: 'GET' },
      { DATABASE: {} as Env['DATABASE'], ENCRYPTION_KEY: 'test-key' } as Env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consumers: Array<{ consumerId: string; consumerKind: string; source: string }>;
    };
    const hetzner = body.consumers.find(
      (consumer) => consumer.consumerKind === 'compute' && consumer.consumerId === 'hetzner'
    );
    expect(hetzner).toMatchObject({ source: 'user-attachment' });
    expect(hetzner?.source).not.toBe('platform');
    expect(mocks.lazyBackfillIfNeeded).toHaveBeenCalledWith(expect.anything(), 'test-user-id');
  });
});
