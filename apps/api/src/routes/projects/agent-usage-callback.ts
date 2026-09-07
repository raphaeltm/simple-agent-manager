import { Hono } from 'hono';

import type { Env } from '../../env';
import { AcpSessionUsageReportSchema, jsonValidator } from '../../schemas';
import {
  type AcpUsageCallbackReport,
  handleAcpUsageCallback,
} from '../../services/acp-usage-callback-handler';

/**
 * Agent usage callback route — mounted BEFORE projectsRoutes in index.ts
 * because it authenticates callback JWTs, not browser session cookies.
 *
 * The VM agent reports provider quota observations here. The handler verifies
 * the callback token and binds usage to the credential reference that the
 * server stored for the actual agent session.
 */
const agentUsageCallbackRoute = new Hono<{ Bindings: Env }>();

agentUsageCallbackRoute.post(
  '/:id/acp-sessions/:sessionId/usage',
  jsonValidator(AcpSessionUsageReportSchema),
  (c) =>
    handleAcpUsageCallback(c, {
      projectId: c.req.param('id'),
      sessionId: c.req.param('sessionId'),
      body: c.req.valid('json') as AcpUsageCallbackReport,
    })
);

export { agentUsageCallbackRoute };
