import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { requireAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { encrypt, decrypt } from '../services/encryption';
import { createServer, deleteServer, SERVER_TYPES } from '../services/hetzner';
import { deleteDNSRecord, cleanupWorkspaceDNSRecords, createBackendDNSRecord, getWorkspaceUrl } from '../services/dns';
import { getInstallationToken } from '../services/github-app';
import { generateBootstrapToken, storeBootstrapToken } from '../services/bootstrap';
import { signCallbackToken, verifyCallbackToken } from '../services/jwt';
import { generateCloudInit, validateCloudInitSize } from '@workspace/cloud-init';
import * as schema from '../db/schema';
import type {
  WorkspaceResponse,
  CreateWorkspaceRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  BootstrapTokenData,
} from '@simple-agent-manager/shared';
import { MAX_WORKSPACES_PER_USER, HETZNER_IMAGE, isValidAgentType } from '@simple-agent-manager/shared';
import { getDecryptedAgentKey } from './credentials';

/**
 * Get idle timeout in seconds from environment.
 * Default: 30 minutes (1800 seconds)
 * Configurable via IDLE_TIMEOUT_SECONDS env var per constitution principle XI.
 */
function getIdleTimeoutSeconds(env: Env): number {
  const envValue = env.IDLE_TIMEOUT_SECONDS;
  return envValue ? parseInt(envValue, 10) : 30 * 60;
}

const workspacesRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes except VM Agent callbacks
workspacesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  // Skip session auth for VM Agent callback endpoints (they use JWT Bearer auth)
  if (
    path.endsWith('/ready') ||
    path.endsWith('/heartbeat') ||
    path.endsWith('/agent-key') ||
    path.endsWith('/git-token')
  ) {
    return next();
  }
  return requireAuth()(c, next);
});

/**
 * GET /api/workspaces - List user's workspaces
 */
workspacesRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const status = c.req.query('status');
  const db = drizzle(c.env.DATABASE, { schema });

  const query = db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId))
    .orderBy(desc(schema.workspaces.createdAt));

  const workspaces = await query;

  // Filter by status if provided
  const filtered = status
    ? workspaces.filter((w) => w.status === status)
    : workspaces;

  const response: WorkspaceResponse[] = filtered.map((ws) => ({
    id: ws.id,
    name: ws.name,
    repository: ws.repository,
    branch: ws.branch,
    status: ws.status as any,
    vmSize: ws.vmSize as any,
    vmLocation: ws.vmLocation as any,
    vmIp: ws.vmIp,
    lastActivityAt: ws.lastActivityAt,
    errorMessage: ws.errorMessage,
    shutdownDeadline: ws.shutdownDeadline,
    idleTimeoutSeconds: ws.idleTimeoutSeconds,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    url: ws.vmIp ? getWorkspaceUrl(ws.id, c.env.BASE_DOMAIN) : undefined,
  }));

  return c.json(response);
});

/**
 * GET /api/workspaces/:id - Get single workspace
 */
workspacesRoutes.get('/:id', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  const ws = workspaces[0];
  if (!ws) {
    throw errors.notFound('Workspace');
  }

  const response: WorkspaceResponse = {
    id: ws.id,
    name: ws.name,
    repository: ws.repository,
    branch: ws.branch,
    status: ws.status as any,
    vmSize: ws.vmSize as any,
    vmLocation: ws.vmLocation as any,
    vmIp: ws.vmIp,
    lastActivityAt: ws.lastActivityAt,
    errorMessage: ws.errorMessage,
    shutdownDeadline: ws.shutdownDeadline,
    idleTimeoutSeconds: ws.idleTimeoutSeconds,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    url: ws.vmIp ? getWorkspaceUrl(ws.id, c.env.BASE_DOMAIN) : undefined,
  };

  return c.json(response);
});

/**
 * POST /api/workspaces - Create a new workspace
 */
workspacesRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<CreateWorkspaceRequest>();
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Validate request
  if (!body.name || !body.repository || !body.installationId) {
    throw errors.badRequest('Name, repository, and installationId are required');
  }

  // Check workspace limit
  const existingWorkspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId));

  if (existingWorkspaces.length >= MAX_WORKSPACES_PER_USER) {
    throw errors.badRequest(`Maximum ${MAX_WORKSPACES_PER_USER} workspaces allowed`);
  }

  // Get Hetzner credential
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  const cred = creds[0];
  if (!cred) {
    throw errors.badRequest('Hetzner account not connected');
  }

  const hetznerToken = await decrypt(cred.encryptedToken, cred.iv, c.env.ENCRYPTION_KEY);

  // Get GitHub installation
  const installations = await db
    .select()
    .from(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, body.installationId),
        eq(schema.githubInstallations.userId, userId)
      )
    )
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    throw errors.badRequest('GitHub installation not found');
  }

  // Create workspace record
  const workspaceId = ulid();
  const vmSize = body.vmSize || 'medium';
  const vmLocation = body.vmLocation || 'nbg1';
  const branch = body.branch || 'main';

  // Validate idle timeout (5 minutes to 24 hours)
  const idleTimeoutSeconds = body.idleTimeoutSeconds ?? getIdleTimeoutSeconds(c.env);
  if (idleTimeoutSeconds !== 0 && (idleTimeoutSeconds < 300 || idleTimeoutSeconds > 86400)) {
    throw errors.badRequest('Idle timeout must be between 5 minutes and 24 hours, or 0 to disable');
  }

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    userId,
    installationId: body.installationId,
    name: body.name,
    repository: body.repository,
    branch,
    status: 'creating',
    vmSize,
    vmLocation,
    idleTimeoutSeconds,
    createdAt: now,
    updatedAt: now,
  });

  // Start provisioning in background
  c.executionCtx.waitUntil(
    provisionWorkspace(
      workspaceId,
      {
        name: body.name,
        repository: body.repository,
        branch,
        vmSize,
        vmLocation,
        installationId: installation.installationId,
        idleTimeoutSeconds,
      },
      hetznerToken,
      { encryptedToken: cred.encryptedToken, iv: cred.iv },
      c.env,
      db
    )
  );

  const response: WorkspaceResponse = {
    id: workspaceId,
    name: body.name,
    repository: body.repository,
    branch,
    status: 'creating',
    vmSize: vmSize as any,
    vmLocation: vmLocation as any,
    vmIp: null,
    lastActivityAt: null,
    errorMessage: null,
    shutdownDeadline: null,
    idleTimeoutSeconds,
    createdAt: now,
    updatedAt: now,
  };

  return c.json(response, 201);
});

/**
 * POST /api/workspaces/:id/stop - Stop a workspace
 */
workspacesRoutes.post('/:id/stop', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  const workspace = workspaces[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (workspace.status !== 'running') {
    throw errors.badRequest('Workspace is not running');
  }

  // Update status
  await db
    .update(schema.workspaces)
    .set({ status: 'stopping', updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  // Get Hetzner token and stop server
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  const credStop = creds[0];
  if (credStop && workspace.hetznerServerId) {
    const hetznerToken = await decrypt(credStop.encryptedToken, credStop.iv, c.env.ENCRYPTION_KEY);

    c.executionCtx.waitUntil(
      (async () => {
        try {
          await deleteServer(hetznerToken, workspace.hetznerServerId!);
          if (workspace.dnsRecordId) {
            await deleteDNSRecord(workspace.dnsRecordId, c.env);
          }
          // Always clean up any stale DNS records by name as a fallback.
          // This handles cases where dnsRecordId was lost or a record was
          // created by old code that didn't store the ID properly.
          await cleanupWorkspaceDNSRecords(workspaceId, c.env);
          await db
            .update(schema.workspaces)
            .set({
              status: 'stopped',
              hetznerServerId: null,
              vmIp: null,
              dnsRecordId: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));
        } catch (err) {
          console.error('Failed to stop workspace:', err);
          await db
            .update(schema.workspaces)
            .set({
              status: 'error',
              errorMessage: err instanceof Error ? err.message : 'Failed to stop workspace',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));
        }
      })()
    );
  }

  return c.json({ status: 'stopping' });
});

/**
 * POST /api/workspaces/:id/restart - Restart a stopped workspace
 */
workspacesRoutes.post('/:id/restart', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  const workspaceRestart = workspaces[0];
  if (!workspaceRestart) {
    throw errors.notFound('Workspace');
  }

  if (workspaceRestart.status !== 'stopped') {
    throw errors.badRequest('Workspace is not stopped');
  }

  // Get Hetzner credential
  const credsRestart = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  const credRestart = credsRestart[0];
  if (!credRestart) {
    throw errors.badRequest('Hetzner account not connected');
  }

  const hetznerToken = await decrypt(credRestart.encryptedToken, credRestart.iv, c.env.ENCRYPTION_KEY);

  // Get GitHub installation
  const installationsRestart = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspaceRestart.installationId!))
    .limit(1);

  const installRestart = installationsRestart[0];
  if (!installRestart) {
    throw errors.badRequest('GitHub installation not found');
  }

  // Update status
  await db
    .update(schema.workspaces)
    .set({ status: 'creating', updatedAt: new Date().toISOString() })
    .where(eq(schema.workspaces.id, workspaceId));

  // Start provisioning
  c.executionCtx.waitUntil(
    provisionWorkspace(
      workspaceId,
      {
        name: workspaceRestart.name,
        repository: workspaceRestart.repository,
        branch: workspaceRestart.branch,
        vmSize: workspaceRestart.vmSize,
        vmLocation: workspaceRestart.vmLocation,
        installationId: installRestart.installationId,
        idleTimeoutSeconds: workspaceRestart.idleTimeoutSeconds,
      },
      hetznerToken,
      { encryptedToken: credRestart.encryptedToken, iv: credRestart.iv },
      c.env,
      db
    )
  );

  return c.json({ status: 'creating' });
});

