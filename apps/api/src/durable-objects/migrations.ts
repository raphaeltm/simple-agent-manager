/**
 * Durable Object SQLite migration runner and migration definitions.
 *
 * Each project's Durable Object maintains its own SQLite database.
 * Migrations are tracked in a `migrations` table and run lazily
 * in the constructor via `blockConcurrencyWhile()`.
 *
 * See: specs/018-project-first-architecture/research.md (Decision 6)
 */

import { log } from '../lib/logger';
import { parseMigrationName } from './project-data/row-schemas';

export interface Migration {
  name: string;
  run: (sql: SqlStorage) => void;
}

/**
 * Ordered list of migrations. New migrations MUST be appended to the end.
 * Never remove or reorder existing migrations.
 */
export const MIGRATIONS: Migration[] = [
  {
    name: '001-initial-schema',
    run: (sql) => {
      // Chat sessions
      sql.exec(`
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          topic TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          message_count INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(`CREATE INDEX idx_chat_sessions_status ON chat_sessions(status)`);
      sql.exec(`CREATE INDEX idx_chat_sessions_started_at ON chat_sessions(started_at DESC)`);
      sql.exec(`CREATE INDEX idx_chat_sessions_workspace ON chat_sessions(workspace_id)`);

      // Chat messages (append-only)
      sql.exec(`
        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at)`
      );

      // Task status events (moved from D1 for per-project isolation)
      sql.exec(`
        CREATE TABLE task_status_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          reason TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_task_status_events_task ON task_status_events(task_id, created_at)`
      );

      // Activity events
      sql.exec(`
        CREATE TABLE activity_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          workspace_id TEXT,
          session_id TEXT,
          task_id TEXT,
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(`CREATE INDEX idx_activity_events_created ON activity_events(created_at DESC)`);
      sql.exec(
        `CREATE INDEX idx_activity_events_type ON activity_events(event_type, created_at DESC)`
      );
    },
  },
  {
    name: '002-add-task-id-to-sessions',
    run: (sql) => {
      sql.exec(`ALTER TABLE chat_sessions ADD COLUMN task_id TEXT`);
      sql.exec(`CREATE INDEX idx_chat_sessions_task_id ON chat_sessions(task_id)`);
    },
  },
  {
    name: '003-add-do-meta',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE do_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  },
  {
    name: '004-add-agent-completed-at',
    run: (sql) => {
      sql.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_completed_at INTEGER`);
    },
  },
  {
    name: '005-idle-cleanup-schedule',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE idle_cleanup_schedule (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_id TEXT,
          cleanup_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(`CREATE INDEX idx_idle_cleanup_schedule_cleanup_at ON idle_cleanup_schedule(cleanup_at)`);
    },
  },
  {
    name: '006-idle-cleanup-retry-count',
    run: (sql) => {
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    name: '007-add-message-sequence',
    run: (sql) => {
      // Add monotonic sequence column to fix ordering of messages with identical
      // created_at timestamps. Streaming chunks from Claude Code often arrive
      // within the same millisecond, causing undefined SQLite sort order.
      sql.exec(`ALTER TABLE chat_messages ADD COLUMN sequence INTEGER`);
      // Backfill existing rows: assign sequence based on rowid (insertion order).
      // DO SQLite does not auto-VACUUM, so rowid is stable.
      sql.exec(`UPDATE chat_messages SET sequence = rowid WHERE sequence IS NULL`);
      // Drop old index — now redundant since the new composite index covers
      // (session_id, created_at) as a prefix.
      sql.exec(`DROP INDEX IF EXISTS idx_chat_messages_session_created`);
      // New composite index for deterministic ordering
      sql.exec(
        `CREATE INDEX idx_chat_messages_session_seq ON chat_messages(session_id, created_at, sequence)`
      );
    },
  },
  {
    name: '008-acp-sessions',
    run: (sql) => {
      // ACP sessions — DO-owned session lifecycle (spec 027)
      sql.exec(`
        CREATE TABLE acp_sessions (
          id TEXT PRIMARY KEY,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          workspace_id TEXT,
          node_id TEXT,
          acp_sdk_session_id TEXT,
          parent_session_id TEXT REFERENCES acp_sessions(id),
          status TEXT NOT NULL DEFAULT 'pending',
          agent_type TEXT,
          initial_prompt TEXT,
          error_message TEXT,
          last_heartbeat_at INTEGER,
          fork_depth INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          assigned_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          interrupted_at INTEGER
        )
      `);
      sql.exec(`CREATE INDEX idx_acp_sessions_chat ON acp_sessions(chat_session_id)`);
      sql.exec(`CREATE INDEX idx_acp_sessions_workspace ON acp_sessions(workspace_id)`);
      sql.exec(`CREATE INDEX idx_acp_sessions_node ON acp_sessions(node_id)`);
      sql.exec(`CREATE INDEX idx_acp_sessions_parent ON acp_sessions(parent_session_id)`);
      sql.exec(`CREATE INDEX idx_acp_sessions_status ON acp_sessions(status)`);

      // ACP session events — audit log of state transitions
      sql.exec(`
        CREATE TABLE acp_session_events (
          id TEXT PRIMARY KEY,
          acp_session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
          from_status TEXT,
          to_status TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          reason TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_acp_session_events_session ON acp_session_events(acp_session_id, created_at)`
      );
    },
  },
  {
    name: '009-add-updated-at-index',
    run: (sql) => {
      // Index for ordering sessions by last activity (most recent messages first)
      sql.exec(`CREATE INDEX idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC)`);
    },
  },
  {
    name: '010-workspace-activity-tracking',
    run: (sql) => {
      // Track last terminal activity per workspace for idle detection.
      // Messages are tracked via chat_messages.created_at; terminal activity
      // needs a separate signal since terminal WebSocket traffic bypasses the DO.
      sql.exec(`
        CREATE TABLE workspace_activity (
          workspace_id TEXT PRIMARY KEY,
          session_id TEXT,
          last_terminal_activity_at INTEGER,
          last_message_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
    },
  },
  {
    name: '011-message-materialization-fts5',
    run: (sql) => {
      // Materialized grouped messages — concatenated streaming tokens per logical message.
      // Populated when a session stops; enables FTS5 full-text search across token boundaries.
      // Uses IF NOT EXISTS for idempotency against partial migration execution.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages_grouped (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_grouped_messages_session ON chat_messages_grouped(session_id, created_at)`
      );

      // FTS5 virtual table for full-text search on grouped message content.
      // content= links to chat_messages_grouped so we can join back for metadata.
      // tokenize="unicode61" provides good multilingual tokenization with stemming.
      // FTS5 is supported in DO SQLite — verified on staging deployment.
      // If FTS5 is unavailable, searchMessagesFts() catches the error and falls back to LIKE.
      try {
        sql.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_grouped_fts
          USING fts5(content, content='chat_messages_grouped', content_rowid='rowid', tokenize='unicode61')
        `);
      } catch (e) {
        // FTS5 may not be available in all SQLite builds.
        // The system degrades gracefully — searchMessagesFts() catches errors and falls back to LIKE.
        log.error('migrations.fts5_virtual_table_failed', {
          error: String(e),
        });
      }

      // Track which sessions have been materialized (NULL = not yet).
      // ALTER TABLE ADD COLUMN is idempotent in SQLite if the column already exists (throws error).
      try {
        sql.exec(`ALTER TABLE chat_sessions ADD COLUMN materialized_at INTEGER`);
      } catch {
        // Column already exists from a partial previous run — safe to ignore.
      }
    },
  },
  {
    name: '012-chat-session-ideas',
    run: (sql) => {
      // Many-to-many junction between chat sessions and ideas (tasks).
      // Enables linking multiple ideas to a session and tracking which
      // sessions discussed a given idea.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS chat_session_ideas (
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          context TEXT,
          PRIMARY KEY (session_id, task_id)
        )
      `);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_csi_task ON chat_session_ideas(task_id)`);
    },
  },
  {
    name: '013-cached-commands',
    run: (sql) => {
      // Per-project cache of agent slash commands discovered during ACP sessions.
      // Allows the SlashCommandPalette to show known commands before a session starts.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS cached_commands (
          agent_type TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (agent_type, name)
        )
      `);
    },
  },
  {
    name: '014-user-message-content-dedup-index',
    run: (sql) => {
      // Partial index for content-based dedup of user messages in persistMessageBatch.
      // The VM agent batch-persists user messages with a different ID than the one
      // already stored via the DO WebSocket (message.send). This index makes the
      // content-dedup SELECT a point lookup instead of a full session scan.
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_user_content
          ON chat_messages(session_id, content)
          WHERE role = 'user'
      `);
    },
  },
  {
    name: '015-session-inbox',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS session_inbox (
          id TEXT PRIMARY KEY,
          target_session_id TEXT NOT NULL,
          source_task_id TEXT,
          message_type TEXT NOT NULL,
          content TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal',
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          FOREIGN KEY (target_session_id) REFERENCES chat_sessions(id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbox_pending
          ON session_inbox(target_session_id, delivered_at)
          WHERE delivered_at IS NULL
      `);
    },
  },
  {
    name: '016-knowledge-graph',
    run: (sql) => {
      // Knowledge entities (nodes in the graph)
      sql.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_entities_type
          ON knowledge_entities(entity_type)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_entities_updated
          ON knowledge_entities(updated_at DESC)
      `);

      // Observations (facts attached to entities)
      sql.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_observations (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.7,
          source_type TEXT NOT NULL DEFAULT 'inferred',
          source_session_id TEXT,
          created_at INTEGER NOT NULL,
          last_confirmed_at INTEGER NOT NULL,
          superseded_by TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_obs_entity
          ON knowledge_observations(entity_id, is_active)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_obs_source
          ON knowledge_observations(source_type)
      `);

      // Relations between entities
      sql.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_relations (
          id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL,
          target_entity_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE,
          FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_rel_source
          ON knowledge_relations(source_entity_id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_rel_target
          ON knowledge_relations(target_entity_id)
      `);

      // FTS5 for searching observations
      try {
        sql.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_observations_fts
          USING fts5(content, content='knowledge_observations', content_rowid='rowid', tokenize='unicode61')
        `);
      } catch {
        // FTS5 may already exist from a partial migration
      }
    },
  },
  {
    name: '017-agent-mailbox',
    run: (sql) => {
      // Extend the existing session_inbox table (migration 015) into a full
      // durable mailbox with message classes, delivery state machine, and ack tracking.
      // Uses ALTER TABLE ADD COLUMN — safe, no DROP TABLE.

      // message_class: escalating urgency (notify, deliver, interrupt, preempt_and_replan, shutdown_with_final_prompt)
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN message_class TEXT NOT NULL DEFAULT 'notify'`); } catch { /* already exists */ }

      // delivery_state: queued → delivered → acked → expired
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'`); } catch { /* already exists */ }

      // Sender identity
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'system'`); } catch { /* already exists */ }
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN sender_id TEXT`); } catch { /* already exists */ }

      // Ack tracking
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN ack_required INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN acked_at INTEGER`); } catch { /* already exists */ }
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN ack_timeout_ms INTEGER`); } catch { /* already exists */ }

      // Expiry
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN expires_at INTEGER`); } catch { /* already exists */ }

      // Delivery tracking
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN last_delivery_at INTEGER`); } catch { /* already exists */ }

      // Structured metadata (JSON)
      try { sql.exec(`ALTER TABLE session_inbox ADD COLUMN metadata TEXT`); } catch { /* already exists */ }

      // Indexes for efficient delivery sweep queries
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbox_delivery_sweep
          ON session_inbox(delivery_state, message_class, created_at)
          WHERE delivery_state IN ('queued', 'delivered')
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbox_target_state
          ON session_inbox(target_session_id, delivery_state)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbox_expires
          ON session_inbox(expires_at)
          WHERE expires_at IS NOT NULL AND delivery_state NOT IN ('acked', 'expired')
      `);
    },
  },
  {
    name: '018-mission-state-handoffs',
    run: (sql) => {
      // Mission state entries — shared facts, decisions, risks, contracts for a mission
      sql.exec(`
        CREATE TABLE IF NOT EXISTS mission_state_entries (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          entry_type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT,
          source_task_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_mission_state_entries_mission
          ON mission_state_entries(mission_id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_mission_state_entries_type
          ON mission_state_entries(mission_id, entry_type)
      `);

      // Handoff packets — structured inter-task communication envelopes
      sql.exec(`
        CREATE TABLE IF NOT EXISTS handoff_packets (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          from_task_id TEXT NOT NULL,
          to_task_id TEXT,
          summary TEXT NOT NULL,
          facts TEXT,
          open_questions TEXT,
          artifact_refs TEXT,
          suggested_actions TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_handoff_packets_mission
          ON handoff_packets(mission_id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_handoff_packets_from_task
          ON handoff_packets(from_task_id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_handoff_packets_to_task
          ON handoff_packets(to_task_id)
          WHERE to_task_id IS NOT NULL
      `);
    },
  },
  {
    name: '019-project-policies',
    run: (sql) => {
      // Project policies — structured dynamic policies per project (Phase 4: Policy Propagation)
      sql.exec(`
        CREATE TABLE IF NOT EXISTS project_policies (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'explicit',
          source_session_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.8,
          active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_project_policies_active
          ON project_policies(active)
          WHERE active = 1
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_project_policies_category
          ON project_policies(category, active)
      `);
    },
  },
];

/**
 * Run pending migrations inside a transaction.
 * Call this from `blockConcurrencyWhile()` in the DO constructor.
 */
export function runMigrations(sql: SqlStorage): void {
  // Ensure migrations tracking table exists
  sql.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get set of already-applied migrations
  const applied = new Set<string>();
  const rows = sql.exec('SELECT name FROM migrations').toArray();
  for (const row of rows) {
    applied.add(parseMigrationName(row));
  }

  // Run each pending migration
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      migration.run(sql);
      sql.exec(
        'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
        migration.name,
        Date.now()
      );
    }
  }
}
