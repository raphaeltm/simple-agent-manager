import type {CreatedProjectInviteLinkResponse, ProjectInvitePreviewResponse, ProjectMemberResponse, ProjectMemberRole, ProjectMembersResponse, ProjectMemberStatus} from '@simple-agent-manager/shared';
import {and, eq, sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/d1';
import {Hono} from 'hono';

import * as schema from '../../db/schema';
import type {Env} from '../../env';

import {ulid} from '../../lib/ulid';
import {getUserId, rejectAgentSignInSession} from '../../middleware/auth';
import {errors} from '../../middleware/error';
import {requireProjectAccess, requireProjectCapability} from '../../middleware/project-auth';
import {CreateProjectInviteSchema, DecideProjectAccessRequestSchema, jsonValidator} from '../../schemas';




import {inviteMembershipStatus, resolveConcurrentAccessRequest, resolveConcurrentRequestInsert} from '../../services/project-access-request-reentry';

import {projectMemberOffboardingRoutes} from './member-offboarding';
import {projectOwnershipTransferRoutes} from './ownership-transfer';

import { clearProjectMemberDerivedCaches, parsePositiveEnvInt, addDays, generateInviteToken, hmacInviteToken, inviteStatus, toUser, toInviteLinkResponse, toAccessRequestResponse, evaluateRequesterGithubAccess, loadProjectInviteByToken, loadAccessRequestWithUser } from './member-invite-helpers';

const DEFAULT_INVITE_TOKEN_BYTES = 32;
const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const DEFAULT_INVITE_MAX_EXPIRY_DAYS = 30;

const projectMembersRoutes = new Hono<{ Bindings: Env }>();
projectMembersRoutes.route('/', projectOwnershipTransferRoutes);
projectMembersRoutes.route('/', projectMemberOffboardingRoutes);

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
    members: memberRows.map((row): ProjectMemberResponse => ({
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
    })),
    inviteLinks: inviteRows.map(toInviteLinkResponse),
    accessRequests: requestRows.map(toAccessRequestResponse),
  };

  return c.json(response);
});

projectMembersRoutes.post(
  '/:id/invite-links',
  // An invite grants lasting access to whoever redeems it.
  rejectAgentSignInSession(),
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
    clearProjectMemberDerivedCaches(projectId);

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
  clearProjectMemberDerivedCaches(projectId);
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
  clearProjectMemberDerivedCaches(project.id);

  return c.json(await loadAccessRequestWithUser(db, project.id, requestId), existing ? 200 : 201);
});

projectMembersRoutes.post(
  '/:id/access-requests/:requestId/approve',
  rejectAgentSignInSession(),
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
    clearProjectMemberDerivedCaches(project.id);

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
    clearProjectMemberDerivedCaches(project.id);
    return c.json(await loadAccessRequestWithUser(db, project.id, requestId));
  }
);

export { projectMembersRoutes };