/**
 * DELETE /api/workspaces/:id - Delete a workspace
 */
workspacesRoutes.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  const workspaceDelete = workspaces[0];
  if (!workspaceDelete) {
    throw errors.notFound('Workspace');
  }

  // Cleanup resources if they exist
  if (workspaceDelete.hetznerServerId) {
    const credsDelete = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'hetzner')
        )
      )
      .limit(1);

    const credDelete = credsDelete[0];
    if (credDelete) {
      const hetznerToken = await decrypt(credDelete.encryptedToken, credDelete.iv, c.env.ENCRYPTION_KEY);
      try {
        await deleteServer(hetznerToken, workspaceDelete.hetznerServerId);
      } catch (err) {
        console.error('Failed to delete server:', err);
      }
    }
  }

  if (workspaceDelete.dnsRecordId) {
    try {
      await deleteDNSRecord(workspaceDelete.dnsRecordId, c.env);
    } catch (err) {
      console.error('Failed to delete DNS record:', err);
    }
  }
  // Always clean up any stale DNS records by name as a fallback
  try {
    await cleanupWorkspaceDNSRecords(workspaceId, c.env);
  } catch (err) {
    console.error('Failed to cleanup DNS records by name:', err);
  }

  // Delete workspace record
  await db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));

  return c.json({ success: true });
});

/**
 * POST /api/workspaces/:id/ready - VM callback when workspace is ready
 * Requires valid callback token in Authorization header.
 */
