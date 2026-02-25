import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Observability D1 schema — stored in OBSERVABILITY_DATABASE (separate from main DATABASE).
 * See specs/023-admin-observability/data-model.md for entity definitions.
 */

// =============================================================================
// Platform Errors
// =============================================================================
export const platformErrors = sqliteTable(
  'platform_errors',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(), // 'client' | 'vm-agent' | 'api'
    level: text('level').notNull(), // 'error' | 'warn' | 'info'
    message: text('message').notNull(),
    stack: text('stack'),
    context: text('context'), // JSON string
    userId: text('user_id'),
    nodeId: text('node_id'),
    workspaceId: text('workspace_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    timestamp: integer('timestamp').notNull(), // millisecond epoch (client-reported time)
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(cast(unixepoch() * 1000 as integer))`),
  },
  (table) => ({
    timestampIdx: index('idx_platform_errors_timestamp').on(table.timestamp),
    sourceTimestampIdx: index('idx_platform_errors_source_timestamp').on(table.source, table.timestamp),
    levelTimestampIdx: index('idx_platform_errors_level_timestamp').on(table.level, table.timestamp),
    createdAtIdx: index('idx_platform_errors_created_at').on(table.createdAt),
  })
);

// Type exports for inference
export type PlatformErrorRow = typeof platformErrors.$inferSelect;
export type NewPlatformErrorRow = typeof platformErrors.$inferInsert;
