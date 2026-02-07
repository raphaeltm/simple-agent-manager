import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
export const sessions = sqliteTable('sessions', {
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
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => ({
  userIdIdx: index('idx_sessions_user_id').on(table.userId),
}));

// =============================================================================
// Accounts (BetterAuth OAuth providers)
// =============================================================================
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
}, (table) => ({
  userIdIdx: index('idx_accounts_user_id').on(table.userId),
}));

// =============================================================================
// Verifications (BetterAuth)
// =============================================================================
export const verifications = sqliteTable('verifications', {
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
}, (table) => ({
  identifierIdx: index('idx_verifications_identifier').on(table.identifier),
}));

// =============================================================================
// Credentials (encrypted cloud provider tokens and agent API keys)
// =============================================================================
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  credentialType: text('credential_type').notNull().default('cloud-provider'),
  agentType: text('agent_type'),
  encryptedToken: text('encrypted_token').notNull(),
  iv: text('iv').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userCredentialTypeAgent: uniqueIndex('idx_credentials_user_type_agent')
    .on(table.userId, table.credentialType, table.agentType),
}));

// =============================================================================
// GitHub App Installations
// =============================================================================
export const githubInstallations = sqliteTable('github_installations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull().unique(),
  accountType: text('account_type').notNull(),
  accountName: text('account_name').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// Workspaces
// =============================================================================
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').references(() => githubInstallations.id),
  name: text('name').notNull(),
  repository: text('repository').notNull(),
  branch: text('branch').notNull().default('main'),
  status: text('status').notNull().default('pending'),
  vmSize: text('vm_size').notNull(),
  vmLocation: text('vm_location').notNull(),
  hetznerServerId: text('hetzner_server_id'),
  vmIp: text('vm_ip'),
  dnsRecordId: text('dns_record_id'),
  lastActivityAt: text('last_activity_at'),
  errorMessage: text('error_message'),
  shutdownDeadline: text('shutdown_deadline'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// UI Governance
// =============================================================================
export const uiStandards = sqliteTable('ui_standards', {
  id: text('id').primaryKey(),
  version: text('version').notNull().unique(),
  status: text('status').notNull(),
  name: text('name').notNull(),
  visualDirection: text('visual_direction').notNull(),
  mobileFirstRulesRef: text('mobile_first_rules_ref').notNull(),
  accessibilityRulesRef: text('accessibility_rules_ref').notNull(),
  ownerRole: text('owner_role').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  statusIdx: index('idx_ui_standards_status').on(table.status),
}));

export const themeTokens = sqliteTable('theme_tokens', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  tokenNamespace: text('token_namespace').notNull(),
  tokenName: text('token_name').notNull(),
  tokenValue: text('token_value').notNull(),
  mode: text('mode').notNull().default('default'),
  isDeprecated: integer('is_deprecated', { mode: 'boolean' }).notNull().default(false),
  replacementToken: text('replacement_token'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_theme_tokens_standard_id').on(table.standardId),
}));

export const componentDefinitions = sqliteTable('component_definitions', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  category: text('category').notNull(),
  supportedSurfacesJson: text('supported_surfaces_json').notNull(),
  requiredStatesJson: text('required_states_json').notNull(),
  usageGuidance: text('usage_guidance').notNull(),
  accessibilityNotes: text('accessibility_notes').notNull(),
  mobileBehavior: text('mobile_behavior').notNull(),
  desktopBehavior: text('desktop_behavior').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_component_defs_standard_id').on(table.standardId),
}));

export const complianceChecklists = sqliteTable('compliance_checklists', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  itemsJson: text('items_json').notNull(),
  appliesToJson: text('applies_to_json').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  publishedAt: text('published_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_checklists_standard_id').on(table.standardId),
}));

export const agentInstructionSets = sqliteTable('agent_instruction_sets', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  instructionBlocksJson: text('instruction_blocks_json').notNull(),
  examplesRef: text('examples_ref'),
  requiredChecklistVersion: text('required_checklist_version').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_instruction_sets_standard_id').on(table.standardId),
}));

export const exceptionRequests = sqliteTable('exception_requests', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  requestedBy: text('requested_by').notNull(),
  rationale: text('rationale').notNull(),
  scope: text('scope').notNull(),
  expirationDate: text('expiration_date').notNull(),
  approver: text('approver'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_exception_requests_standard_id').on(table.standardId),
}));

export const complianceRuns = sqliteTable('compliance_runs', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  checklistVersion: text('checklist_version').notNull(),
  authorType: text('author_type').notNull(),
  changeRef: text('change_ref').notNull(),
  status: text('status').notNull(),
  findingsJson: text('findings_json'),
  reviewedBy: text('reviewed_by'),
  exceptionRequestId: text('exception_request_id').references(() => exceptionRequests.id, { onDelete: 'set null' }),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_compliance_runs_standard_id').on(table.standardId),
}));

export const migrationWorkItems = sqliteTable('migration_work_items', {
  id: text('id').primaryKey(),
  standardId: text('standard_id').notNull().references(() => uiStandards.id, { onDelete: 'cascade' }),
  surface: text('surface').notNull(),
  targetRef: text('target_ref').notNull(),
  priority: text('priority').notNull(),
  status: text('status').notNull(),
  owner: text('owner').notNull(),
  dueMilestone: text('due_milestone'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  standardIdIdx: index('idx_migration_items_standard_id').on(table.standardId),
}));

// Type exports for inference
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
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
