import { Hono } from 'hono';

import type { Env } from '../../env';
import { AcpSessionActivityReportSchema, jsonValidator } from '../../schemas';
import type { AcpActivityCallbackReport } from '../../services/acp-activity-admission';
import { handleAcpActivityCallback } from '../../services/acp-activity-callback-handler';

/**
 * Agent activity callback route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline by the handler.
 * Accepts workspace-scoped and node-scoped callback tokens.
 *
 * The VM agent calls this endpoint from session_host_reporting.go:reportActivity()
 * to signal "prompting" / "idle" / "recovering" / "error" transitions.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const agentActivityCallbackRoute = new Hono<{ Bindings: Env }>();

agentActivityCallbackRoute.post(
  '/:id/acp-sessions/:sessionId/activity',
  jsonValidator(AcpSessionActivityReportSchema),
  (c) =>
    handleAcpActivityCallback(c, {
      projectId: c.req.param('id'),
      sessionId: c.req.param('sessionId'),
      body: c.req.valid('json') as AcpActivityCallbackReport,
    })
);

export { agentActivityCallbackRoute };
