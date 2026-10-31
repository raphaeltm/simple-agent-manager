import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import {
  type AuthenticatedGitHubUser,
  getAuthenticatedUserOrganizations,
  type UserAccessibleInstallation,
  verifyUserInstallationAccess,
} from '../services/github-app';
import {
  canonicalInstallationAccountUpsert,
  getCanonicalAccountInput,
  type GitHubDb,
  type GitHubInstallationAccountRow,
  normalizeAccountType,
  personalInstallationOwnerMatches,
} from '../services/github-installation-accounts';
import {
  getExternalInstallationId,
  getStoredInstallationId,
} from '../services/github-installation-ids';
import {
  isDatabaseConflictError,
  summarizeAccessibleInstallations,
  summarizeInstallationRows,
} from '../services/github-route-helpers';
import { getGitHubUserAccessToken } from '../services/github-user-access-token';

type VerifiedInstallations = [AuthenticatedGitHubUser, UserAccessibleInstallation[]];
type GitHubIo = { callerSignal: AbortSignal; timeoutMs: number };

export async function syncUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string,
  verified: VerifiedInstallations,
  io: GitHubIo
): Promise<void> {
  await syncDirectUserInstallations(db, userId, accessToken, verified);
  io.callerSignal.throwIfAborted();
  await syncSharedOrgInstallations(db, userId, accessToken, io);
}

export async function getRequiredGitHubUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string> {
  const accessToken = await getGitHubUserAccessToken(c, userId);
  log.info('github.user_context_required.token_status', {
    userId,
    tokenPresent: Boolean(accessToken),
  });
  if (!accessToken) {
    throw errors.forbidden('GitHub user token unavailable');
  }
  return accessToken;
}

export async function filterVisibleInstallations(
  db: GitHubDb,
  userId: string,
  installations: schema.GitHubInstallation[],
  verified: VerifiedInstallations
): Promise<schema.GitHubInstallation[]> {
  const personalRows = installations.filter(
    (inst) => normalizeAccountType(inst.accountType) === 'personal'
  );
  if (personalRows.length === 0) {
    return installations;
  }

  const [authenticatedGitHubUser, accessibleInstallations] = verified;
  const accessibleById = new Map(
    accessibleInstallations.map((installation) => [String(installation.id), installation])
  );

  const visible: schema.GitHubInstallation[] = [];
  for (const installation of installations) {
    if (normalizeAccountType(installation.accountType) !== 'personal') {
      visible.push(installation);
      continue;
    }

    const externalInstallationId = getExternalInstallationId(installation);
    const accessibleInstallation = accessibleById.get(externalInstallationId);
    if (
      accessibleInstallation &&
      isAuthenticatedUsersPersonalInstallation(accessibleInstallation, authenticatedGitHubUser)
    ) {
      visible.push(installation);
      continue;
    }

    await deleteInstallationRow(db, userId, installation.id);
    log.warn('github.installations_sync.removed_mismatched_personal_installation', {
      userId,
      installationId: externalInstallationId,
      accountName: installation.accountName,
    });
  }

  return visible;
}

export async function deleteInstallationRow(
  db: GitHubDb,
  userId: string,
  installationRowId: string
): Promise<void> {
  await db
    .delete(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, installationRowId),
        eq(schema.githubInstallations.userId, userId)
      )
    );
}

