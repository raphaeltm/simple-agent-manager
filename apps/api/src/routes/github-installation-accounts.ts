import { and,eq,inArray,sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import {
  getAuthenticatedUserOrganizations,
  getUserAccessibleInstallations,
  type UserAccessibleInstallation,
  verifyUserInstallationAccess,
} from '../services/github-app';

export type GitHubDb = ReturnType<typeof drizzle<typeof schema>>;
export type GitHubInstallationAccountRow = typeof schema.githubInstallationAccounts.$inferSelect;

interface InstallationAccountInput {
  installationId: string;
  accountType: string;
  accountName: string;
  now: string;
}

interface UserInstallationLinkInput extends InstallationAccountInput {
  userId: string;
}

export async function upsertCanonicalInstallationAccount(
  db: GitHubDb,
  input: InstallationAccountInput
): Promise<void> {
  const accountType = getCanonicalAccountType(input.accountType);
  await db
    .insert(schema.githubInstallationAccounts)
    .values({
      installationId: input.installationId,
      accountType,
      accountName: input.accountName,
      normalizedAccountName: input.accountName.toLowerCase(),
      uninstalledAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.githubInstallationAccounts.installationId,
      set: {
        accountType,
        accountName: input.accountName,
        normalizedAccountName: input.accountName.toLowerCase(),
        uninstalledAt: null,
        updatedAt: input.now,
      },
    });
}

export async function tombstoneCanonicalInstallationAccount(
  db: GitHubDb,
  installationId: string,
  now: string
): Promise<void> {
  await db
    .update(schema.githubInstallationAccounts)
    .set({
      uninstalledAt: now,
      updatedAt: now,
    })
    .where(eq(schema.githubInstallationAccounts.installationId, installationId));
}

export async function insertUserInstallationLink(
  db: GitHubDb,
  input: UserInstallationLinkInput
): Promise<void> {
  await db.insert(schema.githubInstallations).values({
    id: ulid(),
    userId: input.userId,
    installationId: input.installationId,
    accountType: getCanonicalAccountType(input.accountType),
    accountName: input.accountName,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function getCanonicalAccountType(accountType: unknown): 'organization' | 'personal' {
  return accountType === 'Organization' || accountType === 'organization' ? 'organization' : 'personal';
}

/**
 * Sync GitHub App installations for a user.
 *
 * Fetches installations in user context, then creates any missing per-user
 * records for installations the authenticated GitHub account can access.
 */
export async function syncUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  await syncDirectUserInstallations(db, userId, accessToken);
  await syncSharedOrgInstallations(db, userId, accessToken);
}

async function syncDirectUserInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  try {
    log.info('github.installations_sync.token_status', { userId, tokenPresent: Boolean(accessToken) });

    // User-context GitHub verification: only sync installations the
    // authenticated GitHub user can access.
    const accessibleInstallations = await getUserAccessibleInstallations(accessToken, {
      flow: 'sync',
      userId,
    });
    log.info('github.installations_sync.accessible_installations', {
      userId,
      installationCount: accessibleInstallations.length,
      installations: summarizeAccessibleInstallations(accessibleInstallations),
    });
    if (accessibleInstallations.length === 0) return;

    const existingRecords = await db
      .select({ installationId: schema.githubInstallations.installationId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, userId));

    const existingInstallationIds = new Set(existingRecords.map((r) => r.installationId));

    const missingInstallations = accessibleInstallations.filter(
      (inst) => !existingInstallationIds.has(String(inst.id))
    );

    log.info('github.installations_sync.missing_installations', {
      userId,
      missingInstallationCount: missingInstallations.length,
      installations: summarizeAccessibleInstallations(missingInstallations),
    });

    const now = new Date().toISOString();
    for (const inst of accessibleInstallations) {
      await upsertCanonicalInstallationAccount(db, {
        installationId: String(inst.id),
        accountType: getCanonicalAccountType(inst.account.type),
        accountName: inst.account.login,
        now,
      });
    }

    if (missingInstallations.length === 0) return;

    for (const inst of missingInstallations) {
      try {
        await insertUserInstallationLink(db, {
          userId,
          installationId: String(inst.id),
          accountType: getCanonicalAccountType(inst.account.type),
          accountName: inst.account.login,
          now,
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

async function syncSharedOrgInstallations(
  db: GitHubDb,
  userId: string,
  accessToken: string
): Promise<void> {
  try {
    const organizations = await getAuthenticatedUserOrganizations(accessToken, {
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

    await insertVerifiedSharedInstallations(db, userId, accessToken, candidates);
  } catch (err) {
    log.error('github.shared_org_installations.failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getExistingInstallationIds(
  db: GitHubDb,
  userId: string
): Promise<Set<string>> {
  const existingRecords = await db
    .select({ installationId: schema.githubInstallations.installationId })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.userId, userId));

  return new Set(existingRecords.map((record) => record.installationId));
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
        sql`${schema.githubInstallationAccounts.uninstalledAt} IS NULL`,
        inArray(schema.githubInstallationAccounts.normalizedAccountName, normalizedOrgLogins)
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
  candidates: GitHubInstallationAccountRow[]
): Promise<void> {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    try {
      const canAccess = await verifyUserInstallationAccess(accessToken, candidate.installationId, {
        flow: 'shared-org-discovery',
        userId,
        installationId: candidate.installationId,
        accountName: candidate.accountName,
      });
      if (!canAccess) {
        log.warn('github.shared_org_installations.verification_skipped', {
          userId,
          installationId: candidate.installationId,
          accountName: candidate.accountName,
          reason: 'not_accessible_to_user',
        });
        continue;
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
  }
}

async function insertSharedInstallation(
  db: GitHubDb,
  userId: string,
  candidate: GitHubInstallationAccountRow,
  now: string
): Promise<void> {
  try {
    await insertUserInstallationLink(db, {
      userId,
      installationId: candidate.installationId,
      accountType: 'organization',
      accountName: candidate.accountName,
      now,
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

export function summarizeAccessibleInstallations(installations: UserAccessibleInstallation[]): Array<{
  installationId: string;
  accountName: string;
  accountType: string;
}> {
  return installations.map((inst) => ({
    installationId: String(inst.id),
    accountName: inst.account.login,
    accountType: inst.account.type,
  }));
}

function summarizeInstallationRows(
  installations: Array<{ installationId: string; accountName: string }>
): Array<{
  installationId: string;
  accountName: string;
}> {
  return installations.map((inst) => ({
    installationId: inst.installationId,
    accountName: inst.accountName,
  }));
}

export function isDatabaseConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique|already exists|conflict/i.test(message);
}
