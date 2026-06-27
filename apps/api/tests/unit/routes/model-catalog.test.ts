import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { modelCatalogRoutes } from '../../../src/routes/model-catalog';
import { getModelCatalogForAgent } from '../../../src/services/model-catalog';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../../../src/services/model-catalog', () => ({
  getModelCatalogForAgent: vi.fn(),
}));

describe('model catalog routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();
    app.route('/api/model-catalog', modelCatalogRoutes);
    vi.mocked(getModelCatalogForAgent).mockResolvedValue({
      agentType: 'opencode',
      groups: [
        {
          label: 'OpenCode Go',
          models: [{ id: 'opencode-go/glm-5.2', name: 'GLM-5.2', group: 'OpenCode Go' }],
        },
      ],
      source: 'dynamic',
      updatedAt: '2026-06-27T00:00:00.000Z',
    });
  });

  it('returns the model catalog for the requested agent type', async () => {
    const env = { KV: {} } as Env;

    const res = await app.request('/api/model-catalog/opencode', { method: 'GET' }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agentType: 'opencode',
      source: 'dynamic',
      groups: [{ label: 'OpenCode Go' }],
    });
    expect(getModelCatalogForAgent).toHaveBeenCalledWith(env, 'opencode');
  });
});
