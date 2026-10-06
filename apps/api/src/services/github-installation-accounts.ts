import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

export type GitHubDb = ReturnType<typeof drizzle<typeof schema>>;
export type GitHubInstallationAccountRow = typeof schema.githubInstallationAccounts.$inferSelect;

export type CanonicalInstallationAccountInput = {
  installationId: string;
  accountType: 'personal' | 'organization';
  accountName: string;
};

export async function upsertCanonicalInstallationAccount(
  db: GitHubDb,
  account: CanonicalInstallationAccountInput,
  now: string
): Promise<void> {
  await db
    .insert(schema.githubInstallationAccounts)
    .values({
      installationId: account.installationId,
      accountType: account.accountType,
      accountName: account.accountName,
      accountNameNormalized: normalizeAccountName(account.accountName),
      createdAt: now,
      updatedAt: now,
      uninstalledAt: null,
    })
    .onConflictDoUpdate({
      target: schema.githubInstallationAccounts.installationId,
      set: {
        accountType: account.accountType,
        accountName: account.accountName,
        accountNameNormalized: normalizeAccountName(account.accountName),
        updatedAt: now,
        uninstalledAt: null,
      },
    });
}

export async function tombstoneCanonicalInstallationAccount(
  db: GitHubDb,
  account: CanonicalInstallationAccountInput,
  now: string
): Promise<void> {
  await db
    .insert(schema.githubInstallationAccounts)
    .values({
      installationId: account.installationId,
      accountType: account.accountType,
      accountName: account.accountName,
      accountNameNormalized: normalizeAccountName(account.accountName),
      createdAt: now,
      updatedAt: now,
      uninstalledAt: now,
    })
    .onConflictDoUpdate({
      target: schema.githubInstallationAccounts.installationId,
      set: {
        accountType: account.accountType,
        accountName: account.accountName,
        accountNameNormalized: normalizeAccountName(account.accountName),
        updatedAt: now,
        uninstalledAt: now,
      },
    });
}

export function getCanonicalAccountInput(
  installationId: string,
  accountType: unknown,
  accountName: unknown
): CanonicalInstallationAccountInput {
  return {
    installationId,
    accountType: normalizeAccountType(accountType),
    accountName: typeof accountName === 'string' ? accountName : '',
  };
}

export function normalizeAccountType(accountType: unknown): 'personal' | 'organization' {
  return typeof accountType === 'string' && accountType.toLowerCase() === 'organization'
    ? 'organization'
    : 'personal';
}

export function normalizeAccountName(accountName: string): string {
  return accountName.toLowerCase();
}

/**
 * Determine whether a GitHub *personal* installation's account identity belongs to
 * a given owner. Shared by the OAuth/sync discovery path (github.ts) and the
 * webhook `installation.created` path (github-webhook.ts) so the two cannot
 * silently diverge.
 *
 * Comparison prefers the immutable numeric account id; falls back to a
 * case-insensitive login comparison only when an id is unavailable on either
 * side. Fails closed (returns false) when ownership cannot be established.
 *
 * Callers MUST first confirm the installation is personal (org installs are
 * owned at the org level, not by the installing user).
 */
export function personalInstallationOwnerMatches(
  account: { id?: number | null; login?: string | null },
  owner: { id?: number | null; login?: string | null }
): boolean {
  if (typeof account.id === 'number' && typeof owner.id === 'number') {
    // Real GitHub account ids are positive. Reject 0 / negatives so a zeroed or
    // sentinel id on both sides can't be read as a match (0 === 0).
    return account.id > 0 && owner.id > 0 && account.id === owner.id;
  }
  if (
    typeof account.login === 'string' &&
    account.login.length > 0 &&
    typeof owner.login === 'string' &&
    owner.login.length > 0
  ) {
    return account.login.toLowerCase() === owner.login.toLowerCase();
  }
  return false;
}
