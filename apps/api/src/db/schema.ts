// FILE SIZE EXCEPTION: Database schema — splitting creates import complexity. See .claude/rules/18-file-size-limits.md
//
// =============================================================================
// SCHEMA DOCUMENTATION
// =============================================================================
//
// Timestamp conventions:
//   - BetterAuth tables (users, sessions, accounts, verifications, agentSettings,
//     apiTokens) use `integer('...', { mode: 'timestamp_ms' })` which stores
//     millisecond-epoch integers. Drizzle auto-converts JS Date objects.
//   - All other tables use `text('...')` with `DEFAULT CURRENT_TIMESTAMP` or
//     `DEFAULT (datetime('now'))`, storing ISO-8601 strings (e.g. "2026-04-12 14:30:00").
//     These are compared as strings in SQL and parsed with `new Date()` in TypeScript.
//
// Encryption model:
//   - Fields named `encryptedToken` / `storedValue` / `storedContent` hold
//     AES-256-GCM ciphertext (base64-encoded).
//   - Fields named `iv` / `valueIv` / `contentIv` hold the initialization vector
//     (base64-encoded, 12 bytes random per encryption via Web Crypto API).
//   - Key management: ENCRYPTION_KEY env var (base64-encoded 256-bit key), with
//     optional purpose-specific overrides (PLATFORM_CREDENTIAL_ENCRYPTION_KEY, etc.).
//   - Encrypt/decrypt logic: `apps/api/src/services/encryption.ts`
//   - File-specific encryption: `apps/api/src/services/file-encryption.ts`
//
// onDelete policy rationale:
//   - 'cascade': Used when child rows are meaningless without the parent
//     (e.g. sessions without a user, tasks without a project).
//   - 'set null': Used when the child row has independent value and should
//     survive parent deletion (e.g. workspaces survive node deletion,
//     compliance runs survive exception request deletion, tasks survive
//     node deletion via autoProvisionedNodeId).
//   - No FK constraint: Used for cross-table soft references where the
//     referenced entity may not exist in D1 (e.g. chatSessionId references
//     a session in the ProjectData Durable Object, not a D1 table).
//
// Credential tables:
//   - `credentials`: Per-user credentials (BYOC model). Users provide their own
//     cloud provider tokens and agent API keys. Encrypted per-user, cascade on
//     user delete.
//   - `platformCredentials`: Admin-managed fallback credentials shared across
//     users. Used when a user lacks their own credential. No cascade on creator
//     delete (uses bare reference) since the credential serves all users.
//
// =============================================================================

