import type { AgentSession } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toAgentSessionResponse } from '../../lib/mappers';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { CreateAgentSessionSchema, jsonValidator, UpdateAgentSessionSchema } from '../../schemas';
import { getRuntimeLimits } from '../../services/limits';
import { buildSessionMcpServers } from '../../services/mcp-connection-resolution';
import { generateMcpToken, revokeMcpToken, storeMcpToken } from '../../services/mcp-token';
import { createAgentSessionOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
import { isSleepingContainerNode } from '../../services/sleeping-container-runtime';
import { requireRepositoryOwnerAccess } from '../projects/_helpers';
import {
  assertNodeOperational,
  getOwnedAgentSession,
  getOwnedNode,
  getOwnedNodeAgentSession,
  getOwnedWorkspace,
} from './_helpers';

const agentSessionRoutes = new Hono<{ Bindings: Env }>();

async function requireWorkspaceAgentGitHubAccess(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspace: schema.Workspace,
  userId: string
): Promise<void> {
  if (!workspace.projectId) return;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, workspace.projectId), eq(schema.projects.userId, userId)))
    .limit(1);
  if (!project) {
    throw errors.notFound('Project');
  }
  await requireRepositoryOwnerAccess(env, db, project, userId, 'workspace-agent-session');
}

// Auth applied per-route (NOT via use('/*', ...)) to prevent middleware leakage
// to other subrouters (lifecycle, runtime) mounted at the same base path.
// See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md

agentSessionRoutes.get('/:id/agent-sessions', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    return c.json([] as AgentSession[]);
  }

  const sessions = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt));

  return c.json(sessions.map(toAgentSessionResponse));
});

agentSessionRoutes.post(
  '/:id/agent-sessions',
  requireAuth(),
  requireApproved(),
  jsonValidator(CreateAgentSessionSchema),
  async (c) => {
    const userId = getUserId(c);
    const workspaceId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');
    const limits = getRuntimeLimits(c.env);

    const workspace = await getOwnedWorkspace(db, workspaceId, userId);
    if (!workspace.nodeId) {
      throw errors.badRequest('Workspace is not attached to a node');
    }

    const node = await getOwnedNode(db, workspace.nodeId, userId);
    assertNodeOperational(node, 'create agent session');
    await requireWorkspaceAgentGitHubAccess(c.env, db, workspace, userId);

    const existingRunning = await db
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.workspaceId, workspace.id),
          eq(schema.agentSessions.userId, userId),
          eq(schema.agentSessions.status, 'running')
        )
      );

    if (existingRunning.length >= limits.maxAgentSessionsPerWorkspace) {
      throw errors.badRequest(
        `Maximum ${limits.maxAgentSessionsPerWorkspace} agent sessions per workspace`
      );
    }

    const sessionId = ulid();
    const now = new Date().toISOString();

    await db.insert(schema.agentSessions).values({
      id: sessionId,
      workspaceId: workspace.id,
      userId,
      status: 'running',
      label: body.label?.trim() || null,
      agentType: body.agentType?.trim() || null,
      worktreePath: body.worktreePath?.trim() || null,
      createdAt: now,
      updatedAt: now,
    });

    let mcpToken: string | null = null;
    try {
      if (workspace.projectId) {
        mcpToken = generateMcpToken();
        await storeMcpToken(
          c.env.KV,
          mcpToken,
          {
            // Empty taskId for direct project-chat sessions — only task-runner dispatched
            // sessions have a real task row. Setting sessionId as taskId was wrong because
            // MCP tools query tasks by this ID and would get "Task not found". Empty string
            // is falsy so tools guarding on !tokenData.taskId correctly reject early.
            taskId: '',
            contextType: workspace.chatSessionId ? 'conversation' : 'direct-workspace',
            taskMode: workspace.chatSessionId ? 'conversation' : undefined,
            projectId: workspace.projectId,
            userId,
            workspaceId: workspace.id,
            chatSessionId: workspace.chatSessionId ?? undefined,
            agentSessionId: sessionId,
            createdAt: new Date().toISOString(),
          },
          c.env
        );
      }

      // Manual workspace sessions are a separate producer from the shared bootstrap, so the
      // MCP server list has to be built here too — otherwise a user's connections would work
      // in project chat but silently vanish on a workspace-created session (rule 61).
      const mcpServers = mcpToken
        ? await buildSessionMcpServers(
            db,
            {
              baseDomain: c.env.BASE_DOMAIN,
              encryptionKey: getCredentialEncryptionKey(c.env),
            },
            { userId, projectId: workspace.projectId },
            mcpToken
          )
        : undefined;

      await createAgentSessionOnNode(
        workspace.nodeId,
        workspace.id,
        sessionId,
        body.label?.trim() || null,
        c.env,
        userId,
        workspace.chatSessionId,
        workspace.projectId,
        mcpServers
      );
    } catch (err) {
      if (mcpToken) {
        await revokeMcpToken(c.env.KV, mcpToken).catch((revokeErr) => {
          log.warn('agent_session.mcp_token_revoke_failed', {
            sessionId,
            workspaceId: workspace.id,
            error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
          });
        });
      }

      await db
        .update(schema.agentSessions)
        .set({
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Failed to create agent session',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agentSessions.id, sessionId));

      throw errors.internal('Failed to create agent session on node');
    }

    const rows = await db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .limit(1);

    const createdSession = rows[0];
    if (!createdSession) {
      throw new Error(`Agent session ${sessionId} disappeared immediately after creation`);
    }

    return c.json(toAgentSessionResponse(createdSession), 201);
  }
);

