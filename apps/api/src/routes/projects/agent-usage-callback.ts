import { Hono } from 'hono';
import { DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { RequestBodyTooLargeError, readRequestJsonWithSchema } from '../../lib/runtime-validation';
import { parsePositiveInt } from '../../lib/route-helpers';
import { AcpSessionUsageReportSchema } from '../../schemas';
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

agentUsageCallbackRoute.post('/:id/acp-sessions/:sessionId/usage', async (c) => {
  const maxBodyBytes = parsePositiveInt(
    c.env.CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES,
    DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES
  );
  let body: AcpUsageCallbackReport;
  try {
    body = (await readRequestJsonWithSchema(
      AcpSessionUsageReportSchema,
      c.req.raw,
      'acp_usage.callback',
      maxBodyBytes
    )) as AcpUsageCallbackReport;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json(
        {
          error: 'PAYLOAD_TOO_LARGE',
          message: `Usage callback request body exceeds ${error.maxBytes} bytes`,
        },
        413
      );
    }
    return c.json({ error: 'BAD_REQUEST', message: 'Invalid usage callback request body' }, 400);
  }
  return handleAcpUsageCallback(c, {
    projectId: c.req.param('id'),
    sessionId: c.req.param('sessionId'),
    body,
  });
});

export { agentUsageCallbackRoute };
