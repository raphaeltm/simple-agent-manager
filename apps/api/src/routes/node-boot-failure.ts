import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import {
  nodeStatusTerminatesCallbacks,
  verifyNodeCallbackAuth,
} from '../services/node-callback-auth';

export const NODE_BOOT_FAILURE_PREFIX = 'Node boot failed: ';
const BootFailureSchema = v.object({
  reason: v.picklist(['origin_ca_bootstrap', 'vm_agent_download']),
});

// Callback-only router: mounted before the session-auth node router.
export const nodeBootFailureRoutes = new Hono<{ Bindings: Env }>();
nodeBootFailureRoutes.post('/:id/boot-failure', jsonValidator(BootFailureSchema), async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId, { requireExplicitScope: true });
  const node = await c.env.DATABASE.prepare(
    'SELECT status, node_class, runtime FROM nodes WHERE id = ?'
  )
    .bind(nodeId)
    .first<{ status: string; node_class: string; runtime: string }>();
  if (!node || nodeStatusTerminatesCallbacks(node.status))
    throw errors.gone('Node callback resource is gone');
  if (node.node_class !== 'managed' || node.runtime !== 'vm')
    throw errors.forbidden('Boot reports require a managed VM');
  const { reason } = c.req.valid('json');
  const result = await c.env.DATABASE.prepare(
    `UPDATE nodes SET health_status = 'unhealthy', error_message = ?, updated_at = ?
     WHERE id = ? AND node_class = 'managed' AND runtime = 'vm'
       AND status IN ('creating', 'running') AND agent_ready_at IS NULL AND last_heartbeat_at IS NULL`
  )
    .bind(`${NODE_BOOT_FAILURE_PREFIX}${reason}`, new Date().toISOString(), nodeId)
    .run();
  if (result.meta.changes) log.warn('node.boot_failure', { nodeId, reason });
  return c.json({ accepted: (result.meta.changes ?? 0) > 0 });
});