workspacesRoutes.post('/:id/ready', async (c) => {
  const workspaceId = c.req.param('id');

  // Validate callback token from Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyCallbackToken(token, c.env);
    // Verify the token is for this specific workspace
    if (payload.workspace !== workspaceId) {
      throw errors.forbidden('Token workspace mismatch');
    }
  } catch (err) {
    throw errors.unauthorized(err instanceof Error ? err.message : 'Invalid callback token');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Only transition to running if workspace is in 'creating' state.
  // If the workspace is already 'stopping' or 'stopped' (e.g., after idle shutdown),
  // the VM agent may have been restarted by systemd and is calling /ready again.
  // We must NOT reset lastActivityAt or status in that case, as it would create
  // an infinite shutdown/restart loop.
  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const ws = workspaces[0];
  if (!ws) {
    throw errors.notFound('Workspace');
  }

  if (ws.status === 'stopping' || ws.status === 'stopped') {
    console.log(`Ignoring /ready callback for workspace ${workspaceId} in '${ws.status}' state (agent restart after idle shutdown)`);
    return c.json({ success: false, reason: 'workspace_shutting_down' });
  }

  await db
    .update(schema.workspaces)
    .set({
      status: 'running',
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(eq(schema.workspaces.id, workspaceId));

  return c.json({ success: true });
});

/**
 * POST /api/workspaces/:id/heartbeat - VM heartbeat for idle detection
 * Requires valid callback token in Authorization header.
 *
 * NOTE: The VM Agent manages its own idle timeout locally and will self-terminate.
 * This endpoint provides visibility and allows the control plane to track workspace status,
 * but does NOT extend the VM's lifetime. The Go agent uses IDLE_TIMEOUT env var (default 30min).
 */
workspacesRoutes.post('/:id/heartbeat', async (c) => {
  const workspaceId = c.req.param('id');

  // Validate callback token from Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyCallbackToken(token, c.env);
    // Verify the token is for this specific workspace
    if (payload.workspace !== workspaceId) {
      throw errors.forbidden('Token workspace mismatch');
    }
  } catch (err) {
    throw errors.unauthorized(err instanceof Error ? err.message : 'Invalid callback token');
  }

  const body = await c.req.json<HeartbeatRequest>();
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();
  const globalIdleTimeoutSeconds = getIdleTimeoutSeconds(c.env);

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const wsHeartbeat = workspaces[0];
  if (!wsHeartbeat) {
    throw errors.notFound('Workspace');
  }

  // Use per-workspace idle timeout if set, otherwise fall back to global default
  const idleTimeoutSeconds = wsHeartbeat.idleTimeoutSeconds ?? globalIdleTimeoutSeconds;

  // Use the VM's reported lastActivityAt (authoritative) to update the control plane's view.
  // The VM agent tracks actual user input activity locally and reports it here.
  if (body.lastActivityAt) {
    await db
      .update(schema.workspaces)
      .set({
        lastActivityAt: body.lastActivityAt,
        shutdownDeadline: body.shutdownDeadline ?? null,
        updatedAt: now,
      })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  // Use VM-reported idle time (authoritative) for the response
  const idleSeconds = body.idleSeconds ?? 0;
  const shouldShutdown = idleSeconds >= idleTimeoutSeconds;

  // Use VM-reported deadline, or compute a fallback
  const shutdownDeadline = body.shutdownDeadline
    ?? new Date(Date.now() + Math.max(0, idleTimeoutSeconds - idleSeconds) * 1000).toISOString();

  // Heartbeat-based shutdown fallback: if the VM reports it's idle past the
  // deadline and the workspace is still "running", the control plane initiates
  // deletion directly. This is a safety net for when the VM's own
  // /request-shutdown call fails (network issues, auth errors, etc.).
  if (shouldShutdown && wsHeartbeat.status === 'running') {
    console.log(`Heartbeat fallback: workspace ${workspaceId} idle for ${idleSeconds}s (limit ${idleTimeoutSeconds}s), initiating deletion`);

    await db
      .update(schema.workspaces)
      .set({ status: 'stopping', updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspaceId));

    const creds = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, wsHeartbeat.userId),
          eq(schema.credentials.provider, 'hetzner')
        )
      )
      .limit(1);

    const cred = creds[0];
    if (cred && wsHeartbeat.hetznerServerId) {
      const hetznerToken = await decrypt(cred.encryptedToken, cred.iv, c.env.ENCRYPTION_KEY);

      c.executionCtx.waitUntil(
        (async () => {
          try {
            await deleteServer(hetznerToken, wsHeartbeat.hetznerServerId!);
            if (wsHeartbeat.dnsRecordId) {
              await deleteDNSRecord(wsHeartbeat.dnsRecordId, c.env);
            }
            await cleanupWorkspaceDNSRecords(workspaceId, c.env);
            await db
              .update(schema.workspaces)
              .set({
                status: 'stopped',
                hetznerServerId: null,
                vmIp: null,
                dnsRecordId: null,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.workspaces.id, workspaceId));
            console.log(`Heartbeat fallback: successfully deleted idle VM ${workspaceId}`);
          } catch (err) {
            console.error(`Heartbeat fallback: failed to delete VM ${workspaceId}:`, err);
            await db
              .update(schema.workspaces)
              .set({
                status: 'error',
                errorMessage: err instanceof Error ? err.message : 'Failed to delete VM via heartbeat fallback',
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.workspaces.id, workspaceId));
          }
        })()
      );
    }
  }

  const response: HeartbeatResponse = {
    action: shouldShutdown ? 'shutdown' : 'continue',
    idleSeconds: Math.floor(idleSeconds),
    maxIdleSeconds: idleTimeoutSeconds,
    shutdownDeadline,
  };

  return c.json(response);
});

