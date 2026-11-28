/**
 * Shared harness for the test-only fake AI upstream suites (`ai-test-upstream-ceiling.test.ts`,
 * no AI Gateway; `ai-test-upstream-gateway.test.ts`, with one): admin settings, a caller with a
 * running workspace and its callback token, and calls through the real Worker.
 */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';

import type { Env } from '../../../src/env';
import worker from '../../../src/index';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { invalidateAdminSettings } from '../../../src/services/admin-settings-resolution';
import { signCallbackToken } from '../../../src/services/jwt';
import { seedNode, seedUser, seedWorkspace } from './seed-d1';

export const bindings = env as unknown as Env;

/** A catalog Anthropic model whose output price keeps four $0.40 calls under the daily budget. */
export const CLAUDE_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'anthropic' && model.costPer1kOutputTokens >= 0.015
)!;
export const OPENAI_MODEL = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'openai' && model.costPer1kOutputTokens >= 0.008
)!;

export const nativeMessages = (stream: boolean) => ({
  model: CLAUDE_MODEL.id,
  max_tokens: 64,
  stream,
  messages: [{ role: 'user', content: 'hello' }],
});

export interface TestUpstreamHarness {
  setSettings(
    changes: Parameters<typeof updateAdminSettings>[1]['changes'],
    overrides?: Partial<Env>
  ): Promise<void>;
  seedCaller(suffix: string): Promise<{ userId: string; token: string }>;
  call(
    path: string,
    token: string,
    body: Record<string, unknown>,
    overrides?: Partial<Env>
  ): Promise<Response>;
}

/** A harness whose ids start with `prefix` and whose calls run with `defaultEnv` over bindings. */
export function testUpstreamHarness(prefix: string, defaultEnv: Partial<Env>): TestUpstreamHarness {
  const adminId = `${prefix}-admin`;
  return {
    async setSettings(changes, overrides = defaultEnv) {
      await seedUser(adminId);
      await updateAdminSettings({ ...bindings, ...overrides }, { actorUserId: adminId, changes });
      invalidateAdminSettings(bindings);
    },
    async seedCaller(suffix) {
      const userId = `${prefix}-${suffix}`;
      const workspaceId = `${prefix}-ws-${suffix}`;
      await seedUser(userId);
      const nodeId = `${prefix}-node-${suffix}`;
      await seedNode(nodeId, userId);
      await seedWorkspace(workspaceId, nodeId, userId, { status: 'running' });
      return {
        userId,
        token: await signCallbackToken(workspaceId, bindings, { callbackGeneration: null }),
      };
    },
    async call(path, token, body, overrides = defaultEnv) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://api.${bindings.BASE_DOMAIN}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        }),
        { ...bindings, ...overrides },
        ctx
      );
      // Read the body before draining waitUntil: accounting runs on the streamed body.
      const text = await response.text();
      await waitOnExecutionContext(ctx);
      return new Response(text, { status: response.status, headers: response.headers });
    },
  };
}
