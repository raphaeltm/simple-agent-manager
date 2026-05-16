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
