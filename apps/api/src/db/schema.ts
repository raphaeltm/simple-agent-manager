import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey,sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
// Credentials (encrypted cloud provider tokens and agent API keys)
// =============================================================================
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    credentialType: text('credential_type').notNull().default('cloud-provider'),
    agentType: text('agent_type'),
    credentialKind: text('credential_kind').notNull().default('api-key'), // 'api-key' | 'oauth-token'
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    encryptedToken: text('encrypted_token').notNull(),
    iv: text('iv').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userAgentKind: uniqueIndex('idx_credentials_user_agent_kind')
      .on(table.userId, table.agentType, table.credentialKind)
      .where(sql`credential_type = 'agent-api-key'`),
    activeCredential: index('idx_credentials_active')
      .on(table.userId, table.agentType, table.isActive)
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
    defaultVmSize: text('default_vm_size'),
    defaultAgentType: text('default_agent_type'),
    defaultWorkspaceProfile: text('default_workspace_profile'),
    defaultProvider: text('default_provider'),
    defaultLocation: text('default_location'),
    workspaceIdleTimeoutMs: integer('workspace_idle_timeout_ms'),
    nodeIdleTimeoutMs: integer('node_idle_timeout_ms'),
    // Per-project scaling parameters (null = use platform default)
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
    userInstallationRepoUnique: uniqueIndex('idx_projects_user_installation_repository').on(
      table.userId,
      table.installationId,
      table.repository
    ),
    userGithubRepoIdUnique: uniqueIndex('idx_projects_user_github_repo_id')
      .on(table.userId, table.githubRepoId)
      .where(sql`github_repo_id IS NOT NULL`),
  })
);

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
    storedValue: text('stored_value').notNull(),
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
    storedContent: text('stored_content').notNull(),
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
    parentTaskId: text('parent_task_id'),
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
    autoProvisionedNodeId: text('auto_provisioned_node_id').references(() => nodes.id, {
      onDelete: 'set null',
    }),
    /** Source that created this task. 'user' = manual, 'cron'/'webhook'/'mcp' = automated. */
    triggeredBy: text('triggered_by').notNull().default('user'),
    /** FK to the trigger that created this task (null for user-created tasks). */
    triggerId: text('trigger_id'),
    /** FK to the specific trigger execution that created this task. */
    triggerExecutionId: text('trigger_execution_id'),
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
    warmSince: text('warm_since'),
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
    nodeId: text('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    hetznerServerId: text('hetzner_server_id'),
    vmIp: text('vm_ip'),
    dnsRecordId: text('dns_record_id'),
    lastActivityAt: text('last_activity_at'),
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
// Agent Profiles (per-project role definitions)
// =============================================================================
export const agentProfiles = sqliteTable(
  'agent_profiles',
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
    permissionMode: text('permission_mode'),
    systemPromptAppend: text('system_prompt_append'),
    maxTurns: integer('max_turns'),
    timeoutMinutes: integer('timeout_minutes'),
    vmSizeOverride: text('vm_size_override'),
    provider: text('provider'),
    vmLocation: text('vm_location'),
    workspaceProfile: text('workspace_profile'),
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
// Project File Library (per-project encrypted file storage)
// =============================================================================
export const projectFiles = sqliteTable(
  'project_files',
  {
    id: text('id').primaryKey(),
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
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectIdx: index('idx_project_files_project_id').on(table.projectId),
    projectStatusIdx: index('idx_project_files_project_status').on(table.projectId, table.status),
    projectSourceIdx: index('idx_project_files_project_source').on(table.projectId, table.uploadSource),
    projectMimeIdx: index('idx_project_files_project_mime').on(table.projectId, table.mimeType),
    projectFilenameUniq: uniqueIndex('idx_project_files_project_filename').on(table.projectId, table.filename),
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
