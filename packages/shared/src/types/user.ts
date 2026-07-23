// =============================================================================
// User
// =============================================================================
export type UserRole = 'superadmin' | 'admin' | 'user';
// 'system' is the status of internal sentinel users (e.g. system_anonymous_trials,
// seeded by migration 0043). It is never settable via the API (the `status`
// additionalField is input:false) — only migrations write it. It is part of the
// union so middleware and admin tooling can recognize and exclude internal rows
// rather than silently coercing the value.
export type UserStatus = 'active' | 'pending' | 'suspended' | 'system';

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

export type SignupApprovalConfigSource = 'environment' | 'runtime';

export interface SignupApprovalConfig {
  requireApproval: boolean;
  source: SignupApprovalConfigSource;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SignupApprovalConfigResponse {
  config: SignupApprovalConfig;
}

export interface UpdateSignupApprovalConfigRequest {
  requireApproval: boolean;
}

// =============================================================================
// Credential
// =============================================================================
export const CREDENTIAL_PROVIDERS = ['hetzner', 'scaleway', 'gcp', 'vultr'] as const;
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
  validation?: CredentialValidationStatus;
  /** Safe provider-specific metadata. Never contains credential secrets. */
  gcp?: GcpCredentialMetadata;
}

export interface CredentialValidationStatus {
  valid: boolean;
  message: string;
  error?: string;
  status?: number;
  validationMode: 'format' | 'provider';
}

/**
 * Create credential request — discriminated by provider.
 * Hetzner and Vultr use a single API token; Scaleway requires secretKey + projectId.
 */
export type CreateCredentialRequest =
  | { provider: 'hetzner'; token: string }
  | { provider: 'vultr'; token: string }
  | { provider: 'scaleway'; secretKey: string; projectId: string }
  | {
      provider: 'gcp';
      authType?: 'workload-identity';
      gcpProjectId: string;
      gcpProjectNumber: string;
      serviceAccountEmail: string;
      wifPoolId: string;
      wifProviderId: string;
      defaultZone: string;
    };

// =============================================================================
// GCP OIDC Credential (stored after Connect GCP flow)
// =============================================================================

export const GCP_CREDENTIAL_VERSION = 1 as const;

export type GcpCredentialAuthType = 'workload-identity' | 'service-account-key';

/** GCP WIF credential — public identifiers, stored encrypted for consistency. */
export interface GcpWorkloadIdentityCredential {
  version: typeof GCP_CREDENTIAL_VERSION;
  provider: 'gcp';
  authType: 'workload-identity';
  gcpProjectId: string;
  gcpProjectNumber: string;
  serviceAccountEmail: string;
  wifPoolId: string;
  wifProviderId: string;
  defaultZone: string;
}

/** GCP service-account key credential. The private key is always encrypted at rest. */
export interface GcpServiceAccountKeyCredential {
  version: typeof GCP_CREDENTIAL_VERSION;
  provider: 'gcp';
  authType: 'service-account-key';
  gcpProjectId: string;
  serviceAccountEmail: string;
  privateKeyId: string;
  privateKey: string;
  defaultZone: string;
}

export type GcpCredential = GcpWorkloadIdentityCredential | GcpServiceAccountKeyCredential;

/** Backward-compatible name retained for existing WIF call sites. */
export type GcpOidcCredential = GcpWorkloadIdentityCredential;

/** Safe metadata returned to the browser for a connected GCP credential. */
export interface GcpCredentialMetadata {
  authType: GcpCredentialAuthType;
  gcpProjectId: string;
  serviceAccountEmail: string;
  defaultZone: string;
  privateKeyId?: string;
}

export interface SaveGcpServiceAccountCredentialRequest {
  serviceAccountJson: string;
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

// =============================================================================
// Platform Credentials (admin-managed fallback keys)
// =============================================================================

export type PlatformCredentialType = 'cloud-provider' | 'agent-api-key';
export type CredentialSource = 'user' | 'project' | 'platform';

export interface PlatformCredential {
  id: string;
  credentialType: PlatformCredentialType;
  provider: CredentialProvider | null;
  agentType: string | null;
  credentialKind: 'api-key' | 'oauth-token';
  label: string;
  isEnabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformCredentialResponse {
  id: string;
  credentialType: PlatformCredentialType;
  provider: CredentialProvider | null;
  agentType: string | null;
  credentialKind: 'api-key' | 'oauth-token';
  label: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlatformCredentialRequest {
  credentialType: PlatformCredentialType;
  provider?: CredentialProvider;
  agentType?: string;
  credentialKind?: 'api-key' | 'oauth-token';
  label: string;
  credential: string;
}

export interface UpdatePlatformCredentialRequest {
  label?: string;
  isEnabled?: boolean;
}

export interface ListPlatformCredentialsResponse {
  credentials: PlatformCredentialResponse[];
}
