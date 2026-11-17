import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { aiProxyRoutes } from '../../../src/routes/ai-proxy';
import { aiProxyAnthropicRoutes } from '../../../src/routes/ai-proxy-anthropic';

/** #2674: unauthenticated requests reveal neither the kill switch nor missing gateway state. */
describe('combined AI routes authenticate before availability', () => {
  it.each([
    ['/ai/v1/chat/completions', undefined],
    ['/ai/v1/responses', undefined],
    ['/ai/v1/chat/completions', 'false'],
    ['/ai/v1/responses', 'false'],
    ['/ai/anthropic/v1/messages', 'false'],
    ['/ai/anthropic/v1/messages/count_tokens', undefined],
  ])('%s remains 401 with AI_PROXY_ENABLED=%s and no gateway', async (path, enabled) => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/ai/v1', aiProxyRoutes);
    app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
    const prepare = vi.fn(() => {
      throw new Error('Unauthenticated settings access');
    });
    const response = await app.request(
      path,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { DATABASE: { prepare }, AI_PROXY_ENABLED: enabled } as unknown as Env
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toMatch(/disabled|gateway|directUpstream/i);
    expect(prepare).not.toHaveBeenCalled();
  });
});
