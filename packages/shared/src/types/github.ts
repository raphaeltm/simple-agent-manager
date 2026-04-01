// =============================================================================
// GitHub Installation
// =============================================================================
export type AccountType = 'personal' | 'organization';

export interface GitHubInstallation {
  id: string;
  userId: string;
  installationId: string;
  accountType: AccountType;
  accountName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
}

export interface RepositoryListResponse {
  repositories: Repository[];
  /** Names of installations whose repo fetch failed (e.g. expired or revoked) */
  failedInstallations?: string[];
}

export interface Branch {
  name: string;
  isDefault: boolean;
}

/** GitHub repository returned from GitHub API */
export interface GitHubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** GitHub installation token */
export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  repositories: string[];
  permissions: {
    contents?: string;
  };
}

/** GitHub connection status */
export interface GitHubConnection {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  installedAt: string;
  repositories: string[];
  status: 'active' | 'suspended' | 'pending';
  lastTokenAt: string | null;
}
