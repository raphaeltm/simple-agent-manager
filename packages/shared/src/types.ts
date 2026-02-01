// =============================================================================
// User
// =============================================================================
export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Credential
// =============================================================================
export type CredentialProvider = 'hetzner';

export interface Credential {
  id: string;
  userId: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  createdAt: string;
  updatedAt: string;
}

/** API response (safe to expose - no encrypted data) */
export interface CredentialResponse {
  id: string;
  provider: CredentialProvider;
  connected: boolean;
  createdAt: string;
}

export interface CreateCredentialRequest {
  provider: CredentialProvider;
  token: string;
}

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

// =============================================================================
// Workspace
// =============================================================================
export type WorkspaceStatus =
  | 'pending'
  | 'creating'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export type VMSize = 'small' | 'medium' | 'large';

export type VMLocation = 'nbg1' | 'fsn1' | 'hel1';

export interface Workspace {
  id: string;
  userId: string;
  installationId: string | null;
  name: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  hetznerServerId: string | null;
  vmIp: string | null;
  dnsRecordId: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  shutdownDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

/** API response (includes computed URL) */
export interface WorkspaceResponse {
  id: string;
  name: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  vmIp: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  shutdownDeadline: string | null;
  createdAt: string;
  updatedAt: string;
  url?: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  repository: string;
  branch?: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  installationId: string;
}

// =============================================================================
// Heartbeat
// =============================================================================
export interface HeartbeatRequest {
  workspaceId?: string;
  idleSeconds: number;
  idle: boolean;
  lastActivityAt: string;
  hasActivity?: boolean; // If there was activity since last heartbeat
}

export interface HeartbeatResponse {
  action: 'continue' | 'shutdown';
  idleSeconds: number;
  maxIdleSeconds: number;
  shutdownDeadline: string | null;
}

// =============================================================================
// Terminal
// =============================================================================
export interface TerminalTokenRequest {
  workspaceId: string;
}

export interface TerminalTokenResponse {
  token: string;
  expiresAt: string;
  workspaceUrl?: string;
}

// =============================================================================
// Bootstrap Token (Secure Credential Delivery)
// =============================================================================

/** Internal: Bootstrap token data stored in KV */
export interface BootstrapTokenData {
  workspaceId: string;
  encryptedHetznerToken: string;
  hetznerTokenIv: string;
  callbackToken: string;
  encryptedGithubToken: string | null;
  githubTokenIv: string | null;
  createdAt: string;
}

/** API response when VM redeems bootstrap token */
export interface BootstrapResponse {
  workspaceId: string;
  hetznerToken: string;
  callbackToken: string;
  githubToken: string | null;
  controlPlaneUrl: string;
}

// =============================================================================
// API Error
// =============================================================================
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
