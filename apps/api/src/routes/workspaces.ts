import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Env } from '../index';
import { requireAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { decrypt } from '../services/encryption';
import { createServer, deleteServer, SERVER_TYPES } from '../services/hetzner';
import { createDNSRecord, deleteDNSRecord, getWorkspaceUrl } from '../services/dns';
import { getInstallationToken } from '../services/github-app';
import { generateCloudInit, validateCloudInitSize } from '@workspace/cloud-init';
import * as schema from '../db/schema';
import type {
  WorkspaceResponse,
  CreateWorkspaceRequest,
  HeartbeatRequest,
  HeartbeatResponse,
} from '@cloud-ai-workspaces/shared';
import { MAX_WORKSPACES_PER_USER, IDLE_TIMEOUT_SECONDS, HETZNER_IMAGE } from '@cloud-ai-workspaces/shared';

const workspacesRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes except callbacks
workspacesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  // Skip auth for callback endpoints
  if (path.endsWith('/ready') || path.endsWith('/heartbeat')) {
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

  let query = db
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
      },
      hetznerToken,
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
      },
      hetznerToken,
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

  // Delete workspace record
  await db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));

  return c.json({ success: true });
});

/**
 * POST /api/workspaces/:id/ready - VM callback when workspace is ready
 */
workspacesRoutes.post('/:id/ready', async (c) => {
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

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
 */
workspacesRoutes.post('/:id/heartbeat', async (c) => {
  const workspaceId = c.req.param('id');
  const body = await c.req.json<HeartbeatRequest>();
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const wsHeartbeat = workspaces[0];
  if (!wsHeartbeat) {
    throw errors.notFound('Workspace');
  }

  // Update last activity if there's activity
  if (body.hasActivity) {
    await db
      .update(schema.workspaces)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  // Check if idle timeout reached
  const lastActivity = wsHeartbeat.lastActivityAt
    ? new Date(wsHeartbeat.lastActivityAt)
    : new Date(wsHeartbeat.createdAt);
  const idleSeconds = (Date.now() - lastActivity.getTime()) / 1000;
  const shouldShutdown = idleSeconds >= IDLE_TIMEOUT_SECONDS;

  const response: HeartbeatResponse = {
    action: shouldShutdown ? 'shutdown' : 'continue',
    idleSeconds: Math.floor(idleSeconds),
    maxIdleSeconds: IDLE_TIMEOUT_SECONDS,
  };

  return c.json(response);
});

/**
 * Provision a workspace (create VM, DNS, etc.)
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
  },
  hetznerToken: string,
  env: Env,
  db: ReturnType<typeof drizzle>
): Promise<void> {
  const now = () => new Date().toISOString();

  try {
    // Get GitHub installation token for cloning
    const { token: githubToken } = await getInstallationToken(config.installationId, env);

    // Generate cloud-init config
    const cloudInit = generateCloudInit({
      workspaceId,
      hostname: `ws-${workspaceId}`,
      repository: config.repository,
      branch: config.branch,
      githubToken,
      controlPlaneUrl: `https://api.${env.BASE_DOMAIN}`,
      jwksUrl: `https://api.${env.BASE_DOMAIN}/.well-known/jwks.json`,
      callbackToken: 'callback-token', // TODO: Generate secure callback token
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    // Create Hetzner server
    const server = await createServer(hetznerToken, {
      name: `ws-${workspaceId}`,
      serverType: SERVER_TYPES[config.vmSize] || 'cx32',
      location: config.vmLocation,
      image: HETZNER_IMAGE,
      userData: cloudInit,
      labels: {
        workspace: workspaceId,
        managed: 'cloud-ai-workspaces',
      },
    });

    // Update workspace with server info
    await db
      .update(schema.workspaces)
      .set({
        hetznerServerId: String(server.id),
        vmIp: server.publicNet.ipv4.ip,
        updatedAt: now(),
      })
      .where(eq(schema.workspaces.id, workspaceId));

    // Create DNS record
    const dnsRecordId = await createDNSRecord(workspaceId, server.publicNet.ipv4.ip, env);

    await db
      .update(schema.workspaces)
      .set({
        dnsRecordId,
        updatedAt: now(),
      })
      .where(eq(schema.workspaces.id, workspaceId));

    // VM will call /ready endpoint when fully provisioned
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
