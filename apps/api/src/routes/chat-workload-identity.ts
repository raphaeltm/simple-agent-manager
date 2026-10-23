import type { Hono } from 'hono';

import type { Env } from '../env';
import { getWorkloadIdentityMetadata } from '../services/workload-identity-context';
import { getChatSessionRouteContext } from './chat-route-context';

/** Read-only identity preview: never signs or returns a bearer token. */
export function registerChatWorkloadIdentityRoute(routes: Hono<{ Bindings: Env }>): void {
  routes.get('/:sessionId/workload-identity', async (c) => {
    const { projectId, sessionId } = await getChatSessionRouteContext(c);
    c.header('Cache-Control', 'no-store');
    return c.json(await getWorkloadIdentityMetadata(c.env, projectId, sessionId));
  });
}
