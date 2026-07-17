import type {
  CreatedProjectInviteLinkResponse,
  ProjectAccessRequestResponse,
  ProjectInviteGithubAccessStatus,
  ProjectInviteLinkResponse,
  ProjectInviteLinkStatus,
  ProjectInvitePreviewResponse,
  ProjectMemberResponse,
  ProjectMemberRole,
  ProjectMembersResponse,
  ProjectMemberStatus,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../../middleware/project-auth';
import {
  ApplyProjectMemberOffboardingSchema,
  CreateProjectInviteSchema,
  DecideProjectAccessRequestSchema,
  jsonValidator,
} from '../../schemas';
import { getUserInstallationRepositories } from '../../services/github-app';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import {
  getGitHubUserAccessTokenForOwner,
  getGitHubUserAccessTokenWithHeaders,
} from '../../services/github-user-access-token';
import {
  inviteMembershipStatus,
  resolveConcurrentAccessRequest,
  resolveConcurrentRequestInsert,
} from '../../services/project-access-request-reentry';
import { applyProjectMemberOffboarding } from '../../services/project-offboarding-apply';
import { createProjectMemberOffboardingPreview } from '../../services/project-offboarding-preview';
import { projectOwnershipTransferRoutes } from './ownership-transfer';

const INVITE_TOKEN_PREFIX = 'sam_inv_';
const DEFAULT_INVITE_TOKEN_BYTES = 32;
const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const DEFAULT_INVITE_MAX_EXPIRY_DAYS = 30;

const projectMembersRoutes = new Hono<{ Bindings: Env }>();
projectMembersRoutes.route('/', projectOwnershipTransferRoutes);

function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function addDays(now: Date, days: number): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function generateInviteToken(tokenBytes: number): string {
  const bytes = new Uint8Array(tokenBytes);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  const base64url = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${INVITE_TOKEN_PREFIX}${base64url}`;
}

async function hmacInviteToken(rawToken: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function inviteStatus(row: schema.ProjectInviteLink, now = new Date()): ProjectInviteLinkStatus {
  if (row.revokedAt) return 'revoked';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function toUser(row: {
  id: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
  avatarUrl: string | null;
}): ProjectMemberResponse['user'] {
  if (!row.id) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    avatarUrl: row.avatarUrl,
  };
}

function toInviteLinkResponse(row: schema.ProjectInviteLink): ProjectInviteLinkResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    status: inviteStatus(row),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
  };
}

function toAccessRequestResponse(row: {
  request: schema.ProjectAccessRequest;
  userId: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
  avatarUrl: string | null;
}): ProjectAccessRequestResponse {
  return {
    id: row.request.id,
    projectId: row.request.projectId,
    inviteLinkId: row.request.inviteLinkId,
    requesterUserId: row.request.requesterUserId,
    status: row.request.status as ProjectAccessRequestResponse['status'],
    githubAccessStatus: row.request
      .githubAccessStatus as ProjectAccessRequestResponse['githubAccessStatus'],
    githubAccessCheckedAt: row.request.githubAccessCheckedAt,
    githubAccessMessage: row.request.githubAccessMessage,
    requestedAt: row.request.requestedAt,
    decidedAt: row.request.decidedAt,
    decidedBy: row.request.decidedBy,
    decisionNote: row.request.decisionNote,
    createdAt: row.request.createdAt,
    updatedAt: row.request.updatedAt,
    requester: toUser({
      id: row.userId,
      name: row.name,
      email: row.email,
      image: row.image,
      avatarUrl: row.avatarUrl,
    }),
  };
}

async function getProjectInstallation(
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project
): Promise<schema.GitHubInstallation> {
  const rows = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, project.installationId))
    .limit(1);
  const installation = rows[0];
  if (!installation) {
    throw errors.notFound('Installation');
  }
  return installation;
}

async function evaluateRequesterGithubAccess(input: {
  env: Env;
  headers: Headers;
  db: ReturnType<typeof drizzle<typeof schema>>;
  project: schema.Project;
  requesterUserId: string;
  currentRequestUserId?: string;
}): Promise<{
  status: ProjectInviteGithubAccessStatus;
  checkedAt: string;
  message: string | null;
}> {
  const checkedAt = new Date().toISOString();
  if (input.project.repoProvider === 'artifacts') {
    return {
      status: 'unsupported-provider',
      checkedAt,
      message: 'GitHub repository access is not required for Artifacts-backed projects.',
    };
  }
  if (input.project.repoProvider && input.project.repoProvider !== 'github') {
    return {
      status: 'unsupported-provider',
      checkedAt,
      message: 'Repository provider is not supported for invite access checks.',
    };
  }

  const accessToken =
    input.currentRequestUserId === input.requesterUserId
      ? await getGitHubUserAccessTokenWithHeaders(
          input.env,
          input.headers,
          input.requesterUserId,
          'project-invite-request'
        )
      : await getGitHubUserAccessTokenForOwner(
          input.env,
          input.requesterUserId,
          'project-invite-approval'
        );
  if (!accessToken) {
    return {
      status: 'missing-token',
      checkedAt,
      message:
        'Requester must reauthenticate with GitHub before repository access can be verified.',
    };
  }

  try {
    const installation = await getProjectInstallation(input.db, input.project);
    const externalInstallationId = getExternalInstallationId(installation);
    const repositories = await getUserInstallationRepositories(
      accessToken,
      externalInstallationId,
      {
        flow: 'project-invite',
        userId: input.requesterUserId,
        installationId: externalInstallationId,
        repository: input.project.repository,
      }
    );
    const matchedRepo = repositories.find(
      (repo) => repo.fullName.toLowerCase() === input.project.repository.toLowerCase()
    );
    if (!matchedRepo) {
      return {
        status: 'no-access',
        checkedAt,
        message: 'Requester does not have GitHub access to the project repository.',
      };
    }
    if (input.project.githubRepoId !== null && matchedRepo.id !== input.project.githubRepoId) {
      return {
        status: 'no-access',
        checkedAt,
        message: 'Requester GitHub access resolved to a different repository id.',
      };
    }
    return {
      status: 'verified',
      checkedAt,
      message: null,
    };
  } catch (err) {
    log.warn('project_invite.github_access_check_failed', {
      projectId: input.project.id,
      requesterUserId: input.requesterUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'check-failed',
      checkedAt,
      message: 'GitHub access could not be verified. Retry after GitHub connectivity is restored.',
    };
  }
}

async function loadProjectInviteByToken(
  c: { env: Env },
  token: string
): Promise<{
  db: ReturnType<typeof drizzle<typeof schema>>;
  link: schema.ProjectInviteLink;
  project: schema.Project;
}> {
  if (!token.startsWith(INVITE_TOKEN_PREFIX)) {
    throw errors.notFound('Invite link');
  }
  const db = drizzle(c.env.DATABASE, { schema });
  const tokenHash = await hmacInviteToken(token, c.env.ENCRYPTION_KEY);
  const rows = await db
    .select({ link: schema.projectInviteLinks, project: schema.projects })
    .from(schema.projectInviteLinks)
    .innerJoin(schema.projects, eq(schema.projectInviteLinks.projectId, schema.projects.id))
    .where(eq(schema.projectInviteLinks.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw errors.notFound('Invite link');
  }
  return { db, link: row.link, project: row.project };
}

async function loadAccessRequestWithUser(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  requestId: string
): Promise<ReturnType<typeof toAccessRequestResponse>> {
  const rows = await db
    .select({
      request: schema.projectAccessRequests,
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      image: schema.users.image,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.projectAccessRequests)
    .leftJoin(schema.users, eq(schema.projectAccessRequests.requesterUserId, schema.users.id))
    .where(
      and(
        eq(schema.projectAccessRequests.projectId, projectId),
        eq(schema.projectAccessRequests.id, requestId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw errors.notFound('Access request');
  }
  return toAccessRequestResponse(row);
}

projectMembersRoutes.get('/:id/members', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, userId);

  const memberRows = await db
    .select({
      member: schema.projectMembers,
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      image: schema.users.image,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.projectMembers)
    .leftJoin(schema.users, eq(schema.projectMembers.userId, schema.users.id))
    .where(eq(schema.projectMembers.projectId, projectId))
    .orderBy(schema.projectMembers.createdAt);

  const inviteRows = await db
    .select()
    .from(schema.projectInviteLinks)
    .where(eq(schema.projectInviteLinks.projectId, projectId))
    .orderBy(sql`${schema.projectInviteLinks.createdAt} desc`);

  const currentMember = memberRows.find((row) => row.member.userId === userId)?.member;
  const canManageRequests = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const requestRows = canManageRequests
    ? await db
        .select({
          request: schema.projectAccessRequests,
          userId: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          image: schema.users.image,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.projectAccessRequests)
        .leftJoin(schema.users, eq(schema.projectAccessRequests.requesterUserId, schema.users.id))
        .where(eq(schema.projectAccessRequests.projectId, projectId))
        .orderBy(sql`${schema.projectAccessRequests.requestedAt} desc`)
    : [];

  const response: ProjectMembersResponse = {
    members: memberRows.map(
      (row): ProjectMemberResponse => ({
        projectId: row.member.projectId,
        userId: row.member.userId,
        role: row.member.role as ProjectMemberRole,
        status: row.member.status as ProjectMemberStatus,
        invitedBy: row.member.invitedBy,
        createdAt: row.member.createdAt,
        updatedAt: row.member.updatedAt,
        user: toUser({
          id: row.userId,
          name: row.name,
          email: row.email,
          image: row.image,
          avatarUrl: row.avatarUrl,
        }),
      })
    ),
    inviteLinks: inviteRows.map(toInviteLinkResponse),
    accessRequests: requestRows.map(toAccessRequestResponse),
  };

  return c.json(response);
});

projectMembersRoutes.post('/:id/members/:userId/offboarding-preview', async (c) => {
  const requesterId = getUserId(c);
  const projectId = c.req.param('id');
  const memberUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectCapability(db, projectId, requesterId, 'member:manage');

  const preview = await createProjectMemberOffboardingPreview({
    db,
    database: c.env.DATABASE,
    project,
    memberUserId,
    requestedBy: requesterId,
    defaultAgentType: c.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    planTtlSeconds: c.env.PROJECT_OFFBOARDING_PLAN_TTL_SECONDS,
  });

  return c.json(preview);
});

projectMembersRoutes.post(
  '/:id/members/:userId/offboarding-apply',
  jsonValidator(ApplyProjectMemberOffboardingSchema),
  async (c) => {
    const requesterId = getUserId(c);
    const projectId = c.req.param('id');
    const memberUserId = c.req.param('userId');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, requesterId, 'member:manage');
    const body = c.req.valid('json');

    const response = await applyProjectMemberOffboarding({
      db,
      project,
      memberUserId,
      actorUserId: requesterId,
      planId: body.planId,
      actions: body.actions,
      finalMemberStatus: body.finalMemberStatus,
      defaultAgentType: c.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    });

    return c.json(response);
  }
);

projectMembersRoutes.post(
  '/:id/invite-links',
  jsonValidator(CreateProjectInviteSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectAccess(db, projectId, userId);

    const body = c.req.valid('json');
    const maxExpiryDays = parsePositiveEnvInt(
      c.env.PROJECT_INVITE_MAX_EXPIRY_DAYS,
      DEFAULT_INVITE_MAX_EXPIRY_DAYS
    );
    const requestedExpiryDays = Math.floor(
      body.expiresInDays ??
        parsePositiveEnvInt(c.env.PROJECT_INVITE_DEFAULT_EXPIRY_DAYS, DEFAULT_INVITE_EXPIRY_DAYS)
    );
    if (requestedExpiryDays < 1 || requestedExpiryDays > maxExpiryDays) {
      throw errors.badRequest(`expiresInDays must be between 1 and ${maxExpiryDays}`);
    }

    const now = new Date();
    const rawToken = generateInviteToken(
      parsePositiveEnvInt(c.env.PROJECT_INVITE_TOKEN_BYTES, DEFAULT_INVITE_TOKEN_BYTES)
    );
    const tokenHash = await hmacInviteToken(rawToken, c.env.ENCRYPTION_KEY);
    const link = {
      id: ulid(),
      projectId,
      tokenHash,
      createdBy: userId,
      expiresAt: addDays(now, requestedExpiryDays).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
      useCount: 0,
    } satisfies schema.ProjectInviteLink;
    await db.insert(schema.projectInviteLinks).values(link);

    const response: CreatedProjectInviteLinkResponse = {
      ...toInviteLinkResponse(link),
      token: rawToken,
    };
    return c.json(response, 201);
  }
);

projectMembersRoutes.post('/:id/invite-links/:linkId/revoke', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const linkId = c.req.param('linkId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, userId);

  const now = new Date().toISOString();
  const rows = await db
    .update(schema.projectInviteLinks)
    .set({ revokedAt: now, revokedBy: userId, updatedAt: now })
    .where(
      and(
        eq(schema.projectInviteLinks.id, linkId),
        eq(schema.projectInviteLinks.projectId, projectId)
      )
    )
    .returning();
  const link = rows[0];
  if (!link) {
    throw errors.notFound('Invite link');
  }
  return c.json(toInviteLinkResponse(link));
});

projectMembersRoutes.get('/invite-links/:token', async (c) => {
  const userId = getUserId(c);
  const token = c.req.param('token');
  const { db, link, project } = await loadProjectInviteByToken(c, token);
  const status = inviteStatus(link);

  const memberRows = await db
    .select()
    .from(schema.projectMembers)
    .where(
      and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, userId))
    )
    .limit(1);
  const requestRows = await db
    .select({
      request: schema.projectAccessRequests,
      userId: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      image: schema.users.image,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.projectAccessRequests)
    .leftJoin(schema.users, eq(schema.projectAccessRequests.requesterUserId, schema.users.id))
    .where(
      and(
        eq(schema.projectAccessRequests.projectId, project.id),
        eq(schema.projectAccessRequests.requesterUserId, userId)
      )
    )
    .limit(1);
  const request = requestRows[0] ? toAccessRequestResponse(requestRows[0]) : null;
  const activeMembership = memberRows[0]?.status === 'active';

  const response: ProjectInvitePreviewResponse = {
    token,
    status,
    expiresAt: link.expiresAt,
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      repoProvider: project.repoProvider as ProjectInvitePreviewResponse['project']['repoProvider'],
    },
    membershipStatus: inviteMembershipStatus(activeMembership, request?.status),
    accessRequest: request,
  };
  return c.json(response);
});

projectMembersRoutes.post('/invite-links/:token/request', async (c) => {
  const userId = getUserId(c);
  const token = c.req.param('token');
  const { db, link, project } = await loadProjectInviteByToken(c, token);
  if (inviteStatus(link) !== 'active') {
    throw errors.badRequest('Invite link is expired or revoked');
  }

  const memberRows = await db
    .select()
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, project.id),
        eq(schema.projectMembers.userId, userId),
        eq(schema.projectMembers.status, 'active')
      )
    )
    .limit(1);
  if (memberRows[0]) {
    throw errors.conflict('You are already a member of this project');
  }
  const existingRows = await db
    .select()
    .from(schema.projectAccessRequests)
    .where(
      and(
        eq(schema.projectAccessRequests.projectId, project.id),
        eq(schema.projectAccessRequests.requesterUserId, userId)
      )
    )
    .limit(1);
  const existing = existingRows[0];
  const requestId = existing?.id ?? ulid();
  if (existing?.status === 'pending') {
    return c.json(await loadAccessRequestWithUser(db, project.id, existing.id));
  }

  const githubAccess = await evaluateRequesterGithubAccess({
    env: c.env,
    headers: c.req.raw.headers,
    db,
    project,
    requesterUserId: userId,
    currentRequestUserId: userId,
  });
  const now = new Date().toISOString();
  if (existing) {
    const resetRows = await db
      .update(schema.projectAccessRequests)
      .set({
        inviteLinkId: link.id,
        status: 'pending',
        githubAccessStatus: githubAccess.status,
        githubAccessCheckedAt: githubAccess.checkedAt,
        githubAccessMessage: githubAccess.message,
        requestedAt: now,
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectAccessRequests.id, existing.id),
          eq(schema.projectAccessRequests.status, existing.status)
        )
      )
      .returning({ id: schema.projectAccessRequests.id });
    if (!resetRows[0]) {
      const concurrentRequestId = await resolveConcurrentAccessRequest({
        db,
        projectId: project.id,
        requesterUserId: userId,
      });
      return c.json(await loadAccessRequestWithUser(db, project.id, concurrentRequestId));
    }
  } else {
    const insertedRows = await db
      .insert(schema.projectAccessRequests)
      .values({
        id: requestId,
        projectId: project.id,
        inviteLinkId: link.id,
        requesterUserId: userId,
        status: 'pending',
        githubAccessStatus: githubAccess.status,
        githubAccessCheckedAt: githubAccess.checkedAt,
        githubAccessMessage: githubAccess.message,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.projectAccessRequests.id });
    if (!insertedRows[0]) {
      const concurrentRequestId = await resolveConcurrentRequestInsert({
        db,
        projectId: project.id,
        requesterUserId: userId,
      });
      return c.json(await loadAccessRequestWithUser(db, project.id, concurrentRequestId));
    }
  }

  await db
    .update(schema.projectInviteLinks)
    .set({
      lastUsedAt: now,
      useCount: sql`${schema.projectInviteLinks.useCount} + 1`,
      updatedAt: now,
    })
    .where(eq(schema.projectInviteLinks.id, link.id));

  return c.json(await loadAccessRequestWithUser(db, project.id, requestId), existing ? 200 : 201);
});

projectMembersRoutes.post(
  '/:id/access-requests/:requestId/approve',
  jsonValidator(DecideProjectAccessRequestSchema),
  async (c) => {
    const approverId = getUserId(c);
    const projectId = c.req.param('id');
    const requestId = c.req.param('requestId');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, approverId, 'member:manage');
    const body = c.req.valid('json');

    const requestRows = await db
      .select()
      .from(schema.projectAccessRequests)
      .where(
        and(
          eq(schema.projectAccessRequests.projectId, project.id),
          eq(schema.projectAccessRequests.id, requestId)
        )
      )
      .limit(1);
    const request = requestRows[0];
    if (!request || request.status !== 'pending') {
      throw errors.notFound('Pending access request');
    }

    const githubAccess = await evaluateRequesterGithubAccess({
      env: c.env,
      headers: c.req.raw.headers,
      db,
      project,
      requesterUserId: request.requesterUserId,
      currentRequestUserId: approverId,
    });
    const now = new Date().toISOString();

    await db
      .insert(schema.projectMembers)
      .values({
        projectId: project.id,
        userId: request.requesterUserId,
        role: 'admin',
        status: 'active',
        invitedBy: approverId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.projectMembers.projectId, schema.projectMembers.userId],
        set: {
          role: 'admin',
          status: 'active',
          invitedBy: approverId,
          updatedAt: now,
        },
      });

    await db
      .update(schema.projectAccessRequests)
      .set({
        status: 'approved',
        githubAccessStatus: githubAccess.status,
        githubAccessCheckedAt: githubAccess.checkedAt,
        githubAccessMessage: githubAccess.message,
        decidedAt: now,
        decidedBy: approverId,
        decisionNote: body.note?.trim() || null,
        updatedAt: now,
      })
      .where(eq(schema.projectAccessRequests.id, request.id));

    return c.json(await loadAccessRequestWithUser(db, project.id, request.id));
  }
);

projectMembersRoutes.post(
  '/:id/access-requests/:requestId/deny',
  jsonValidator(DecideProjectAccessRequestSchema),
  async (c) => {
    const approverId = getUserId(c);
    const projectId = c.req.param('id');
    const requestId = c.req.param('requestId');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, approverId, 'member:manage');
    const body = c.req.valid('json');

    const now = new Date().toISOString();
    const rows = await db
      .update(schema.projectAccessRequests)
      .set({
        status: 'denied',
        decidedAt: now,
        decidedBy: approverId,
        decisionNote: body.note?.trim() || null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectAccessRequests.projectId, project.id),
          eq(schema.projectAccessRequests.id, requestId),
          eq(schema.projectAccessRequests.status, 'pending')
        )
      )
      .returning();
    if (!rows[0]) {
      throw errors.notFound('Pending access request');
    }
    return c.json(await loadAccessRequestWithUser(db, project.id, requestId));
  }
);

export { projectMembersRoutes };
