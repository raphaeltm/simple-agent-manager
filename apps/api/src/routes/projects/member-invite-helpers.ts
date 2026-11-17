import type {
  ProjectAccessRequestResponse,
  ProjectInviteGithubAccessStatus,
  ProjectInviteLinkResponse,
  ProjectInviteLinkStatus,
  ProjectMemberResponse,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { clearCredentialAttributionHealthCache } from '../../services/credential-attribution-health';
import { getUserInstallationRepositories } from '../../services/github-app';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { githubUserTokenUnavailableError } from '../../services/github-token-errors';
import {
  getGitHubUserAccessTokenForOwner,
  getGitHubUserAccessTokenWithHeaders,
} from '../../services/github-user-access-token';
import { clearProjectMultiplayerStateCache } from '../../services/project-multiplayer';

const INVITE_TOKEN_PREFIX = 'sam_inv_';

export function clearProjectMemberDerivedCaches(projectId: string): void {
  clearProjectMultiplayerStateCache(projectId);
  clearCredentialAttributionHealthCache(projectId);
}
export function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function addDays(now: Date, days: number): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
export function generateInviteToken(tokenBytes: number): string {
  const bytes = new Uint8Array(tokenBytes);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  const base64url = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${INVITE_TOKEN_PREFIX}${base64url}`;
}

export async function hmacInviteToken(rawToken: string, secret: string): Promise<string> {
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
export function inviteStatus(
  row: schema.ProjectInviteLink,
  now = new Date()
): ProjectInviteLinkStatus {
  if (row.revokedAt) return 'revoked';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}
export function toUser(row: {
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
export function toInviteLinkResponse(row: schema.ProjectInviteLink): ProjectInviteLinkResponse {
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
export function toAccessRequestResponse(row: {
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
export async function evaluateRequesterGithubAccess(input: {
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

  try {
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
      const unavailable = await githubUserTokenUnavailableError(input.env, input.requesterUserId);
      return {
        status: 'missing-token',
        checkedAt,
        message:
          unavailable.error === 'GITHUB_NOT_CONNECTED'
            ? 'Requester has not connected GitHub. Connect it in Settings → GitHub before running work.'
            : 'Requester must reauthenticate with GitHub before repository access can be verified.',
      };
    }

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
export async function loadProjectInviteByToken(
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

export async function loadAccessRequestWithUser(
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
