import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// Users (BetterAuth compatible + custom fields)
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
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// =============================================================================
// Sessions (BetterAuth)
// =============================================================================
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
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
  accessTokenExpiresAt: integer('access_token_expires_at'),
  refreshTokenExpiresAt: integer('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
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
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  identifierIdx: index('idx_verifications_identifier').on(table.identifier),
}));

// =============================================================================
// Credentials (encrypted cloud provider tokens)
// =============================================================================
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  encryptedToken: text('encrypted_token').notNull(),
  iv: text('iv').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

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

// Type exports for inference
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