/**
 * POST /api/workspaces/:id/request-shutdown - VM requests its own deletion
 * Internal endpoint called by VM Agent when idle timeout is reached.
 * Requires callback JWT auth. This allows VMs to clean themselves up
 * without having direct access to Hetzner credentials.
 */
workspacesRoutes.post('/:id/request-shutdown', async (c) => {
  const workspaceId = c.req.param('id');

  // Validate callback token from Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyCallbackToken(token, c.env);
    if (payload.workspace !== workspaceId) {
      throw errors.forbidden('Token workspace mismatch');
    }
  } catch (err) {
    throw errors.unauthorized(err instanceof Error ? err.message : 'Invalid callback token');
  }

  const body = await c.req.json<{ reason: string }>();
  const reason = body.reason || 'idle_timeout';

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Get workspace
  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaces[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (workspace.status !== 'running') {
    // Already stopping or stopped
    return c.json({ status: workspace.status });
  }

  // Update status to stopping
  await db
    .update(schema.workspaces)
    .set({
      status: 'stopping',
      updatedAt: now,
      // Record the reason for shutdown in lastActivityAt for now
      // (Could add a separate field in the future)
    })
    .where(eq(schema.workspaces.id, workspaceId));

  // Get user's Hetzner credentials
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, workspace.userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  const cred = creds[0];
  if (cred && workspace.hetznerServerId) {
    const hetznerToken = await decrypt(cred.encryptedToken, cred.iv, c.env.ENCRYPTION_KEY);

    // Delete server and clean up DNS asynchronously
    c.executionCtx.waitUntil(
      (async () => {
        try {
          console.log(`VM ${workspaceId} requested self-deletion due to: ${reason}`);

          // Delete Hetzner server
          await deleteServer(hetznerToken, workspace.hetznerServerId!);

          // Clean up DNS records
          if (workspace.dnsRecordId) {
            await deleteDNSRecord(workspace.dnsRecordId, c.env);
          }
          await cleanupWorkspaceDNSRecords(workspaceId, c.env);

          // Update status to stopped
          await db
            .update(schema.workspaces)
            .set({
              status: 'stopped',
              hetznerServerId: null,
              vmIp: null,
              dnsRecordId: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));

          console.log(`Successfully deleted idle VM ${workspaceId}`);
        } catch (err) {
          console.error('Failed to delete VM on idle shutdown:', err);
          await db
            .update(schema.workspaces)
            .set({
              status: 'error',
              errorMessage: err instanceof Error ? err.message : 'Failed to delete VM',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspaceId));
        }
      })()
    );
  }

  return c.json({ status: 'stopping', reason });
});

/**
 * POST /api/workspaces/:id/agent-key - Fetch a decrypted agent API key
 * Internal endpoint called by VM Agent. Requires callback JWT auth.
 * The control plane decrypts the key (it holds ENCRYPTION_KEY) and returns it
 * over HTTPS. The decrypted key MUST NOT be logged (SC-006).
 */
workspacesRoutes.post('/:id/agent-key', async (c) => {
  const workspaceId = c.req.param('id');

  // Validate callback token from Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyCallbackToken(token, c.env);
    if (payload.workspace !== workspaceId) {
      throw errors.forbidden('Token workspace mismatch');
    }
  } catch (err) {
    throw errors.unauthorized(err instanceof Error ? err.message : 'Invalid callback token');
  }

  const body = await c.req.json<{ agentType: string }>();

  if (!body.agentType || !isValidAgentType(body.agentType)) {
    throw errors.badRequest('Valid agentType is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  // Find the workspace owner
  const workspaces = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const ws = workspaces[0];
  if (!ws) {
    throw errors.notFound('Workspace');
  }

  // Decrypt the agent API key for the workspace owner
  const apiKey = await getDecryptedAgentKey(
    db,
    ws.userId,
    body.agentType,
    c.env.ENCRYPTION_KEY
  );

  if (!apiKey) {
    throw errors.notFound('Agent credential');
  }

  return c.json({ apiKey });
});

/**
 * POST /api/workspaces/:id/git-token - Fetch a fresh GitHub installation token
 * Internal endpoint called by VM Agent credential helper flow.
 * Requires callback JWT auth.
 */
workspacesRoutes.post('/:id/git-token', async (c) => {
  const workspaceId = c.req.param('id');

  // Validate callback token from Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyCallbackToken(token, c.env);
    if (payload.workspace !== workspaceId) {
      throw errors.forbidden('Token workspace mismatch');
    }
  } catch (err) {
    throw errors.unauthorized(err instanceof Error ? err.message : 'Invalid callback token');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaces = await db
    .select({ installationId: schema.workspaces.installationId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaces[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }
  if (!workspace.installationId) {
    throw errors.badRequest('Workspace is not linked to a GitHub installation');
  }

  const installations = await db
    .select({ installationId: schema.githubInstallations.installationId })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspace.installationId))
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    throw errors.notFound('GitHub installation');
  }

  const { token: gitToken, expiresAt } = await getInstallationToken(installation.installationId, c.env);

  return c.json({ token: gitToken, expiresAt });
});

