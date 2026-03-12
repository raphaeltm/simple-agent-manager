/**
 * Regression test: workspaces.chatSessionId must have a unique index.
 *
 * Without this constraint, multiple workspaces can share the same chatSessionId,
 * causing non-deterministic message routing for follow-up prompts.
 * See: tasks/active/2026-03-03-fix-chat-session-message-leakage.md (Bug 5)
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { workspaces } from '../../../src/db/schema';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('workspaces.chatSessionId unique constraint', () => {
  it('has a unique index defined in Drizzle schema', () => {
    const config = getTableConfig(workspaces);
    const chatSessionIdIndex = config.indexes.find(
      (idx) => idx.config.name === 'idx_workspaces_chat_session_id_unique'
    );
    expect(chatSessionIdIndex).toBeDefined();
    expect(chatSessionIdIndex!.config.unique).toBe(true);
  });

  it('has a corresponding D1 migration file', () => {
    const migrationsDir = join(__dirname, '../../../src/db/migrations');
    const files = readdirSync(migrationsDir);
    const migrationFile = files.find((f) => f.includes('unique_chat_session_id'));
    expect(migrationFile).toBeDefined();

    const content = readFileSync(join(migrationsDir, migrationFile!), 'utf-8');
    expect(content).toContain('CREATE UNIQUE INDEX');
    expect(content).toContain('chat_session_id');
    expect(content).toContain('WHERE chat_session_id IS NOT NULL');
  });
});
