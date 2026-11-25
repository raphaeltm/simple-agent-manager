/**
 * Public test-only fake AI upstream, `POST /ai/_test-upstream/*` (`services/ai-test-upstream.ts`).
 *
 * The in-process fake serves installations without an AI Gateway. On an installation WITH a
 * gateway, spend is priced from the gateway's logs, so a call has to travel through the real
 * gateway to be metered. The gateway reaches this route as a custom provider's base URL, so the
 * gateway logs real usage for it.
 *
 * It answers only with canned provider-shaped bodies (`buildFakeUpstreamResponse`): it reads no
 * credentials, calls nothing and forwards nothing. It returns 404 unless the deploy-time locks
 * open (`isAiTestUpstreamDeployable`: `AI_TEST_UPSTREAM_ENABLED=true` on a test/staging/self-host
 * `ENVIRONMENT`), so production never serves it.
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { readRequestJsonRecord } from '../lib/runtime-validation';
import {
  isAiTestUpstreamDeployable,
  resolveAiTestUpstreamCostPerCallUsd,
} from '../services/ai-test-upstream';
import { buildFakeUpstreamResponse } from '../services/ai-test-upstream-responses';
import { aiProxyRequestBodyMaxBytes } from './ai-proxy-admission';

const MOUNT_PATH = '/ai/_test-upstream';

const aiTestUpstreamRoutes = new Hono<{ Bindings: Env }>();

aiTestUpstreamRoutes.post('/*', async (c) => {
  if (!isAiTestUpstreamDeployable(c.env)) {
    return c.json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(
      c.req.raw,
      'ai-test-upstream.public',
      aiProxyRequestBodyMaxBytes(c)
    );
  } catch {
    return c.json({ error: 'BAD_REQUEST', message: 'A JSON object body is required' }, 400);
  }
  const path = new URL(c.req.url).pathname.slice(MOUNT_PATH.length) || '/';
  return buildFakeUpstreamResponse(path, body, await resolveAiTestUpstreamCostPerCallUsd(c.env));
});

export { MOUNT_PATH as AI_TEST_UPSTREAM_MOUNT_PATH,aiTestUpstreamRoutes };
