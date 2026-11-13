export type GitHubInstallationReference = {
  installationId: string;
  externalInstallationId?: string | null;
};

export function getExternalInstallationId(installation: GitHubInstallationReference): string {
  return installation.externalInstallationId || installation.installationId;
}

export function getStoredInstallationId(userId: string, externalInstallationId: string): string {
  return `${userId}:${externalInstallationId}`;
}