/**
 * Provision a workspace (create VM, DNS, etc.)
 * Uses bootstrap tokens for secure credential delivery - no secrets in cloud-init.
 */
async function provisionWorkspace(
  workspaceId: string,
  config: {
    name: string;
    repository: string;
    branch: string;
    vmSize: string;
    vmLocation: string;
    installationId: string;
    idleTimeoutSeconds: number;
  },
  hetznerToken: string,
  hetznerCredential: { encryptedToken: string; iv: string },
  env: Env,
  db: ReturnType<typeof drizzle>
): Promise<void> {
  const now = () => new Date().toISOString();

  try {
    // Get GitHub installation token for cloning
    const { token: githubToken } = await getInstallationToken(config.installationId, env);

    // Encrypt the GitHub token for storage
    const { ciphertext: encGithub, iv: ivGithub } = await encrypt(githubToken, env.ENCRYPTION_KEY);

    // Generate callback token for VM-to-API authentication
    const callbackToken = await signCallbackToken(workspaceId, env);

    // Generate bootstrap token and store encrypted credentials
    const bootstrapToken = generateBootstrapToken();
    const bootstrapData: BootstrapTokenData = {
      workspaceId,
      encryptedHetznerToken: hetznerCredential.encryptedToken,
      hetznerTokenIv: hetznerCredential.iv,
      callbackToken,
      encryptedGithubToken: encGithub,
      githubTokenIv: ivGithub,
      createdAt: now(),
    };

    await storeBootstrapToken(env.KV, bootstrapToken, bootstrapData);

    // Generate cloud-init config (NO SECRETS - only bootstrap token)
    // Use workspace-specific timeout or 0 to disable
    const cloudInit = generateCloudInit({
      workspaceId,
      hostname: `ws-${workspaceId}`,
      repository: config.repository,
      branch: config.branch,
      controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
      jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
      bootstrapToken,
      idleTimeout: config.idleTimeoutSeconds === 0 ? '0' : `${config.idleTimeoutSeconds}s`, // Format as duration string for Go's time.ParseDuration
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    // Create Hetzner server
    const server = await createServer(hetznerToken, {
      name: `ws-${workspaceId}`,
      serverType: SERVER_TYPES[config.vmSize] || 'cx33',
      location: config.vmLocation,
      image: HETZNER_IMAGE,
      userData: cloudInit,
      labels: {
        workspace: workspaceId,
        managed: 'simple-agent-manager',
      },
    });

    // Create a DNS-only (non-proxied) A record for the VM backend.
    // Cloudflare Workers cannot fetch IP addresses directly (Error 1003),
    // so the Worker proxy uses vm-{id}.{domain} to reach the VM.
    let dnsRecordId: string | null = null;
    try {
      dnsRecordId = await createBackendDNSRecord(workspaceId, server.publicNet.ipv4.ip, env);
    } catch (dnsErr) {
      console.error('Failed to create backend DNS record:', dnsErr);
      // Continue — the workspace can still be reached via /ready callback
    }

    // Update workspace with server info
    await db
      .update(schema.workspaces)
      .set({
        hetznerServerId: String(server.id),
        vmIp: server.publicNet.ipv4.ip,
        dnsRecordId,
        updatedAt: now(),
      })
      .where(eq(schema.workspaces.id, workspaceId));

    // VM agent will redeem bootstrap token on startup, then call /ready endpoint
  } catch (err) {
    console.error('Provisioning failed:', err);
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Provisioning failed',
        updatedAt: now(),
      })
      .where(eq(schema.workspaces.id, workspaceId));
  }
}

export { workspacesRoutes };