agentSessionRoutes.patch(
  '/:id/agent-sessions/:sessionId',
  requireAuth(),
  requireApproved(),
  jsonValidator(UpdateAgentSessionSchema),
  async (c) => {
    const userId = getUserId(c);
    const workspaceId = c.req.param('id');
    const sessionId = c.req.param('sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    const workspace = await getOwnedWorkspace(db, workspaceId, userId);

    const body = c.req.valid('json');
    const maxLabelLength = parsePositiveInt(c.env.MAX_AGENT_SESSION_LABEL_LENGTH, 50);
    const label = body.label?.trim()?.slice(0, maxLabelLength);
    if (!label) {
      throw errors.badRequest('Label is required and must be non-empty');
    }

    const session = await getOwnedAgentSession(db, workspace.id, sessionId, userId);
    if (session.status !== 'running') {
      throw errors.badRequest('Cannot rename a session that is not running');
    }

    await db
      .update(schema.agentSessions)
      .set({
        label,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, session.id));

    return c.json(
      toAgentSessionResponse({ ...session, label, updatedAt: new Date().toISOString() })
    );
  }
);

agentSessionRoutes.post(
  '/:id/agent-sessions/:sessionId/stop',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const { workspace, session } = await getOwnedNodeAgentSession(
      db,
      c.req.param('id'),
      c.req.param('sessionId'),
      userId
    );
    const running = session.status === 'running';

    // A session that is not running may still be an orphan whose process is alive, so it gets
    // the stop too. A slept Instant runtime runs nothing, and the request would restore it just
    // to stop it.
    if (!(await isSleepingContainerNode(db, workspace.nodeId))) {
      try {
        await stopAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
      } catch (e) {
        log.error(
          running ? 'agent_session.stop_on_node_failed' : 'agent_session.orphaned_stop_failed',
          {
            sessionId: session.id,
            workspaceId: workspace.id,
            nodeId: workspace.nodeId,
            error: String(e),
          }
        );
      }
    }
    if (!running) {
      return c.json({ status: session.status });
    }

    const now = new Date().toISOString();
    await db
      .update(schema.agentSessions)
      .set({ status: 'stopped', stoppedAt: now, errorMessage: null, updatedAt: now })
      .where(eq(schema.agentSessions.id, session.id));

    return c.json({ status: 'stopped' });
  }
);

export { agentSessionRoutes };
