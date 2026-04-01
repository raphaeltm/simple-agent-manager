// =============================================================================
// User
// =============================================================================
export type UserRole = 'superadmin' | 'admin' | 'user';
export type UserStatus = 'active' | 'pending' | 'suspended';

export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Admin User Management
// =============================================================================
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface AdminUserActionRequest {
  action: 'approve' | 'suspend';
}

export interface AdminUserRoleRequest {
  role: Exclude<UserRole, 'superadmin'>;
}

// =============================================================================
// Credential
// =============================================================================
export const CREDENTIAL_PROVIDERS = ['hetzner', 'scaleway', 'gcp'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

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

/**
 * Create credential request — discriminated by provider.
 * Hetzner uses a single API token; Scaleway requires secretKey + projectId.
 */
export type CreateCredentialRequest =
  | { provider: 'hetzner'; token: string }
  | { provider: 'scaleway'; secretKey: string; projectId: string }
  | { provider: 'gcp'; gcpProjectId: string; gcpProjectNumber: string; serviceAccountEmail: string; wifPoolId: string; wifProviderId: string; defaultZone: string };

// =============================================================================
// GCP OIDC Credential (stored after Connect GCP flow)
// =============================================================================

/** GCP OIDC credential — public identifiers, not secrets. Stored encrypted for consistency. */
export interface GcpOidcCredential {
  provider: 'gcp';
  gcpProjectId: string;
  gcpProjectNumber: string;
  serviceAccountEmail: string;
  wifPoolId: string;
  wifProviderId: string;
  defaultZone: string;
}

// =============================================================================
// Project Deployment Credentials (GCP OIDC for Defang deployments)
// =============================================================================

/** Project-scoped deployment credential config (non-secret identifiers) */
export interface ProjectDeploymentCredential {
  id: string;
  projectId: string;
  userId: string;
  provider: 'gcp';
  gcpProjectId: string;
  gcpProjectNumber: string;
  serviceAccountEmail: string;
  wifPoolId: string;
  wifProviderId: string;
  createdAt: string;
  updatedAt: string;
}

/** API response for project deployment credential (safe to expose) */
export interface ProjectDeploymentCredentialResponse {
  provider: 'gcp';
  gcpProjectId: string;
  serviceAccountEmail: string;
  connected: boolean;
  createdAt: string;
}

/** Request to set up GCP deployment for a project */
export interface SetupProjectDeploymentRequest {
  oauthHandle: string;
  gcpProjectId: string;
}