async function syncDirectUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string,
  verified: VerifiedInstallations
): Promise<void> {
  try {
    log.info('github.installations_sync.token_status', {
      userId,
      tokenPresent: Boolean(accessToken),
    });

    // User-context GitHub verification: only sync installations the
    // authenticated GitHub user can access.
    const [authenticatedGitHubUser, accessibleInstallations] = verified;
    log.info('github.installations_sync.accessible_installations', {
      userId,
      installationCount: accessibleInstallations.length,
      installations: summarizeAccessibleInstallations(accessibleInstallations),
    });
    if (accessibleInstallations.length === 0) return;

    const canonicalInstallations = accessibleInstallations.filter(
      (inst) =>
        normalizeAccountType(inst.account.type) === 'organization' ||
        isAuthenticatedUsersPersonalInstallation(inst, authenticatedGitHubUser)
    );
    const syncableInstallations = accessibleInstallations.filter((inst) =>
      isAuthenticatedUsersPersonalInstallation(inst, authenticatedGitHubUser)
    );
    const deferredOrgInstallationCount = accessibleInstallations.filter(
      (inst) => normalizeAccountType(inst.account.type) === 'organization'
    ).length;
    const rejectedPersonalInstallationCount = accessibleInstallations.filter(
      (inst) =>
        normalizeAccountType(inst.account.type) === 'personal' &&
        !isAuthenticatedUsersPersonalInstallation(inst, authenticatedGitHubUser)
    ).length;
    if (deferredOrgInstallationCount > 0) {
      log.info('github.installations_sync.deferred_org_installations', {
        userId,
        deferredInstallationCount: deferredOrgInstallationCount,
        reason: 'shared_org_discovery_required',
      });
    }
    if (rejectedPersonalInstallationCount > 0) {
      log.info('github.installations_sync.skipped_direct_installations', {
        userId,
        skippedInstallationCount: rejectedPersonalInstallationCount,
        reason: 'not_authenticated_user_personal_installation',
      });
    }
    const now = new Date().toISOString();
    const upserts = canonicalInstallations.map((inst) =>
      canonicalInstallationAccountUpsert(
        db,
        getCanonicalAccountInput(String(inst.id), inst.account.type, inst.account.login),
        now
      )
    );
    const [firstUpsert, ...remainingUpserts] = upserts;
    if (firstUpsert) await db.batch([firstUpsert, ...remainingUpserts]);

    if (syncableInstallations.length === 0) return;

    // Get user's existing installation records
    const existingRecords = await db
      .select({
        installationId: schema.githubInstallations.installationId,
        externalInstallationId: schema.githubInstallations.externalInstallationId,
      })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, userId));

    const existingInstallationIds = new Set(
      existingRecords.map((record) => getExternalInstallationId(record))
    );

    const missingInstallations = syncableInstallations.filter(
      (inst) => !existingInstallationIds.has(String(inst.id))
    );

    log.info('github.installations_sync.missing_installations', {
      userId,
      missingInstallationCount: missingInstallations.length,
      installations: summarizeAccessibleInstallations(missingInstallations),
    });

    if (missingInstallations.length === 0) return;

    for (const inst of missingInstallations) {
      try {
        const canonicalAccount = getCanonicalAccountInput(
          String(inst.id),
          inst.account.type,
          inst.account.login
        );
        await db.insert(schema.githubInstallations).values({
          id: ulid(),
          userId,
          installationId: getStoredInstallationId(userId, String(inst.id)),
          externalInstallationId: String(inst.id),
          accountType: canonicalAccount.accountType,
          accountName: canonicalAccount.accountName,
          createdAt: now,
          updatedAt: now,
        });
        log.info('github.installations_sync.insert_result', {
          userId,
          installationId: String(inst.id),
          result: 'success',
          accountName: inst.account.login,
          accountType: inst.account.type,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = isDatabaseConflictError(err) ? 'conflict' : 'error';
        const details = {
          userId,
          installationId: String(inst.id),
          result,
          accountName: inst.account.login,
          accountType: inst.account.type,
          error: message,
        };
        if (result === 'conflict') {
          log.warn('github.installations_sync.insert_result', details);
        } else {
          log.error('github.installations_sync.insert_result', details);
        }
      }
    }
  } catch (err) {
    log.error('github.sync_installations_failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function isAuthenticatedUsersPersonalInstallation(
  installation: UserAccessibleInstallation,
  authenticatedUser: AuthenticatedGitHubUser
): boolean {
  if (normalizeAccountType(installation.account.type) !== 'personal') {
    return false;
  }
  return personalInstallationOwnerMatches(installation.account, authenticatedUser);
}

async function syncSharedOrgInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string,
  io: GitHubIo
): Promise<void> {
  try {
    const organizations = await getAuthenticatedUserOrganizations(accessToken, {
      ...io,
      flow: 'shared-org-discovery',
      userId,
    });
    const orgLogins = organizations.map((org) => org.login);
    log.info('github.shared_org_installations.org_memberships', {
      userId,
      organizationCount: orgLogins.length,
      organizations: orgLogins,
    });
    if (orgLogins.length === 0) return;

    const existingInstallationIds = await getExistingInstallationIds(db, userId);
    const candidates = await getSharedOrgInstallationCandidates(
      db,
      orgLogins,
      existingInstallationIds
    );
    log.info('github.shared_org_installations.candidates', {
      userId,
      candidateCount: candidates.length,
      installations: summarizeInstallationRows(candidates),
    });

    await insertVerifiedSharedInstallations(db, userId, accessToken, candidates, io);
  } catch (err) {
    log.error('github.shared_org_installations.failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getExistingInstallationIds(db: GitHubDb, userId: string): Promise<Set<string>> {
  const existingRecords = await db
    .select({
      installationId: schema.githubInstallations.installationId,
      externalInstallationId: schema.githubInstallations.externalInstallationId,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  return new Set(existingRecords.map((record) => getExternalInstallationId(record)));
}

async function getSharedOrgInstallationCandidates(
  db: GitHubDb,
  orgLogins: string[],
  existingInstallationIds: Set<string>
): Promise<GitHubInstallationAccountRow[]> {
  const normalizedOrgLogins = orgLogins.map((login) => login.toLowerCase());
  const knownOrgInstallations = await db
    .select()
    .from(schema.githubInstallationAccounts)
    .where(
      and(
        eq(schema.githubInstallationAccounts.accountType, 'organization'),
        isNull(schema.githubInstallationAccounts.uninstalledAt),
        inArray(schema.githubInstallationAccounts.accountNameNormalized, normalizedOrgLogins)
      )
    );

  const candidates = new Map<string, GitHubInstallationAccountRow>();
  for (const installation of knownOrgInstallations) {
    if (!existingInstallationIds.has(installation.installationId)) {
      candidates.set(installation.installationId, installation);
    }
  }
  return [...candidates.values()];
}

async function insertVerifiedSharedInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string,
  candidates: GitHubInstallationAccountRow[],
  io: GitHubIo
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(
    candidates.map(async (candidate) => {
      if (io.callerSignal.aborted) return;
      try {
        const canAccess = await verifyUserInstallationAccess(
          accessToken,
          candidate.installationId,
          {
            ...io,
            flow: 'shared-org-discovery',
            userId,
            installationId: candidate.installationId,
            accountName: candidate.accountName,
          }
        );
        if (!canAccess) {
          log.warn('github.shared_org_installations.verification_skipped', {
            userId,
            installationId: candidate.installationId,
            accountName: candidate.accountName,
            reason: 'not_accessible_to_user',
          });
          return;
        }
        await insertSharedInstallation(db, userId, candidate, now);
      } catch (err) {
        log.error('github.shared_org_installations.verify_or_insert_failed', {
          userId,
          installationId: candidate.installationId,
          accountName: candidate.accountName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}

async function insertSharedInstallation(
  db: GitHubDb,
  userId: string,
  candidate: GitHubInstallationAccountRow,
  now: string
): Promise<void> {
  try {
    await db.insert(schema.githubInstallations).values({
      id: ulid(),
      userId,
      installationId: getStoredInstallationId(userId, candidate.installationId),
      externalInstallationId: candidate.installationId,
      accountType: 'organization',
      accountName: candidate.accountName,
      createdAt: now,
      updatedAt: now,
    });
    log.info('github.shared_org_installations.insert_result', {
      userId,
      installationId: candidate.installationId,
      result: 'success',
      accountName: candidate.accountName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = isDatabaseConflictError(err) ? 'conflict' : 'error';
    const details = {
      userId,
      installationId: candidate.installationId,
      result,
      accountName: candidate.accountName,
      error: message,
    };
    if (result === 'conflict') {
      log.warn('github.shared_org_installations.insert_result', details);
    } else {
      log.error('github.shared_org_installations.insert_result', details);
    }
  }
}
