import type { UserAccessibleInstallation } from './github-app';
import type { GitHubInstallationAccountRow } from './github-installation-accounts';

export function summarizeAccessibleInstallations(
  installations: UserAccessibleInstallation[]
): Array<{
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

export function summarizeInstallationRows(
  installations: GitHubInstallationAccountRow[]
): Array<{
  installationId: string;
  accountName: string;
}> {
  return installations.map((inst) => ({
    installationId: inst.installationId,
    accountName: inst.accountName,
  }));
}

export function getTokenType(token: unknown): string | null {
  if (!token || typeof token !== 'object' || !('tokenType' in token)) {
    return null;
  }
  const tokenType = token.tokenType;
  return typeof tokenType === 'string' ? tokenType : null;
}

export function isDatabaseConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique|already exists|conflict/i.test(message);
}