import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// =============================================================================
// Users (BetterAuth compatible + custom fields)
// BetterAuth requires integer timestamps with mode: 'timestamp_ms' so that
// Drizzle converts Date objects to millisecond integers for D1 storage.
// =============================================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  image: text('image'),
  // Custom fields
  githubId: text('github_id').unique(),
  avatarUrl: text('avatar_url'),
  // User approval / invite-only mode
  role: text('role').notNull().default('user'), // 'superadmin' | 'admin' | 'user'
  status: text('status').notNull().default('active'), // 'active' | 'pending' | 'suspended'
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch() * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch() * 1000 as integer))`),
});

// =============================================================================
// Platform Settings
// =============================================================================
export const platformSettings = sqliteTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// =============================================================================
// Sessions (BetterAuth)
// =============================================================================
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    userIdIdx: index('idx_sessions_user_id').on(table.userId),
  })
);

// =============================================================================
// Accounts (BetterAuth OAuth providers)
// =============================================================================
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
  },
  (table) => ({
    userIdIdx: index('idx_accounts_user_id').on(table.userId),
  })
);

// =============================================================================
// Verifications (BetterAuth)
// =============================================================================
export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
  },
  (table) => ({
    identifierIdx: index('idx_verifications_identifier').on(table.identifier),
  })
);

// =============================================================================
// Credentials (per-user encrypted cloud provider tokens and agent API keys)
//
// BYOC (Bring-Your-Own-Cloud) model: users supply their own Hetzner/Scaleway
// tokens and agent API keys. Tokens are NEVER stored as env vars — they are
// encrypted per-user with AES-256-GCM and stored here.
//
// See also: `platformCredentials` table below for admin-managed fallback keys.
// =============================================================================
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // User deletion removes all their credentials
    /**
     * Null for user-scoped credentials (legacy, default). Set to project id for project-scoped
     * overrides — resolution picks project-scoped first, falls back to user-scoped.
     */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    credentialType: text('credential_type').notNull().default('cloud-provider'),
    /** Null for cloud-provider credentials; set to 'claude-code' | 'openai-codex' for agent keys. */
    agentType: text('agent_type'),
    credentialKind: text('credential_kind').notNull().default('api-key'), // 'api-key' | 'oauth-token'
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** AES-256-GCM ciphertext (base64). Decrypt via `services/encryption.ts:decrypt()`. */
    encryptedToken: text('encrypted_token').notNull(),
    /** AES-256-GCM initialization vector (base64, 12 bytes random per encryption). */
    iv: text('iv').notNull(),
    createdAt: text('created_at') // ISO-8601 text timestamp
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at') // ISO-8601 text timestamp
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userAgentKindUserScope: uniqueIndex('idx_credentials_user_agent_kind_user_scope')
      .on(table.userId, table.agentType, table.credentialKind)
      .where(sql`credential_type = 'agent-api-key' AND project_id IS NULL`),
    userAgentKindProjectScope: uniqueIndex('idx_credentials_user_agent_kind_project_scope')
      .on(table.userId, table.projectId, table.agentType, table.credentialKind)
      .where(sql`credential_type = 'agent-api-key' AND project_id IS NOT NULL`),
    activeCredential: index('idx_credentials_active')
      .on(table.userId, table.projectId, table.agentType, table.isActive)
      .where(sql`credential_type = 'agent-api-key' AND is_active = 1`),
  })
);

// =============================================================================
// GitHub App Installations
// =============================================================================
export const githubInstallationAccounts = sqliteTable(
  'github_installation_accounts',
  {
    installationId: text('installation_id').primaryKey(),
    accountType: text('account_type').notNull(),
    accountName: text('account_name').notNull(),
    accountNameNormalized: text('normalized_account_name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    uninstalledAt: text('uninstalled_at'),
  },
  (table) => ({
    activeLookupIdx: index('idx_github_installation_accounts_lookup')
      .on(table.accountType, table.accountNameNormalized)
      .where(sql`uninstalled_at IS NULL`),
  })
);

// Per-user SAM links to GitHub App installations. Account deletion/unlink flows
// may remove these rows for the deleting user only; they must not remove
// canonical shared org state in `github_installation_accounts`.
export const githubInstallations = sqliteTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    externalInstallationId: text('external_installation_id'),
    accountType: text('account_type').notNull(),
    accountName: text('account_name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userInstallationIdx: uniqueIndex('idx_github_installations_user_external_installation')
      .on(table.userId, table.externalInstallationId)
      .where(sql`external_installation_id IS NOT NULL`),
  })
);

// =============================================================================
// Projects
// =============================================================================
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description'),
    installationId: text('installation_id')
      .notNull()
      .references(() => githubInstallations.id, { onDelete: 'cascade' }),
    repository: text('repository').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** Repo provider: 'github' (default) or 'artifacts' (Cloudflare Artifacts). */
    repoProvider: text('repo_provider').notNull().default('github'),
    /** Cloudflare Artifacts repo ID. Null for GitHub-backed projects. */
    artifactsRepoId: text('artifacts_repo_id'),
    githubRepoId: integer('github_repo_id'),
    githubRepoNodeId: text('github_repo_node_id'),
    // Per-project defaults (null = use platform defaults from env vars).
    // Resolved via `resolveProjectScalingConfig()` in task-runner and node services.
    defaultVmSize: text('default_vm_size'),
    defaultAgentType: text('default_agent_type'),
    defaultWorkspaceProfile: text('default_workspace_profile'),
    /** Default devcontainer config name for new workspaces. null = auto-discover default. */
    defaultDevcontainerConfigName: text('default_devcontainer_config_name'),
    defaultProvider: text('default_provider'),
    defaultLocation: text('default_location'),
    /** Per-agent-type model + permission mode overrides.
     *  JSON: Record<AgentType, { model?: string | null, permissionMode?: string | null }>
     *  Null/missing for an agent type = fall through to user-level agent_settings. */
    agentDefaults: text('agent_defaults'),
    workspaceIdleTimeoutMs: integer('workspace_idle_timeout_ms'),
    nodeIdleTimeoutMs: integer('node_idle_timeout_ms'),
    // Per-project scaling parameters (null = use platform default from env).
    // See SCALING_PARAMS registry in shared constants for metadata.
    taskExecutionTimeoutMs: integer('task_execution_timeout_ms'),
    maxConcurrentTasks: integer('max_concurrent_tasks'),
    maxDispatchDepth: integer('max_dispatch_depth'),
    maxSubTasksPerTask: integer('max_sub_tasks_per_task'),
    warmNodeTimeoutMs: integer('warm_node_timeout_ms'),
    maxWorkspacesPerNode: integer('max_workspaces_per_node'),
    nodeCpuThresholdPercent: integer('node_cpu_threshold_percent'),
    nodeMemoryThresholdPercent: integer('node_memory_threshold_percent'),
    status: text('status').notNull().default('active'),
    lastActivityAt: text('last_activity_at'),
    activeSessionCount: integer('active_session_count').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_projects_user_id').on(table.userId),
    installationIdIdx: index('idx_projects_installation_id').on(table.installationId),
    userNormalizedNameUnique: uniqueIndex('idx_projects_user_normalized_name').on(
      table.userId,
      table.normalizedName
    ),
    // Trial-onboarding sentinel owner is excluded from the uniqueness invariant:
    // every anonymous trial inserts a row with the same (sentinel user, sentinel
    // installation), so "one project per user+installation+repo" cannot hold for
    // the sentinel. Isolation for trial rows is enforced by `projectId` scoping
    // (see helpers.ts:resolveAnonymousUserId). The index still enforces
    // uniqueness for real users. See migration 0046.
    userInstallationRepoUnique: uniqueIndex('idx_projects_user_installation_repository')
      .on(table.userId, table.installationId, table.repository)
      .where(sql`user_id != 'system_anonymous_trials'`),
    userGithubRepoIdUnique: uniqueIndex('idx_projects_user_github_repo_id')
      .on(table.userId, table.githubRepoId)
      .where(sql`github_repo_id IS NOT NULL`),
    userArtifactsRepoUnique: uniqueIndex('idx_projects_user_artifacts_repo')
      .on(table.userId, table.artifactsRepoId)
      .where(sql`artifacts_repo_id IS NOT NULL`),
  })
);

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
    status: text('status').notNull().default('active'),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    removedAt: text('removed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.userId] }),
    userStatusIdx: index('idx_project_members_user_status').on(table.userId, table.status),
    projectStatusIdx: index('idx_project_members_project_status').on(table.projectId, table.status),
  })
);

export const projectOwnershipTransfers = sqliteTable('project_ownership_transfers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  fromUserId: text('from_user_id').notNull(),
  toUserId: text('to_user_id').notNull(),
  initiatedBy: text('initiated_by').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const projectMemberOffboardingPlans = sqliteTable(
  'project_member_offboarding_plans',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    memberUserId: text('member_user_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    status: text('status').notNull().default('preview'),
    resourceSummaryJson: text('resource_summary_json').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text('expires_at').notNull(),
    appliedAt: text('applied_at'),
  },
  (table) => ({
    projectMemberStatusIdx: index('idx_project_offboarding_plans_project_member_status').on(
      table.projectId,
      table.memberUserId,
      table.status
    ),
  })
);

export const projectMemberOffboardingResourceActions = sqliteTable(
  'project_member_offboarding_resource_actions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => projectMemberOffboardingPlans.id, { onDelete: 'cascade' }),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id').notNull(),
    credentialSourceBefore: text('credential_source_before').notNull(),
    attributionUserIdBefore: text('attribution_user_id_before'),
    attributionProjectIdBefore: text('attribution_project_id_before'),
    recommendedAction: text('recommended_action').notNull(),
    selectedAction: text('selected_action'),
    status: text('status').notNull().default('pending'),
    detailsJson: text('details_json').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    planKindIdx: index('idx_project_offboarding_actions_plan_kind').on(
      table.planId,
      table.resourceKind
    ),
  })
);

export const projectInviteLinks = sqliteTable(
  'project_invite_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: text('last_used_at'),
    useCount: integer('use_count').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectActiveIdx: index('idx_project_invite_links_project').on(
      table.projectId,
      table.revokedAt,
      table.expiresAt
    ),
  })
);

export const projectAccessRequests = sqliteTable(
  'project_access_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    inviteLinkId: text('invite_link_id').references(() => projectInviteLinks.id, {
      onDelete: 'set null',
    }),
    requesterUserId: text('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    githubAccessStatus: text('github_access_status').notNull().default('unchecked'),
    githubAccessCheckedAt: text('github_access_checked_at'),
    githubAccessMessage: text('github_access_message'),
    requestedAt: text('requested_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text('decided_at'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionNote: text('decision_note'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectRequesterUnique: uniqueIndex('idx_project_access_requests_project_requester').on(
      table.projectId,
      table.requesterUserId
    ),
    projectStatusIdx: index('idx_project_access_requests_project_status').on(
      table.projectId,
      table.status,
      table.requestedAt
    ),
  })
);

/** Per-project runtime environment variables injected into workspaces.
 *  Secret values are AES-256-GCM encrypted; non-secret values are stored in plaintext. */
export const projectRuntimeEnvVars = sqliteTable(
  'project_runtime_env_vars',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    envKey: text('env_key').notNull(),
    /** When isSecret=true: AES-256-GCM ciphertext (base64). When isSecret=false: plaintext value. */
    storedValue: text('stored_value').notNull(),
    /** AES-256-GCM IV (base64). Null when isSecret=false (value stored in plaintext). */
    valueIv: text('value_iv'),
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectKeyUnique: uniqueIndex('idx_project_runtime_env_project_key').on(
      table.projectId,
      table.envKey
    ),
    userProjectIdx: index('idx_project_runtime_env_user_project').on(table.userId, table.projectId),
  })
);

/** Per-project runtime files injected into workspaces (e.g. .env, config files).
 *  Secret files are AES-256-GCM encrypted; non-secret files are stored in plaintext. */
export const projectRuntimeFiles = sqliteTable(
  'project_runtime_files',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    /** When isSecret=true: AES-256-GCM ciphertext (base64). When isSecret=false: plaintext content. */
    storedContent: text('stored_content').notNull(),
    /** AES-256-GCM IV (base64). Null when isSecret=false (content stored in plaintext). */
    contentIv: text('content_iv'),
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectPathUnique: uniqueIndex('idx_project_runtime_files_project_path').on(
      table.projectId,
      table.filePath
    ),
    userProjectIdx: index('idx_project_runtime_files_user_project').on(
      table.userId,
      table.projectId
    ),
  })
);

/** Additional same-installation GitHub repositories a project's workspace tokens
 *  may access (Codespaces-style "additional repository access"). The primary
 *  project repository is always included implicitly and is NOT stored here.
 *  Each row is verified (user∩app access) at add time and re-verified at every
 *  token mint. Workspace `/git-token` mints scope `repository_ids` to the primary
 *  repo plus all active rows here, so same-org submodules can be fetched. */
export const projectGithubRepositories = sqliteTable(
  'project_github_repositories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Full repository name, e.g. "octocat/hello-world". */
    repository: text('repository').notNull(),
    /** GitHub numeric repo id captured at verification time (rename-stable). */
    githubRepoId: integer('github_repo_id').notNull(),
    /** GitHub GraphQL node id (nullable for legacy/edge cases). */
    githubRepoNodeId: text('github_repo_node_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectRepoUnique: uniqueIndex('idx_project_github_repos_project_repo').on(
      table.projectId,
      table.repository
    ),
    userProjectIdx: index('idx_project_github_repos_user_project').on(
      table.userId,
      table.projectId
    ),
  })
);

export const projectGitlabRepositories = sqliteTable(
  'project_gitlab_repositories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    host: text('host').notNull(),
    gitlabProjectId: integer('gitlab_project_id').notNull(),
    pathWithNamespace: text('path_with_namespace').notNull(),
    webUrl: text('web_url'),
    httpUrlToRepo: text('http_url_to_repo').notNull(),
    defaultBranch: text('default_branch').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectUnique: uniqueIndex('idx_project_gitlab_repos_project').on(table.projectId),
    userHostProjectUnique: uniqueIndex('idx_project_gitlab_repos_user_host_project').on(
      table.userId,
      table.host,
      table.gitlabProjectId
    ),
    projectUserIdx: index('idx_project_gitlab_repos_project_user').on(
      table.projectId,
      table.userId
    ),
  })
);

// =============================================================================
// Project Deployment Credentials (GCP OIDC for Defang deployments)
// Note: This table stores GCP WIF configuration (project IDs, service account
// emails, pool IDs) — NOT encrypted tokens. The actual OIDC token exchange
// happens at deployment time using these references.
// =============================================================================
export const projectDeploymentCredentials = sqliteTable(
  'project_deployment_credentials',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('gcp'), // Currently only 'gcp'
    gcpProjectId: text('gcp_project_id').notNull(),
    gcpProjectNumber: text('gcp_project_number').notNull(),
    serviceAccountEmail: text('service_account_email').notNull(),
    wifPoolId: text('wif_pool_id').notNull(),
    wifProviderId: text('wif_provider_id').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectUnique: uniqueIndex('idx_project_deployment_creds_project').on(
      table.projectId,
      table.provider
    ),
    userIdx: index('idx_project_deployment_creds_user').on(table.userId),
  })
);

// =============================================================================
// Missions (Phase 2: Orchestration Primitives)
// =============================================================================
export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('planning'),
    /** Soft FK to tasks table. The root task that initiated this mission. */
    rootTaskId: text('root_task_id'),
    /** JSON-serialized MissionBudgetConfig. Enforcement comes in later phases. */
    budgetConfig: text('budget_config'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectIdIdx: index('idx_missions_project_id').on(table.projectId),
    projectStatusIdx: index('idx_missions_project_status').on(table.projectId, table.status),
    userIdIdx: index('idx_missions_user_id').on(table.userId),
  })
);

// =============================================================================
// Tasks
// =============================================================================
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Soft cross-store link to the ProjectData chat session backing this task. */
    chatSessionId: text('chat_session_id'),
    /** Null for top-level tasks; set for agent-dispatched sub-tasks (dispatch depth > 0). No FK — parent may be in another project's scope. */
    parentTaskId: text('parent_task_id'),
    /** Null until a workspace is assigned during task execution. Set by TaskRunner DO. */
    workspaceId: text('workspace_id'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    executionStep: text('execution_step'),
    priority: integer('priority').notNull().default(0),
    agentProfileHint: text('agent_profile_hint'),
    /** Optional skill selected for repeatable-work configuration. */
    skillId: text('skill_id'),
    /** Original skill hint/id requested by the caller. */
    skillHint: text('skill_hint'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    errorMessage: text('error_message'),
    outputSummary: text('output_summary'),
    outputBranch: text('output_branch'),
    outputPrUrl: text('output_pr_url'),
    completionEvidence: text('completion_evidence'),
    finalizedAt: text('finalized_at'),
    /** Task execution mode. 'task' = push/PR/complete lifecycle. 'conversation' = human-controlled lifecycle. */
    taskMode: text('task_mode').notNull().default('task'),
    /** Dispatch depth for agent-spawned tasks. 0 = user-created, N = Nth generation agent dispatch. */
    dispatchDepth: integer('dispatch_depth').notNull().default(0),
    /** Node auto-provisioned for this task. set null on node delete so the task record survives cleanup. */
    autoProvisionedNodeId: text('auto_provisioned_node_id').references(() => nodes.id, {
      onDelete: 'set null',
    }),
    /** Source that created this task. 'user' = manual, 'cron'/'webhook'/'mcp' = automated. */
    triggeredBy: text('triggered_by').notNull().default('user'),
    /** Soft FK to triggers table (null for user-created tasks). No DB constraint — trigger may be deleted independently. */
    triggerId: text('trigger_id'),
    /** Soft FK to trigger_executions table. No DB constraint — execution record may be cleaned up independently. */
    triggerExecutionId: text('trigger_execution_id'),
    /** Whether the agent credential came from the user or the platform. */
    agentCredentialSource: text('agent_credential_source').default('user'), // 'user' | 'project' | 'platform'
    /** User whose credential attribution is pinned for this task tree. */
    credentialAttributionUserId: text('credential_attribution_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Project scope used when credentialAttributionSource is 'project'. */
    credentialAttributionProjectId: text('credential_attribution_project_id').references(
      () => projects.id,
      { onDelete: 'set null' }
    ),
    /** Root-pinned credential attribution source: 'user' | 'project' | 'platform'. */
    credentialAttributionSource: text('credential_attribution_source').default('user'),
    credentialBlockedReason: text('credential_blocked_reason'),
    credentialBlockedAt: text('credential_blocked_at'),
    /** Null for standalone tasks; set when task belongs to a mission. Set null on mission delete. */
    missionId: text('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    /** Scheduler classification for mission tasks. Null for standalone tasks. */
    schedulerState: text('scheduler_state'),
    /** Resolved VM size for audit (e.g. 'small', 'medium', 'large'). */
    requestedVmSize: text('requested_vm_size'),
    /** Where the VM size came from (e.g. 'task', 'agent-profile', 'project', 'platform'). */
    requestedVmSizeSource: text('requested_vm_size_source'),
    /** VM size actually provisioned. Differs from requestedVmSize only when size-fallback descended on capacity exhaustion. Null until an auto-provisioned node succeeds at a smaller size. */
    provisionedVmSize: text('provisioned_vm_size'),
    /** JSON snapshot of ResourceRequirements as resolved from the precedence chain. */
    resourceRequirementsJson: text('resource_requirements_json'),
    /** Which level of the precedence chain provided the resource requirements. */
    resourceRequirementsSource: text('resource_requirements_source'),
    /** JSON snapshot of ResolvedResourceReservation (scheduler-facing units). */
    resolvedReservationJson: text('resolved_reservation_json'),
    /** JSON snapshot of PlacementExplanation (audit trail). */
    placementExplanationJson: text('placement_explanation_json'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    autoProvisionedNodeIdx: index('idx_tasks_auto_provisioned_node')
      .on(table.autoProvisionedNodeId)
      .where(sql`auto_provisioned_node_id is not null`),
    projectStatusPriorityUpdatedIdx: index('idx_tasks_project_status_priority_updated').on(
      table.projectId,
      table.status,
      table.priority,
      table.updatedAt
    ),
    projectCreatedAtIdx: index('idx_tasks_project_created_at').on(table.projectId, table.createdAt),
    projectUserIdx: index('idx_tasks_project_user').on(table.projectId, table.userId),
    chatSessionIdUnique: uniqueIndex('idx_tasks_chat_session_id_unique')
      .on(table.chatSessionId)
      .where(sql`chat_session_id IS NOT NULL`),
    triggerExecutionIdIdx: index('idx_tasks_trigger_execution_id')
      .on(table.triggerExecutionId)
      .where(sql`trigger_execution_id IS NOT NULL`),
    missionIdIdx: index('idx_tasks_mission_id')
      .on(table.missionId)
      .where(sql`mission_id IS NOT NULL`),
  })
);

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    dependsOnIdx: index('idx_task_dependencies_depends_on').on(table.dependsOnTaskId),
  })
);

export const taskStatusEvents = sqliteTable(
  'task_status_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    reason: text('reason'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    taskCreatedAtIdx: index('idx_task_status_events_task_created_at').on(
      table.taskId,
      table.createdAt
    ),
  })
);

// =============================================================================
// Nodes
// =============================================================================
export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('pending'),
    vmSize: text('vm_size').notNull().default('medium'),
    vmLocation: text('vm_location').notNull().default('nbg1'),
    cloudProvider: text('cloud_provider'),
    providerInstanceId: text('provider_instance_id'),
    ipAddress: text('ip_address'),
    backendDnsRecordId: text('backend_dns_record_id'),
    lastHeartbeatAt: text('last_heartbeat_at'),
    /** ISO-8601 timestamp from VM agent /ready after system provisioning completes. */
    agentReadyAt: text('agent_ready_at'),
    healthStatus: text('health_status').notNull().default('unhealthy'),
    heartbeatStaleAfterSeconds: integer('heartbeat_stale_after_seconds').notNull().default(180),
    lastMetrics: text('last_metrics'),
    /** ISO-8601 timestamp when node entered warm pool. Null if node is not warm. Used by NodeLifecycle DO for timeout. */
    warmSince: text('warm_since'),
    /**
     * 'user' = provisioned with user's own credential; 'platform' = provisioned with platform
     * credential; 'self-hosted' = user-owned (BYO) node SAM provisioned nothing for ($0 compute).
     */
    credentialSource: text('credential_source').default('user'),
    /** User whose credential attribution was used to provision this node. */
    credentialAttributionUserId: text('credential_attribution_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Project scope used when credentialAttributionSource is 'project'. */
    credentialAttributionProjectId: text('credential_attribution_project_id').references(
      () => projects.id,
      { onDelete: 'set null' }
    ),
    /** Credential attribution source used at node creation: 'user' | 'project' | 'platform'. */
    credentialAttributionSource: text('credential_attribution_source').default('user'),
    offboardingStatus: text('offboarding_status'),
    offboardingBlockedReason: text('offboarding_blocked_reason'),
    offboardingBlockedAt: text('offboarding_blocked_at'),
    /** 'workspace' = ephemeral task/dev node (default); 'deployment' = long-lived app-hosting node. */
    nodeRole: text('node_role').notNull().default('workspace'),
    /** 'shared' = eligible for multi-tenant placement; 'exclusive' = one deployment environment only. */
    nodeMode: text('node_mode').notNull().default('shared'),
    /** Runtime substrate: 'vm' (default) or 'cf-container' for the Sandbox spike. */
    runtime: text('runtime').notNull().default('vm'),
    /**
     * Ownership/lifecycle class: 'managed' (default, SAM-provisioned) or 'user-owned' (BYO
     * enrolled machine). Drives lifecycle guards, billing, quota, and UI. Orthogonal to `runtime`.
     */
    nodeClass: text('node_class').notNull().default('managed'),
    /** Reachability transport: 'vm-public-dns' | 'cloudflare-tunnel'. Null for implicit transport. */
    transport: text('transport'),
    /** Cloudflare Tunnel UUID for user-owned tunnel nodes. Null otherwise. */
    tunnelId: text('tunnel_id'),
    /** Cloudflare Tunnel display name for user-owned tunnel nodes. Null otherwise. */
    tunnelName: text('tunnel_name'),
    errorMessage: text('error_message'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_nodes_user_id').on(table.userId),
    runtimeIdx: index('idx_nodes_runtime').on(table.runtime),
    nodeClassIdx: index('idx_nodes_node_class').on(table.nodeClass),
  })
);

// =============================================================================
// Workspaces
// =============================================================================
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    /** Null when node is destroyed; workspace record preserved for history. set null on node delete. */
    nodeId: text('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Null for legacy workspaces created before project-first architecture. set null on project delete. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for workspaces not linked to a GitHub installation. No onDelete — installation removal doesn't affect workspaces. */
    installationId: text('installation_id').references(() => githubInstallations.id),
    displayName: text('display_name'),
    normalizedDisplayName: text('normalized_display_name'),
    name: text('name').notNull(),
    repository: text('repository').notNull(),
    branch: text('branch').notNull().default('main'),
    status: text('status').notNull().default('pending'),
    vmSize: text('vm_size').notNull(),
    vmLocation: text('vm_location').notNull(),
    workspaceProfile: text('workspace_profile').default(DEFAULT_WORKSPACE_PROFILE),
    /** Selected devcontainer config name. null = auto-discover default. */
    devcontainerConfigName: text('devcontainer_config_name'),
    hetznerServerId: text('hetzner_server_id'),
    vmIp: text('vm_ip'),
    dnsRecordId: text('dns_record_id'),
    lastActivityAt: text('last_activity_at'),
    /** Soft FK to ProjectData DO session (not a D1 table). Null until a chat session binds to this workspace. */
    chatSessionId: text('chat_session_id'),
    portsPublicEnabled: integer('ports_public_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    errorMessage: text('error_message'),
    dispatchedAt: text('dispatched_at'),
    /** Agent profile ID used for this workspace's task — drives GitHub CLI policy enforcement. */
    agentProfileHint: text('agent_profile_hint'),
    /** JSON snapshot of ResourceRequirements for audit. */
    resourceRequirementsJson: text('resource_requirements_json'),
    /** JSON snapshot of ResolvedResourceReservation for audit. */
    resolvedReservationJson: text('resolved_reservation_json'),
    /** JSON snapshot of PlacementExplanation for audit. */
    placementExplanationJson: text('placement_explanation_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_workspaces_user_id').on(table.userId),
    nodeIdIdx: index('idx_workspaces_node_id').on(table.nodeId),
    projectIdIdx: index('idx_workspaces_project_id').on(table.projectId),
    nodeDisplayNameUnique: uniqueIndex('idx_workspaces_node_display_name_unique')
      .on(table.nodeId, table.normalizedDisplayName)
      .where(sql`node_id is not null and normalized_display_name is not null`),
    // Compound indexes for filtered listing queries (P2 fix).
    userStatusIdx: index('idx_workspaces_user_status').on(table.userId, table.status),
    userProjectStatusIdx: index('idx_workspaces_user_project_status').on(
      table.userId,
      table.projectId,
      table.status
    ),
    nodeStatusIdx: index('idx_workspaces_node_status').on(table.nodeId, table.status),
    chatSessionIdUnique: uniqueIndex('idx_workspaces_chat_session_id_unique')
      .on(table.chatSessionId)
      .where(sql`chat_session_id IS NOT NULL`),
  })
);

// =============================================================================
// Agent Sessions
// =============================================================================
export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    label: text('label'),
    agentType: text('agent_type'),
    agentProfileId: text('agent_profile_id').references(() => agentProfiles.id, {
      onDelete: 'set null',
    }),
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    worktreePath: text('worktree_path'),
    stoppedAt: text('stopped_at'),
    suspendedAt: text('suspended_at'),
    errorMessage: text('error_message'),
    lastPrompt: text('last_prompt'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    workspaceIdIdx: index('idx_agent_sessions_workspace_id').on(table.workspaceId),
    userIdIdx: index('idx_agent_sessions_user_id').on(table.userId),
    agentProfileIdIdx: index('idx_agent_sessions_agent_profile_id').on(table.agentProfileId),
    skillIdIdx: index('idx_agent_sessions_skill_id').on(table.skillId),
    // Compound index for filtered session queries (P2 fix).
    workspaceUserStatusIdx: index('idx_agent_sessions_ws_user_status').on(
      table.workspaceId,
      table.userId,
      table.status
    ),
  })
);

// =============================================================================
// Runtime-neutral Session Snapshots
// =============================================================================
export const sessionSnapshots = sqliteTable(
  'session_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    nodeId: text('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatSessionId: text('chat_session_id').notNull(),
    agentSessionId: text('agent_session_id'),
    runtime: text('runtime').notNull(),
    status: text('status').notNull().default('pending'),
    degradation: text('degradation').notNull().default('none'),
    homeR2Key: text('home_r2_key'),
    wipR2Key: text('wip_r2_key'),
    manifestR2Key: text('manifest_r2_key').notNull(),
    baseCommit: text('base_commit'),
    expiresAt: text('expires_at').notNull(),
    manifestJson: text('manifest_json'),
    restoreStatus: text('restore_status'),
    restoreMessage: text('restore_message'),
    restoredAt: text('restored_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    chatSessionIdUnique: uniqueIndex('idx_session_snapshots_chat_session_id').on(
      table.chatSessionId
    ),
    workspaceIdIdx: index('idx_session_snapshots_workspace_id').on(table.workspaceId),
    expiresAtIdx: index('idx_session_snapshots_expires_at').on(table.expiresAt),
  })
);

// =============================================================================
// Agent Settings (per-user, per-agent configuration)
// =============================================================================
export const agentSettings = sqliteTable(
  'agent_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentType: text('agent_type').notNull(),
    model: text('model'),
    permissionMode: text('permission_mode'),
    allowedTools: text('allowed_tools'),
    deniedTools: text('denied_tools'),
    additionalEnv: text('additional_env'),
    /** OpenCode inference provider: 'opencode-zen' | 'opencode-go' | 'custom'. null = use default (zen). */
    opencodeProvider: text('opencode_provider'),
    /** Base URL for the custom OpenCode provider. */
    opencodeBaseUrl: text('opencode_base_url'),
    /** Explicit provider mode for Claude Code / Codex: 'sam' | 'user-api-key' | 'oauth'. null = not set. */
    providerMode: text('provider_mode'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
  },
  (table) => ({
    userIdIdx: index('idx_agent_settings_user_id').on(table.userId),
    userAgentTypeUnique: uniqueIndex('idx_agent_settings_user_agent_type').on(
      table.userId,
      table.agentType
    ),
  })
);

// =============================================================================
// Agent Profiles (per-project or global role definitions)
//
// Partial index note: The SQL migration (0028_agent_profiles.sql) defines two
// partial unique indexes that Drizzle ORM cannot express:
//   - idx_agent_profiles_project_name: UNIQUE(project_id, name) WHERE project_id IS NOT NULL
//   - idx_agent_profiles_global_name:  UNIQUE(user_id, name) WHERE project_id IS NULL
// The Drizzle-side index below only covers the project-scoped case. Global
// (per-user) profile name uniqueness is enforced by the raw SQL migration only.
// =============================================================================
export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    id: text('id').primaryKey(),
    /** Null for global (user-scoped) profiles; set for project-specific profiles. Cascade on project delete. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    agentType: text('agent_type').notNull().default('claude-code'),
    model: text('model'),
    effort: text('effort').notNull().default('auto'),
    permissionMode: text('permission_mode'),
    systemPromptAppend: text('system_prompt_append'),
    maxTurns: integer('max_turns'),
    timeoutMinutes: integer('timeout_minutes'),
    vmSizeOverride: text('vm_size_override'),
    provider: text('provider'),
    vmLocation: text('vm_location'),
    workspaceProfile: text('workspace_profile'),
    /** Runtime preference: null = automatic, 'vm' = cloud VM, 'cf-container' = Cloudflare Container. */
    runtime: text('runtime'),
    /** Devcontainer config name override. null = inherit from project/platform defaults. */
    devcontainerConfigName: text('devcontainer_config_name'),
    taskMode: text('task_mode'),
    /** JSON GitHubCliPolicy. null = inherit full installation token behavior. */
    githubCliPolicy: text('github_cli_policy'),
    isBuiltin: integer('is_builtin').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Note: The SQL migration (0028_agent_profiles.sql) defines two partial unique indexes:
    //   idx_agent_profiles_project_name WHERE project_id IS NOT NULL
    //   idx_agent_profiles_global_name  WHERE project_id IS NULL (per-user)
    // Drizzle ORM does not support partial/conditional indexes, so only the
    // project-scoped index is represented here. Global-profile uniqueness is
    // enforced by the raw SQL migration only.
    projectNameUnique: uniqueIndex('idx_agent_profiles_project_name').on(
      table.projectId,
      table.name
    ),
    projectIdIdx: index('idx_agent_profiles_project_id').on(table.projectId),
    userIdIdx: index('idx_agent_profiles_user_id').on(table.userId),
  })
);

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type NewAgentProfileRow = typeof agentProfiles.$inferInsert;

// =============================================================================
// Skills (per-project repeatable-work definitions)
// =============================================================================
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    agentType: text('agent_type').notNull().default('claude-code'),
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),
    systemPromptAppend: text('system_prompt_append'),
    maxTurns: integer('max_turns'),
    timeoutMinutes: integer('timeout_minutes'),
    vmSizeOverride: text('vm_size_override'),
    provider: text('provider'),
    vmLocation: text('vm_location'),
    workspaceProfile: text('workspace_profile'),
    runtime: text('runtime'),
    devcontainerConfigName: text('devcontainer_config_name'),
    taskMode: text('task_mode').default('task'),
    resourceRequirementsJson: text('resource_requirements_json'),
    defaultProfileId: text('default_profile_id').references(() => agentProfiles.id, {
      onDelete: 'set null',
    }),
    isBuiltin: integer('is_builtin').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectNameUnique: uniqueIndex('idx_skills_project_name').on(table.projectId, table.name),
    projectIdIdx: index('idx_skills_project_id').on(table.projectId),
    userIdIdx: index('idx_skills_user_id').on(table.userId),
    defaultProfileIdx: index('idx_skills_default_profile_id').on(table.defaultProfileId),
  })
);

export type SkillRow = typeof skills.$inferSelect;
export type NewSkillRow = typeof skills.$inferInsert;

const profileRuntimeBaseColumns = () => ({
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => agentProfiles.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

/** Per-profile runtime environment variables injected into task workspaces.
 *  Secret values are AES-256-GCM encrypted; non-secret values are stored in plaintext. */
export const profileRuntimeEnvVars = sqliteTable(
  'profile_runtime_env_vars',
  {
    ...profileRuntimeBaseColumns(),
    envKey: text('env_key').notNull(),
    /** When isSecret=true: AES-256-GCM ciphertext (base64). When isSecret=false: plaintext value. */
    storedValue: text('stored_value').notNull(),
    /** AES-256-GCM IV (base64). Null when isSecret=false (value stored in plaintext). */
    valueIv: text('value_iv'),
  },
  (table) => ({
    profileKeyUnique: uniqueIndex('idx_profile_runtime_env_profile_key').on(
      table.profileId,
      table.envKey
    ),
    userProfileIdx: index('idx_profile_runtime_env_user_profile').on(table.userId, table.profileId),
  })
);

/** Per-profile runtime files injected into task workspaces.
 *  Secret files are AES-256-GCM encrypted; non-secret files are stored in plaintext. */
export const profileRuntimeFiles = sqliteTable(
  'profile_runtime_files',
  {
    ...profileRuntimeBaseColumns(),
    filePath: text('file_path').notNull(),
    /** When isSecret=true: AES-256-GCM ciphertext (base64). When isSecret=false: plaintext content. */
    storedContent: text('stored_content').notNull(),
    /** AES-256-GCM IV (base64). Null when isSecret=false (content stored in plaintext). */
    contentIv: text('content_iv'),
  },
  (table) => ({
    profilePathUnique: uniqueIndex('idx_profile_runtime_files_profile_path').on(
      table.profileId,
      table.filePath
    ),
    userProfileIdx: index('idx_profile_runtime_files_user_profile').on(
      table.userId,
      table.profileId
    ),
  })
);

const skillRuntimeBaseColumns = () => ({
  id: text('id').primaryKey(),
  skillId: text('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const skillRuntimeEnvVars = sqliteTable(
  'skill_runtime_env_vars',
  {
    ...skillRuntimeBaseColumns(),
    envKey: text('env_key').notNull(),
    storedValue: text('stored_value').notNull(),
    valueIv: text('value_iv'),
  },
  (table) => ({
    skillKeyUnique: uniqueIndex('idx_skill_runtime_env_skill_key').on(table.skillId, table.envKey),
    userSkillIdx: index('idx_skill_runtime_env_user_skill').on(table.userId, table.skillId),
  })
);

export const skillRuntimeFiles = sqliteTable(
  'skill_runtime_files',
  {
    ...skillRuntimeBaseColumns(),
    filePath: text('file_path').notNull(),
    storedContent: text('stored_content').notNull(),
    contentIv: text('content_iv'),
  },
  (table) => ({
    skillPathUnique: uniqueIndex('idx_skill_runtime_files_skill_path').on(
      table.skillId,
      table.filePath
    ),
    userSkillIdx: index('idx_skill_runtime_files_user_skill').on(table.userId, table.skillId),
  })
);

// =============================================================================
// UI Governance
// =============================================================================
export const uiStandards = sqliteTable(
  'ui_standards',
  {
    id: text('id').primaryKey(),
    version: text('version').notNull().unique(),
    status: text('status').notNull(),
    name: text('name').notNull(),
    visualDirection: text('visual_direction').notNull(),
    mobileFirstRulesRef: text('mobile_first_rules_ref').notNull(),
    accessibilityRulesRef: text('accessibility_rules_ref').notNull(),
    ownerRole: text('owner_role').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    statusIdx: index('idx_ui_standards_status').on(table.status),
  })
);

export const themeTokens = sqliteTable(
  'theme_tokens',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    tokenNamespace: text('token_namespace').notNull(),
    tokenName: text('token_name').notNull(),
    tokenValue: text('token_value').notNull(),
    mode: text('mode').notNull().default('default'),
    isDeprecated: integer('is_deprecated', { mode: 'boolean' }).notNull().default(false),
    replacementToken: text('replacement_token'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_theme_tokens_standard_id').on(table.standardId),
  })
);

export const componentDefinitions = sqliteTable(
  'component_definitions',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull(),
    supportedSurfacesJson: text('supported_surfaces_json').notNull(),
    requiredStatesJson: text('required_states_json').notNull(),
    usageGuidance: text('usage_guidance').notNull(),
    accessibilityNotes: text('accessibility_notes').notNull(),
    mobileBehavior: text('mobile_behavior').notNull(),
    desktopBehavior: text('desktop_behavior').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_component_defs_standard_id').on(table.standardId),
  })
);

export const complianceChecklists = sqliteTable(
  'compliance_checklists',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    itemsJson: text('items_json').notNull(),
    appliesToJson: text('applies_to_json').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    publishedAt: text('published_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_checklists_standard_id').on(table.standardId),
  })
);

export const agentInstructionSets = sqliteTable(
  'agent_instruction_sets',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    instructionBlocksJson: text('instruction_blocks_json').notNull(),
    examplesRef: text('examples_ref'),
    requiredChecklistVersion: text('required_checklist_version').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_instruction_sets_standard_id').on(table.standardId),
  })
);

export const exceptionRequests = sqliteTable(
  'exception_requests',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').notNull(),
    rationale: text('rationale').notNull(),
    scope: text('scope').notNull(),
    expirationDate: text('expiration_date').notNull(),
    approver: text('approver'),
    status: text('status').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_exception_requests_standard_id').on(table.standardId),
  })
);

export const complianceRuns = sqliteTable(
  'compliance_runs',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    checklistVersion: text('checklist_version').notNull(),
    authorType: text('author_type').notNull(),
    changeRef: text('change_ref').notNull(),
    status: text('status').notNull(),
    findingsJson: text('findings_json'),
    reviewedBy: text('reviewed_by'),
    /** Null when no exception was granted. set null on exception delete — run record preserved for audit. */
    exceptionRequestId: text('exception_request_id').references(() => exceptionRequests.id, {
      onDelete: 'set null',
    }),
    completedAt: text('completed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_compliance_runs_standard_id').on(table.standardId),
  })
);

export const migrationWorkItems = sqliteTable(
  'migration_work_items',
  {
    id: text('id').primaryKey(),
    standardId: text('standard_id')
      .notNull()
      .references(() => uiStandards.id, { onDelete: 'cascade' }),
    surface: text('surface').notNull(),
    targetRef: text('target_ref').notNull(),
    priority: text('priority').notNull(),
    status: text('status').notNull(),
    owner: text('owner').notNull(),
    dueMilestone: text('due_milestone'),
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    standardIdIdx: index('idx_migration_items_standard_id').on(table.standardId),
  })
);

// Type exports for inference
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type ProjectInviteLink = typeof projectInviteLinks.$inferSelect;
export type NewProjectInviteLink = typeof projectInviteLinks.$inferInsert;
export type ProjectAccessRequest = typeof projectAccessRequests.$inferSelect;
export type NewProjectAccessRequest = typeof projectAccessRequests.$inferInsert;
export type ProjectRuntimeEnvVar = typeof projectRuntimeEnvVars.$inferSelect;
export type NewProjectRuntimeEnvVar = typeof projectRuntimeEnvVars.$inferInsert;
export type ProjectRuntimeFile = typeof projectRuntimeFiles.$inferSelect;
export type NewProjectRuntimeFile = typeof projectRuntimeFiles.$inferInsert;
export type ProjectGithubRepository = typeof projectGithubRepositories.$inferSelect;
export type NewProjectGithubRepository = typeof projectGithubRepositories.$inferInsert;
export type ProfileRuntimeEnvVar = typeof profileRuntimeEnvVars.$inferSelect;
export type NewProfileRuntimeEnvVar = typeof profileRuntimeEnvVars.$inferInsert;
export type ProfileRuntimeFile = typeof profileRuntimeFiles.$inferSelect;
export type NewProfileRuntimeFile = typeof profileRuntimeFiles.$inferInsert;
export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type NewTaskDependency = typeof taskDependencies.$inferInsert;
export type TaskStatusEvent = typeof taskStatusEvents.$inferSelect;
export type NewTaskStatusEvent = typeof taskStatusEvents.$inferInsert;
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type SessionSnapshot = typeof sessionSnapshots.$inferSelect;
export type NewSessionSnapshot = typeof sessionSnapshots.$inferInsert;
export type UIStandard = typeof uiStandards.$inferSelect;
export type NewUIStandard = typeof uiStandards.$inferInsert;
export type ThemeToken = typeof themeTokens.$inferSelect;
export type NewThemeToken = typeof themeTokens.$inferInsert;
export type ComponentDefinition = typeof componentDefinitions.$inferSelect;
export type NewComponentDefinition = typeof componentDefinitions.$inferInsert;
export type ComplianceChecklist = typeof complianceChecklists.$inferSelect;
export type NewComplianceChecklist = typeof complianceChecklists.$inferInsert;
export type AgentInstructionSet = typeof agentInstructionSets.$inferSelect;
export type NewAgentInstructionSet = typeof agentInstructionSets.$inferInsert;
export type ExceptionRequest = typeof exceptionRequests.$inferSelect;
export type NewExceptionRequest = typeof exceptionRequests.$inferInsert;
export type ComplianceRun = typeof complianceRuns.$inferSelect;
export type NewComplianceRun = typeof complianceRuns.$inferInsert;
export type MigrationWorkItem = typeof migrationWorkItems.$inferSelect;
export type NewMigrationWorkItem = typeof migrationWorkItems.$inferInsert;
export type AgentSettingsRow = typeof agentSettings.$inferSelect;
export type NewAgentSettingsRow = typeof agentSettings.$inferInsert;

// =============================================================================
// API Tokens (stored in legacy smoke_test_tokens table)
// =============================================================================
export const apiTokens = sqliteTable(
  'smoke_test_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex('idx_smoke_test_tokens_hash').on(table.tokenHash),
    userIdIdx: index('idx_smoke_test_tokens_user').on(table.userId),
  })
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;

// =============================================================================
// Project File Library (per-project encrypted file storage in R2)
//
// File content is AES-256-GCM encrypted and stored in R2 (not in D1). This
// table holds metadata only. The `r2Key` field points to the encrypted blob.
// Encrypt/decrypt logic: `services/file-encryption.ts`.
// projectId is NOT a FK — the project_files table was designed for soft
// references to avoid cascade complications with R2 cleanup.
// =============================================================================
export const projectFiles = sqliteTable(
  'project_files',
  {
    id: text('id').primaryKey(),
    /** Soft reference to projects table. No FK constraint — R2 cleanup handled separately. */
    projectId: text('project_id').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    description: text('description'),
    uploadedBy: text('uploaded_by').notNull(),
    uploadSource: text('upload_source').notNull().default('user'),
    uploadSessionId: text('upload_session_id'),
    uploadTaskId: text('upload_task_id'),
    replacedAt: text('replaced_at'),
    replacedBy: text('replaced_by'),
    status: text('status').notNull().default('ready'),
    r2Key: text('r2_key').notNull(),
    extractedTextPreview: text('extracted_text_preview'),
    directory: text('directory').notNull().default('/'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectIdx: index('idx_project_files_project_id').on(table.projectId),
    projectStatusIdx: index('idx_project_files_project_status').on(table.projectId, table.status),
    projectSourceIdx: index('idx_project_files_project_source').on(
      table.projectId,
      table.uploadSource
    ),
    projectMimeIdx: index('idx_project_files_project_mime').on(table.projectId, table.mimeType),
    projectDirFilenameUniq: uniqueIndex('idx_project_files_project_dir_filename').on(
      table.projectId,
      table.directory,
      table.filename
    ),
    projectDirIdx: index('idx_project_files_project_dir').on(table.projectId, table.directory),
  })
);

export type ProjectFileRow = typeof projectFiles.$inferSelect;
export type NewProjectFile = typeof projectFiles.$inferInsert;

export const projectFileTags = sqliteTable(
  'project_file_tags',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => projectFiles.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    tagSource: text('tag_source').notNull().default('user'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fileId, table.tag] }),
    tagIdx: index('idx_project_file_tags_tag').on(table.tag),
  })
);

export type ProjectFileTagRow = typeof projectFileTags.$inferSelect;
export type NewProjectFileTag = typeof projectFileTags.$inferInsert;

// =============================================================================
// Triggers (Event-Driven Agent Triggers — Phase 0: Cron)
// =============================================================================
export const triggers = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    sourceType: text('source_type').notNull(),
    cronExpression: text('cron_expression'),
    cronTimezone: text('cron_timezone').default('UTC'),
    skipIfRunning: integer('skip_if_running', { mode: 'boolean' }).notNull().default(true),
    promptTemplate: text('prompt_template').notNull(),
    /** Optional agent profile for triggered tasks. set null on profile delete — trigger continues with defaults. */
    agentProfileId: text('agent_profile_id').references(() => agentProfiles.id, {
      onDelete: 'set null',
    }),
    /** Optional skill for triggered tasks. set null on skill delete — trigger continues with profile/defaults. */
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    taskMode: text('task_mode').default('task'),
    vmSizeOverride: text('vm_size_override'),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    lastTriggeredAt: text('last_triggered_at'),
    triggerCount: integer('trigger_count').notNull().default(0),
    /** Monotonic sequence for every execution attempt, including skipped attempts. */
    nextExecutionSequence: integer('next_execution_sequence').notNull().default(1),
    nextFireAt: text('next_fire_at'),
    credentialBlockedReason: text('credential_blocked_reason'),
    credentialBlockedAt: text('credential_blocked_at'),
    credentialBlockedBy: text('credential_blocked_by'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectNameUnique: uniqueIndex('idx_triggers_project_name').on(table.projectId, table.name),
    cronSweepIdx: index('idx_triggers_cron_sweep')
      .on(table.sourceType, table.status, table.nextFireAt)
      .where(sql`source_type = 'cron' AND status = 'active'`),
    userIdIdx: index('idx_triggers_user_id').on(table.userId),
    projectIdIdx: index('idx_triggers_project_id').on(table.projectId),
  })
);

export type TriggerRow = typeof triggers.$inferSelect;
export type NewTriggerRow = typeof triggers.$inferInsert;

// =============================================================================
// Trigger Executions (audit log of every trigger firing attempt)
// =============================================================================
export const triggerExecutions = sqliteTable(
  'trigger_executions',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    status: text('status').notNull(),
    skipReason: text('skip_reason'),
    /** Soft FK to tasks table. Null when execution was skipped or failed before task creation. */
    taskId: text('task_id'),
    eventType: text('event_type'),
    renderedPrompt: text('rendered_prompt'),
    errorMessage: text('error_message'),
    scheduledAt: text('scheduled_at'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    sequenceNumber: integer('sequence_number'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    activeIdx: index('idx_trigger_executions_active')
      .on(table.triggerId, table.status)
      .where(sql`status IN ('queued', 'running')`),
    triggerIdIdx: index('idx_trigger_executions_trigger_id').on(table.triggerId),
  })
);

export type TriggerExecutionRow = typeof triggerExecutions.$inferSelect;
export type NewTriggerExecutionRow = typeof triggerExecutions.$inferInsert;

// =============================================================================
// GitHub Trigger Configs (source-specific config for GitHub event triggers)
// =============================================================================
export const githubTriggerConfigs = sqliteTable(
  'github_trigger_configs',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    filtersJson: text('filters_json').notNull().default('{}'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    triggerIdUnique: uniqueIndex('idx_github_trigger_configs_trigger_id').on(table.triggerId),
    eventTypeIdx: index('idx_github_trigger_configs_event_type').on(table.eventType),
  })
);

export type GitHubTriggerConfigRow = typeof githubTriggerConfigs.$inferSelect;
export type NewGitHubTriggerConfigRow = typeof githubTriggerConfigs.$inferInsert;

// =============================================================================
// GitHub Webhook Deliveries (dedup and audit trail)
// =============================================================================
export const githubWebhookDeliveries = sqliteTable(
  'github_webhook_deliveries',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    action: text('action'),
    installationId: text('installation_id'),
    repositoryFullName: text('repository_full_name'),
    senderLogin: text('sender_login'),
    matchedTriggerId: text('matched_trigger_id'),
    decision: text('decision').notNull(),
    decisionReason: text('decision_reason'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    createdIdx: index('idx_github_webhook_deliveries_created').on(table.createdAt),
    installationIdx: index('idx_github_webhook_deliveries_installation').on(table.installationId),
  })
);

export type GitHubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferSelect;
export type NewGitHubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferInsert;

// =============================================================================
// Generic Webhook Trigger Configs
// =============================================================================
export const webhookTriggerConfigs = sqliteTable(
  'webhook_trigger_configs',
  {
    triggerId: text('trigger_id')
      .primaryKey()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    tokenLastFour: text('token_last_four').notNull(),
    tokenCreatedAt: text('token_created_at').notNull(),
    tokenRotatedAt: text('token_rotated_at'),
    sourceLabel: text('source_label'),
    filterMode: text('filter_mode').notNull().default('all'),
    filtersJson: text('filters_json').notNull().default('[]'),
    includedHeadersJson: text('included_headers_json').notNull().default('[]'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('idx_webhook_trigger_configs_token_hash').on(table.tokenHash),
  })
);

export type WebhookTriggerConfigRow = typeof webhookTriggerConfigs.$inferSelect;
export type NewWebhookTriggerConfigRow = typeof webhookTriggerConfigs.$inferInsert;

// =============================================================================
// Generic Webhook Deliveries (bounded audit metadata; never stores raw payload)
// =============================================================================
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    idempotencyKeyHash: text('idempotency_key_hash'),
    requestFingerprint: text('request_fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    httpStatus: integer('http_status').notNull(),
    bodyBytes: integer('body_bytes').notNull(),
    processingToken: text('processing_token'),
    processingHeartbeatAt: text('processing_heartbeat_at'),
    executionId: text('execution_id').references(() => triggerExecutions.id, {
      onDelete: 'set null',
    }),
    errorCode: text('error_code'),
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at'),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => ({
    triggerReceivedIdx: index('idx_webhook_deliveries_trigger_received').on(
      table.triggerId,
      table.receivedAt,
      table.id
    ),
    idempotencyUnique: uniqueIndex('idx_webhook_deliveries_trigger_idempotency')
      .on(table.triggerId, table.idempotencyKeyHash)
      .where(sql`idempotency_key_hash IS NOT NULL`),
    expiresIdx: index('idx_webhook_deliveries_expires').on(table.expiresAt),
    executionIdx: index('idx_webhook_deliveries_execution').on(table.executionId),
    processingHeartbeatIdx: index('idx_webhook_deliveries_processing_heartbeat')
      .on(table.processingHeartbeatAt, table.id)
      .where(sql`outcome = 'processing' AND processing_token IS NOT NULL`),
  })
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDeliveryRow = typeof webhookDeliveries.$inferInsert;

// =============================================================================
// Platform Credentials (admin-managed fallback keys)
//
// Unlike user `credentials`, these are shared across all users and managed by
// admins. They serve as fallbacks when a user doesn't have their own credential
// for a given provider or agent type. Encrypted with PLATFORM_CREDENTIAL_ENCRYPTION_KEY
// (falls back to ENCRYPTION_KEY if not set).
//
// createdBy uses a bare FK reference (no onDelete) because deleting the admin
// who created the credential should NOT remove a credential that serves all users.
// =============================================================================
export const platformCredentials = sqliteTable(
  'platform_credentials',
  {
    id: text('id').primaryKey(),
    credentialType: text('credential_type').notNull(), // 'cloud-provider' | 'agent-api-key'
    /** Null for agent-api-key type. Set to 'hetzner' | 'scaleway' | 'gcp' for cloud-provider type. */
    provider: text('provider'),
    /** Null for cloud-provider type. Set to 'claude-code' | 'openai-codex' for agent-api-key type. */
    agentType: text('agent_type'),
    credentialKind: text('credential_kind').notNull().default('api-key'), // 'api-key' | 'oauth-token'
    label: text('label').notNull(),
    /** AES-256-GCM ciphertext (base64). Decrypt via `services/encryption.ts:decrypt()`. */
    encryptedToken: text('encrypted_token').notNull(),
    /** AES-256-GCM initialization vector (base64, 12 bytes random per encryption). */
    iv: text('iv').notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    /** Admin user who created this credential. Bare FK — no onDelete to preserve shared credentials. */
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    /** Admin user who most recently rotated this credential. */
    updatedBy: text('updated_by').references(() => users.id),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    typeProviderIdx: index('idx_platform_credentials_type_provider')
      .on(table.credentialType, table.provider)
      .where(sql`credential_type = 'cloud-provider'`),
    typeAgentIdx: index('idx_platform_credentials_type_agent')
      .on(table.credentialType, table.agentType)
      .where(sql`credential_type = 'agent-api-key'`),
  })
);

export type PlatformCredentialRow = typeof platformCredentials.$inferSelect;
export type NewPlatformCredentialRow = typeof platformCredentials.$inferInsert;

// =============================================================================
// Compute Usage
// =============================================================================

/** Tracks workspace usage events that are aggregated to node-billed vCPU-hours for metering and quota enforcement. */
export const computeUsage = sqliteTable(
  'compute_usage',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Soft reference — no FK. Workspace/node may be destroyed while usage records are retained for billing. */
    workspaceId: text('workspace_id').notNull(),
    /** Soft reference — no FK. See workspaceId comment. */
    nodeId: text('node_id').notNull(),
    serverType: text('server_type').notNull(),
    vcpuCount: integer('vcpu_count').notNull(),
    credentialSource: text('credential_source').notNull().default('user'),
    startedAt: text('started_at').notNull(),
    /** ISO-8601 timestamp. Null while workspace is still running (open-ended usage record). */
    endedAt: text('ended_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    userPeriodIdx: index('idx_compute_usage_user_period').on(table.userId, table.startedAt),
    workspaceIdx: index('idx_compute_usage_workspace').on(table.workspaceId),
  })
);

export type ComputeUsageRow = typeof computeUsage.$inferSelect;
export type NewComputeUsageRow = typeof computeUsage.$inferInsert;

// =============================================================================
// Compute Quotas
// =============================================================================

/** Platform-wide default quota (singleton row). Null limit means unlimited. */
export const defaultQuotas = sqliteTable('default_quotas', {
  id: text('id').primaryKey(),
  /** Null = unlimited. Applies to all users who don't have a per-user override in userQuotas. */
  monthlyVcpuHoursLimit: real('monthly_vcpu_hours_limit'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  /** Admin who last updated. Bare FK — no onDelete to preserve audit trail. */
  updatedBy: text('updated_by')
    .notNull()
    .references(() => users.id),
});

export type DefaultQuotaRow = typeof defaultQuotas.$inferSelect;

/** Per-user quota overrides set by admin. Takes precedence over defaultQuotas. */
export const userQuotas = sqliteTable('user_quotas', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }), // Cascade — quota meaningless without the user
  /** Null = unlimited (overrides any default limit). */
  monthlyVcpuHoursLimit: real('monthly_vcpu_hours_limit'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  /** Admin who last updated. Bare FK — no onDelete to preserve audit trail. */
  updatedBy: text('updated_by')
    .notNull()
    .references(() => users.id),
});

export type UserQuotaRow = typeof userQuotas.$inferSelect;

// =============================================================================
// Trial Onboarding — Waitlist
// =============================================================================

/**
 * Cap-exceeded trial signups. One row per (email, resetDate). The monthly
 * notifier cron marks `notifiedAt` when the reset window opens and an email
 * is sent. See docs/guides/trial-configuration.md.
 */
export const trialWaitlist = sqliteTable(
  'trial_waitlist',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    submittedAt: integer('submitted_at').notNull(), // epoch ms
    resetDate: text('reset_date').notNull(), // 'YYYY-MM-01' UTC
    notifiedAt: integer('notified_at'), // epoch ms, nullable
  },
  (table) => ({
    emailResetIdx: uniqueIndex('idx_trial_waitlist_email_reset').on(table.email, table.resetDate),
    resetNotifyIdx: index('idx_trial_waitlist_reset_notify').on(table.resetDate, table.notifiedAt),
  })
);

export type TrialWaitlistRow = typeof trialWaitlist.$inferSelect;
export type NewTrialWaitlistRow = typeof trialWaitlist.$inferInsert;

// =============================================================================
// Trial Onboarding — Trial records
// =============================================================================

/**
 * Anonymous trial records. One row per trial lifecycle, created on
 * POST /api/trial/create before the project row is provisioned. The
 * orchestrator populates `projectId` once provisioning completes.
 *
 * Status state machine:
 *   pending -> ready | failed | expired
 *   ready   -> claimed | expired
 *   failed  -> (terminal)
 *   expired -> (terminal; reaped by retention cron)
 *   claimed -> (terminal; project.user_id now points to the claimant)
 *
 * `monthKey` mirrors the TrialCounter DO keyspace ('YYYY-MM' UTC) and is
 * used for decrement-on-failure and for the monthly rollover audit.
 */
export const trials = sqliteTable(
  'trials',
  {
    id: text('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    repoUrl: text('repo_url').notNull(),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    monthKey: text('month_key').notNull(),
    status: text('status').notNull().default('pending'),
    projectId: text('project_id'),
    claimedByUserId: text('claimed_by_user_id'),
    createdAt: integer('created_at').notNull(), // epoch ms
    expiresAt: integer('expires_at').notNull(), // epoch ms
    claimedAt: integer('claimed_at'), // epoch ms, nullable
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (table) => ({
    fingerprintIdx: index('idx_trials_fingerprint').on(table.fingerprint, table.createdAt),
    statusExpiryIdx: index('idx_trials_status_expiry').on(table.status, table.expiresAt),
    monthKeyStatusIdx: index('idx_trials_month_key_status').on(table.monthKey, table.status),
  })
);

export type TrialRow = typeof trials.$inferSelect;
export type NewTrialRow = typeof trials.$inferInsert;

// =============================================================================
// Session Summaries (D1 read-optimized index for cross-project session queries)
// =============================================================================

export const sessionSummaries = sqliteTable(
  'session_summaries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    topic: text('topic'),
    taskId: text('task_id'),
    workspaceId: text('workspace_id'),
    messageCount: integer('message_count').notNull().default(0),
    startedAt: integer('started_at').notNull(),
    lastMessageAt: integer('last_message_at'),
    agentCompletedAt: integer('agent_completed_at'),
    endedAt: integer('ended_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    userRecentIdx: index('idx_session_summaries_user_recent').on(
      table.userId,
      table.status,
      table.updatedAt
    ),
    projectIdx: index('idx_session_summaries_project').on(table.projectId, table.updatedAt),
  })
);

export type SessionSummaryRow = typeof sessionSummaries.$inferSelect;
export type NewSessionSummaryRow = typeof sessionSummaries.$inferInsert;

// =============================================================================
// DEPLOYMENT ENVIRONMENTS
// =============================================================================

export const deploymentEnvironments = sqliteTable(
  'deployment_environments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    /** Deployment node hosting this environment; many environments may share one node. */
    nodeId: text('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** True when the latest submitted manifest declares persistent volumes. */
    requiresVolumes: integer('requires_volumes', { mode: 'boolean' }).notNull().default(false),
    /** Cloud provider used for placement (e.g. 'hetzner', 'scaleway'). */
    provider: text('provider'),
    /** Provider location/region for placement constraint. */
    location: text('location'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByAgentProfileId: text('created_by_agent_profile_id').references(
      () => agentProfiles.id,
      {
        onDelete: 'set null',
      }
    ),
    createdByTaskId: text('created_by_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    createdByWorkspaceId: text('created_by_workspace_id'),
    creationSource: text('creation_source').notNull().default('user'),
    secretsUpdatedAt: text('secrets_updated_at'),
    configUpdatedAt: text('config_updated_at'),
    /** Latest deployment state observed from the authenticated deployment node. */
    observedAppliedSeq: integer('observed_applied_seq'),
    observedStatus: text('observed_status'),
    observedErrorMessage: text('observed_error_message'),
    observedServicesJson: text('observed_services_json'),
    observedDeployStatusJson: text('observed_deploy_status_json'),
    observedDiskTelemetryJson: text('observed_disk_telemetry_json'),
    /** Desired and observed route-only Caddy configuration revision. */
    desiredRoutingRevision: integer('desired_routing_revision').notNull().default(0),
    observedRoutingRevision: integer('observed_routing_revision').notNull().default(0),
    observedRoutingStatus: text('observed_routing_status'),
    observedRoutingError: text('observed_routing_error'),
    observedRoutingAt: text('observed_routing_at'),
    observedAt: text('observed_at'),
    /** User-controlled gate for agent-facing app-deployment tools. */
    agentDeployEnabled: integer('agent_deploy_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    offboardingStatus: text('offboarding_status'),
    agentDeployEnabledBy: text('agent_deploy_enabled_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    agentDeployEnabledAt: text('agent_deploy_enabled_at'),
    agentDeployDisabledAt: text('agent_deploy_disabled_at'),
    allowedDeployProfileIdsJson: text('allowed_deploy_profile_ids_json'),
  },
  (table) => ({
    projectNameUnique: uniqueIndex('idx_deployment_environments_project_name').on(
      table.projectId,
      table.name
    ),
    projectIdIdx: index('idx_deployment_environments_project_id').on(table.projectId),
    nodeIdIdx: index('idx_deployment_environments_node_id').on(table.nodeId),
    observedStatusIdx: index('idx_deployment_environments_observed_status').on(
      table.observedStatus
    ),
    routingRevisionIdx: index('idx_deployment_environments_routing_revision').on(
      table.desiredRoutingRevision,
      table.observedRoutingRevision
    ),
    agentDeployEnabledIdx: index('idx_deployment_environments_agent_deploy_enabled').on(
      table.agentDeployEnabled
    ),
    createdByAgentProfileIdx: index('idx_deployment_environments_created_by_agent_profile').on(
      table.createdByAgentProfileId
    ),
    creationSourceIdx: index('idx_deployment_environments_creation_source').on(
      table.creationSource
    ),
  })
);

export type DeploymentEnvironmentRow = typeof deploymentEnvironments.$inferSelect;
export type NewDeploymentEnvironmentRow = typeof deploymentEnvironments.$inferInsert;

// =============================================================================
// DEPLOYMENT SECRETS
// =============================================================================

export const deploymentSecrets = sqliteTable(
  'deployment_secrets',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    iv: text('iv').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    envNameUnique: uniqueIndex('idx_deployment_secrets_env_name').on(
      table.environmentId,
      table.name
    ),
    environmentIdIdx: index('idx_deployment_secrets_environment_id').on(table.environmentId),
  })
);

export type DeploymentSecretRow = typeof deploymentSecrets.$inferSelect;
export type NewDeploymentSecretRow = typeof deploymentSecrets.$inferInsert;

// =============================================================================
// DEPLOYMENT ENVIRONMENT CONFIG VARS
// =============================================================================

/** Per-deployment-environment Compose interpolation variables.
 *  Secret values are AES-256-GCM encrypted; non-secret values are stored in plaintext. */
export const deploymentEnvironmentConfigVars = sqliteTable(
  'deployment_environment_config_vars',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    envKey: text('env_key').notNull(),
    /** When isSecret=true: AES-256-GCM ciphertext (base64). When isSecret=false: plaintext value. */
    storedValue: text('stored_value').notNull(),
    /** AES-256-GCM IV (base64). Null when isSecret=false (value stored in plaintext). */
    valueIv: text('value_iv'),
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    envKeyUnique: uniqueIndex('idx_deployment_environment_config_vars_env_key').on(
      table.environmentId,
      table.envKey
    ),
    environmentIdIdx: index('idx_deployment_environment_config_vars_environment_id').on(
      table.environmentId
    ),
  })
);

export type DeploymentEnvironmentConfigVarRow = typeof deploymentEnvironmentConfigVars.$inferSelect;
export type NewDeploymentEnvironmentConfigVarRow =
  typeof deploymentEnvironmentConfigVars.$inferInsert;

// =============================================================================
// DEPLOYMENT RELEASES
// =============================================================================

export const deploymentReleases = sqliteTable(
  'deployment_releases',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    manifest: text('manifest').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('created'),
    // Discriminator for how the release was produced (migration 0073).
    // NULL / 'build-on-node' = manifest is a DeploymentManifest.
    // 'compose-publish' = manifest is a captured `docker compose publish`
    //   ReleaseSubmission (compose YAML + image-digests + pushed service refs).
    source: text('source'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    environmentIdIdx: index('idx_deployment_releases_environment_id').on(table.environmentId),
    envVersionUnique: uniqueIndex('idx_deployment_releases_env_version').on(
      table.environmentId,
      table.version
    ),
    sourceIdx: index('idx_deployment_releases_source').on(table.source),
  })
);

export type DeploymentReleaseRow = typeof deploymentReleases.$inferSelect;
export type NewDeploymentReleaseRow = typeof deploymentReleases.$inferInsert;

// =============================================================================
// DEPLOYMENT PUBLISH JOBS
// =============================================================================

export const deploymentPublishJobs = sqliteTable(
  'deployment_publish_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    taskId: text('task_id'),
    agentProfileId: text('agent_profile_id'),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    environmentName: text('environment_name').notNull(),
    reference: text('reference').notNull().default('latest'),
    workingDir: text('working_dir'),
    sourceDir: text('source_dir'),
    status: text('status').notNull().default('queued'),
    currentStep: text('current_step'),
    releaseId: text('release_id').references(() => deploymentReleases.id, {
      onDelete: 'set null',
    }),
    releaseVersion: integer('release_version'),
    releaseStatus: text('release_status'),
    errorMessage: text('error_message'),
    errorCode: text('error_code'),
    retryable: integer('retryable', { mode: 'boolean' }).notNull().default(false),
    attempt: integer('attempt').notNull().default(1),
    lastEventAt: text('last_event_at'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectCreatedAtIdx: index('idx_deployment_publish_jobs_project_created_at').on(
      table.projectId,
      table.createdAt
    ),
    environmentCreatedAtIdx: index('idx_deployment_publish_jobs_environment_created_at').on(
      table.environmentId,
      table.createdAt
    ),
    workspaceCreatedAtIdx: index('idx_deployment_publish_jobs_workspace_created_at').on(
      table.workspaceId,
      table.createdAt
    ),
    statusUpdatedAtIdx: index('idx_deployment_publish_jobs_status_updated_at').on(
      table.status,
      table.updatedAt
    ),
    releaseIdIdx: index('idx_deployment_publish_jobs_release_id').on(table.releaseId),
  })
);

export type DeploymentPublishJobRow = typeof deploymentPublishJobs.$inferSelect;
export type NewDeploymentPublishJobRow = typeof deploymentPublishJobs.$inferInsert;

export const deploymentPublishJobEvents = sqliteTable(
  'deployment_publish_job_events',
  {
    id: text('id').primaryKey(),
    publishJobId: text('publish_job_id')
      .notNull()
      .references(() => deploymentPublishJobs.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** Immutable node identifier for event history when node FK semantics change. */
    nodeIdentifier: text('node_identifier'),
    workspaceId: text('workspace_id').notNull(),
    seq: integer('seq').notNull(),
    level: text('level').notNull().default('info'),
    eventType: text('event_type').notNull(),
    step: text('step'),
    message: text('message').notNull(),
    detailJson: text('detail_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    jobSeqUnique: uniqueIndex('idx_deployment_publish_job_events_job_seq').on(
      table.publishJobId,
      table.seq
    ),
    projectCreatedAtIdx: index('idx_deployment_publish_job_events_project_created_at').on(
      table.projectId,
      table.createdAt
    ),
    environmentCreatedAtIdx: index('idx_deployment_publish_job_events_environment_created_at').on(
      table.environmentId,
      table.createdAt
    ),
  })
);

export type DeploymentPublishJobEventRow = typeof deploymentPublishJobEvents.$inferSelect;
export type NewDeploymentPublishJobEventRow = typeof deploymentPublishJobEvents.$inferInsert;

export const deploymentReleaseEvents = sqliteTable(
  'deployment_release_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').references(() => deploymentReleases.id, {
      onDelete: 'cascade',
    }),
    releaseVersion: integer('release_version'),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** Immutable node identifier for event history when node FK semantics change. */
    nodeIdentifier: text('node_identifier'),
    seq: integer('seq').notNull(),
    level: text('level').notNull().default('info'),
    eventType: text('event_type').notNull(),
    step: text('step'),
    message: text('message').notNull(),
    detailJson: text('detail_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    releaseSeqIdx: index('idx_deployment_release_events_release_seq').on(
      table.releaseId,
      table.seq
    ),
    environmentCreatedAtIdx: index('idx_deployment_release_events_environment_created_at').on(
      table.environmentId,
      table.createdAt
    ),
    nodeCreatedAtIdx: index('idx_deployment_release_events_node_created_at').on(
      table.nodeId,
      table.createdAt
    ),
  })
);

export type DeploymentReleaseEventRow = typeof deploymentReleaseEvents.$inferSelect;
export type NewDeploymentReleaseEventRow = typeof deploymentReleaseEvents.$inferInsert;

// =============================================================================
// DEPLOYMENT VOLUMES
// =============================================================================

export const deploymentVolumes = sqliteTable(
  'deployment_volumes',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    providerVolumeId: text('provider_volume_id').notNull(),
    providerName: text('provider_name').notNull(),
    sizeGb: integer('size_gb').notNull(),
    location: text('location').notNull(),
    status: text('status').notNull().default('available'),
    attachedServerId: text('attached_server_id'),
    linuxDevice: text('linux_device'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    envNameUnique: uniqueIndex('idx_deployment_volumes_env_name').on(
      table.environmentId,
      table.name
    ),
    environmentIdIdx: index('idx_deployment_volumes_environment_id').on(table.environmentId),
  })
);

export type DeploymentVolumeRow = typeof deploymentVolumes.$inferSelect;
export type NewDeploymentVolumeRow = typeof deploymentVolumes.$inferInsert;

// =============================================================================
// DEPLOYMENT CUSTOM DOMAINS (migration 0076)
// =============================================================================
// A user-owned subdomain attached to an existing public route of an
// environment. SAM verifies the hostname resolves to the route target via
// Cloudflare DoH, then emits an additional Caddy site block (same hostPort as
// the parent public route) in the signed ApplyPayload. SAM does NOT create the
// user's DNS record.

export const deploymentCustomDomains = sqliteTable(
  'deployment_custom_domains',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    /** Service name of the parent public route this domain attaches to. */
    service: text('service').notNull(),
    /** Container port of the parent public route. */
    port: integer('port').notNull(),
    /** Zero-based route index of the parent public route within the manifest. */
    routeIndex: integer('route_index').notNull(),
    /** The user's custom hostname (e.g. app.theircompany.com). */
    hostname: text('hostname').notNull(),
    /** 'pending' | 'verified' | 'failed'. */
    verificationStatus: text('verification_status').notNull().default('pending'),
    /** Human-readable reason the last verification attempt failed. */
    verificationError: text('verification_error'),
    verifiedAt: text('verified_at'),
    /** SAM-owned generated hostname this domain resolved to when verified. */
    verifiedCnameTarget: text('verified_cname_target'),
    /** 'active' | 'deactivating' | 'deleted'. */
    desiredState: text('desired_state').notNull().default('active'),
    /** Route-application lifecycle status exposed separately from DNS status. */
    routingStatus: text('routing_status').notNull().default('pending_dns'),
    activationRoutingRevision: integer('activation_routing_revision'),
    deactivationRoutingRevision: integer('deactivation_routing_revision'),
    deletedAt: text('deleted_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    hostnameUnique: uniqueIndex('idx_deployment_custom_domains_hostname').on(table.hostname),
    environmentIdIdx: index('idx_deployment_custom_domains_environment_id').on(table.environmentId),
    environmentStateIdx: index('idx_deployment_custom_domains_environment_state').on(
      table.environmentId,
      table.desiredState,
      table.routingStatus
    ),
    activationRevisionIdx: index('idx_deployment_custom_domains_activation_revision').on(
      table.environmentId,
      table.activationRoutingRevision
    ),
    deactivationRevisionIdx: index('idx_deployment_custom_domains_deactivation_revision').on(
      table.environmentId,
      table.deactivationRoutingRevision
    ),
  })
);

export type DeploymentCustomDomainRow = typeof deploymentCustomDomains.$inferSelect;
export type NewDeploymentCustomDomainRow = typeof deploymentCustomDomains.$inferInsert;

export const deploymentCustomDomainEvents = sqliteTable(
  'deployment_custom_domain_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
    customDomainId: text('custom_domain_id').references(() => deploymentCustomDomains.id, {
      onDelete: 'set null',
    }),
    hostname: text('hostname').notNull(),
    nodeId: text('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    nodeIdentifier: text('node_identifier'),
    routingRevision: integer('routing_revision'),
    eventType: text('event_type').notNull(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    detailJson: text('detail_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    environmentCreatedAtIdx: index('idx_deployment_custom_domain_events_environment_created_at').on(
      table.environmentId,
      table.createdAt
    ),
    domainCreatedAtIdx: index('idx_deployment_custom_domain_events_domain_created_at').on(
      table.customDomainId,
      table.createdAt
    ),
    nodeCreatedAtIdx: index('idx_deployment_custom_domain_events_node_created_at').on(
      table.nodeIdentifier,
      table.createdAt
    ),
  })
);

export type DeploymentCustomDomainEventRow = typeof deploymentCustomDomainEvents.$inferSelect;
export type NewDeploymentCustomDomainEventRow = typeof deploymentCustomDomainEvents.$inferInsert;

// =============================================================================
// Composable Credentials — three-primitive model (migration 0071)
// =============================================================================

export const ccCredentials = sqliteTable(
  'cc_credentials',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // 'api-key' | 'oauth-token' | 'openai-compatible' | 'cloud-provider' | 'auth-json'
    encryptedToken: text('encrypted_token').notNull(),
    iv: text('iv').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    ownerIdx: index('idx_cc_credentials_owner').on(table.ownerId),
    ownerKindIdx: index('idx_cc_credentials_owner_kind').on(table.ownerId, table.kind),
  })
);

export type CCCredentialRow = typeof ccCredentials.$inferSelect;
export type NewCCCredentialRow = typeof ccCredentials.$inferInsert;

export const ccConfigurations = sqliteTable(
  'cc_configurations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    consumerKind: text('consumer_kind').notNull(), // 'agent' | 'compute'
    consumerTarget: text('consumer_target').notNull(), // 'claude-code' | 'hetzner' etc.
    credentialId: text('credential_id').references(() => ccCredentials.id, {
      onDelete: 'set null',
    }),
    settingsJson: text('settings_json'), // JSON blob
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    ownerIdx: index('idx_cc_configurations_owner').on(table.ownerId),
    credentialIdx: index('idx_cc_configurations_credential').on(table.credentialId),
  })
);

export type CCConfigurationRow = typeof ccConfigurations.$inferSelect;
export type NewCCConfigurationRow = typeof ccConfigurations.$inferInsert;

export const ccAttachments = sqliteTable(
  'cc_attachments',
  {
    id: text('id').primaryKey(),
    configurationId: text('configuration_id')
      .notNull()
      .references(() => ccConfigurations.id, { onDelete: 'cascade' }),
    consumerKind: text('consumer_kind').notNull(),
    consumerTarget: text('consumer_target').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    userIdx: index('idx_cc_attachments_user').on(table.userId),
    userConsumerIdx: index('idx_cc_attachments_user_consumer').on(
      table.userId,
      table.consumerKind,
      table.consumerTarget
    ),
    projectIdx: index('idx_cc_attachments_project').on(
      table.userId,
      table.projectId,
      table.consumerKind,
      table.consumerTarget
    ),
    configIdx: index('idx_cc_attachments_config').on(table.configurationId),
  })
);

export type CCAttachmentRow = typeof ccAttachments.$inferSelect;
export type NewCCAttachmentRow = typeof ccAttachments.$inferInsert;
