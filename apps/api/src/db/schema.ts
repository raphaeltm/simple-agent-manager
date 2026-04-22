// FILE SIZE EXCEPTION: Database schema — splitting creates import complexity. See .claude/rules/18-file-size-limits.md
//
// =============================================================================
// SCHEMA DOCUMENTATION
// =============================================================================
//
// Timestamp conventions:
//   - BetterAuth tables (users, sessions, accounts, verifications, agentSettings,
//     smokeTestTokens) use `integer('...', { mode: 'timestamp_ms' })` which stores
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
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
export const githubInstallations = sqliteTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
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
    userInstallationIdx: uniqueIndex('idx_github_installations_user_installation').on(
      table.userId,
      table.installationId
    ),
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
    projectKeyUnique: uniqueIndex('idx_project_runtime_env_project_key').on(table.projectId, table.envKey),
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
    userProjectIdx: index('idx_project_runtime_files_user_project').on(table.userId, table.projectId),
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
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    errorMessage: text('error_message'),
    outputSummary: text('output_summary'),
    outputBranch: text('output_branch'),
    outputPrUrl: text('output_pr_url'),
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
    agentCredentialSource: text('agent_credential_source').default('user'), // 'user' | 'platform'
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
    taskCreatedAtIdx: index('idx_task_status_events_task_created_at').on(table.taskId, table.createdAt),
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
    healthStatus: text('health_status').notNull().default('unhealthy'),
    heartbeatStaleAfterSeconds: integer('heartbeat_stale_after_seconds').notNull().default(180),
    lastMetrics: text('last_metrics'),
    /** ISO-8601 timestamp when node entered warm pool. Null if node is not warm. Used by NodeLifecycle DO for timeout. */
    warmSince: text('warm_since'),
    /** 'user' = provisioned with user's own credential; 'platform' = provisioned with platform credential. */
    credentialSource: text('credential_source').default('user'),
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
    errorMessage: text('error_message'),
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
    // Compound index for filtered session queries (P2 fix).
    workspaceUserStatusIdx: index('idx_agent_sessions_ws_user_status').on(
      table.workspaceId,
      table.userId,
      table.status
    ),
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
    /** OpenCode inference provider: 'platform' | 'scaleway' | 'google-vertex' | 'openai-compatible' | 'anthropic' | 'custom'. null = use default. */
    opencodeProvider: text('opencode_provider'),
    /** Base URL for custom/openai-compatible OpenCode providers. */
    opencodeBaseUrl: text('opencode_base_url'),
    /** Display name for custom OpenCode providers. */
    opencodeProviderName: text('opencode_provider_name'),
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
    permissionMode: text('permission_mode'),
    systemPromptAppend: text('system_prompt_append'),
    maxTurns: integer('max_turns'),
    timeoutMinutes: integer('timeout_minutes'),
    vmSizeOverride: text('vm_size_override'),
    provider: text('provider'),
    vmLocation: text('vm_location'),
    workspaceProfile: text('workspace_profile'),
    /** Devcontainer config name override. null = inherit from project/platform defaults. */
    devcontainerConfigName: text('devcontainer_config_name'),
    taskMode: text('task_mode'),
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
    projectNameUnique: uniqueIndex('idx_agent_profiles_project_name')
      .on(table.projectId, table.name),
    projectIdIdx: index('idx_agent_profiles_project_id').on(table.projectId),
    userIdIdx: index('idx_agent_profiles_user_id').on(table.userId),
  })
);

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type NewAgentProfileRow = typeof agentProfiles.$inferInsert;

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
export type ProjectRuntimeEnvVar = typeof projectRuntimeEnvVars.$inferSelect;
export type NewProjectRuntimeEnvVar = typeof projectRuntimeEnvVars.$inferInsert;
export type ProjectRuntimeFile = typeof projectRuntimeFiles.$inferSelect;
export type NewProjectRuntimeFile = typeof projectRuntimeFiles.$inferInsert;
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
// Smoke Test Auth Tokens (CI authentication, gated by SMOKE_TEST_AUTH_ENABLED)
// =============================================================================
export const smokeTestTokens = sqliteTable(
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

export type SmokeTestToken = typeof smokeTestTokens.$inferSelect;
export type NewSmokeTestToken = typeof smokeTestTokens.$inferInsert;

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
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectIdx: index('idx_project_files_project_id').on(table.projectId),
    projectStatusIdx: index('idx_project_files_project_status').on(table.projectId, table.status),
    projectSourceIdx: index('idx_project_files_project_source').on(table.projectId, table.uploadSource),
    projectMimeIdx: index('idx_project_files_project_mime').on(table.projectId, table.mimeType),
    projectDirFilenameUniq: uniqueIndex('idx_project_files_project_dir_filename').on(table.projectId, table.directory, table.filename),
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
    taskMode: text('task_mode').default('task'),
    vmSizeOverride: text('vm_size_override'),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    lastTriggeredAt: text('last_triggered_at'),
    triggerCount: integer('trigger_count').notNull().default(0),
    nextFireAt: text('next_fire_at'),
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
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    userPeriodIdx: index('idx_compute_usage_user_period').on(
      table.userId,
      table.startedAt
    ),
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
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
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
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
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
    emailResetIdx: uniqueIndex('idx_trial_waitlist_email_reset').on(
      table.email,
      table.resetDate
    ),
    resetNotifyIdx: index('idx_trial_waitlist_reset_notify').on(
      table.resetDate,
      table.notifiedAt
    ),
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
    fingerprintIdx: index('idx_trials_fingerprint').on(
      table.fingerprint,
      table.createdAt
    ),
    statusExpiryIdx: index('idx_trials_status_expiry').on(
      table.status,
      table.expiresAt
    ),
    monthKeyStatusIdx: index('idx_trials_month_key_status').on(
      table.monthKey,
      table.status
    ),
  })
);

export type TrialRow = typeof trials.$inferSelect;
export type NewTrialRow = typeof trials.$inferInsert;

// =============================================================================
// Admin Platform Infrastructure Associations
// =============================================================================

/**
 * Operational association metadata for platform-funded nodes.
 *
 * This is explicitly NOT an ownership table. User-facing access control must
 * continue to flow through the canonical node/workspace ownership fields.
 */
export const platformNodeAssociations = sqliteTable(
  'platform_node_associations',
  {
    nodeId: text('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    associatedBy: text('associated_by')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_platform_node_associations_user_id').on(table.userId),
    reasonIdx: index('idx_platform_node_associations_reason').on(table.reason),
    reasonCheck: check(
      'platform_node_associations_reason_check',
      sql`${table.reason} in ('trial', 'support', 'migration', 'other')`
    ),
  })
);

export type PlatformNodeAssociationRow = typeof platformNodeAssociations.$inferSelect;
export type NewPlatformNodeAssociationRow = typeof platformNodeAssociations.$inferInsert;
