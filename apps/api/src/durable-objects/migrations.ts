// FILE SIZE EXCEPTION: Append-only migration ledger must preserve one auditable execution order. See .claude/rules/18-file-size-limits.md
/**
 * Durable Object SQLite migration runner and migration definitions.
 *
 * Each project's Durable Object maintains its own SQLite database.
 * Migrations are tracked in a `migrations` table and run lazily
 * in the constructor via `blockConcurrencyWhile()`.
 *
 * See: specs/018-project-first-architecture/research.md (Decision 6)
 */

import { MAILBOX_DEFAULTS } from '@simple-agent-manager/shared';

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
      sql.exec(
        `CREATE INDEX idx_idle_cleanup_schedule_cleanup_at ON idle_cleanup_schedule(cleanup_at)`
      );
    },
  },
  {
    name: '006-idle-cleanup-retry-count',
    run: (sql) => {
      sql.exec(
        `ALTER TABLE idle_cleanup_schedule ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`
      );
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
      // Uses ALTER TABLE ADD COLUMN so existing mailbox rows are preserved.

      // message_class: escalating urgency (notify, deliver, interrupt, preempt_and_replan, shutdown_with_final_prompt)
      try {
        sql.exec(
          `ALTER TABLE session_inbox ADD COLUMN message_class TEXT NOT NULL DEFAULT 'notify'`
        );
      } catch {
        /* already exists */
      }

      // delivery_state: queued → delivered → acked → expired
      try {
        sql.exec(
          `ALTER TABLE session_inbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'`
        );
      } catch {
        /* already exists */
      }

      // Sender identity
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'system'`);
      } catch {
        /* already exists */
      }
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN sender_id TEXT`);
      } catch {
        /* already exists */
      }

      // Ack tracking
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN ack_required INTEGER NOT NULL DEFAULT 0`);
      } catch {
        /* already exists */
      }
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN acked_at INTEGER`);
      } catch {
        /* already exists */
      }
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN ack_timeout_ms INTEGER`);
      } catch {
        /* already exists */
      }

      // Expiry
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN expires_at INTEGER`);
      } catch {
        /* already exists */
      }

      // Delivery tracking
      try {
        sql.exec(
          `ALTER TABLE session_inbox ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`
        );
      } catch {
        /* already exists */
      }
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN last_delivery_at INTEGER`);
      } catch {
        /* already exists */
      }

      // Structured metadata (JSON)
      try {
        sql.exec(`ALTER TABLE session_inbox ADD COLUMN metadata TEXT`);
      } catch {
        /* already exists */
      }

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
  {
    name: '020-session-attention-markers',
    run: (sql) => {
      // Durable attention markers — current product state about whether a
      // session needs human or system action. Separate from notifications
      // (delivery/inbox) and task lifecycle status.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS session_attention_markers (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          task_id TEXT,
          workspace_id TEXT,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          source_event_id TEXT,
          source_message_id TEXT,
          source_notification_id TEXT,
          reason TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          resolved_at INTEGER,
          resolved_by_message_id TEXT,
          resolved_by_actor_type TEXT,
          resolved_reason TEXT
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attention_active
          ON session_attention_markers(session_id, resolved_at, created_at DESC)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attention_expiry
          ON session_attention_markers(expires_at)
          WHERE resolved_at IS NULL AND expires_at IS NOT NULL
      `);
    },
  },
  {
    name: '021-session-state-mirror',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS session_state (
          session_id TEXT PRIMARY KEY,
          activity TEXT NOT NULL DEFAULT 'idle',
          activity_at INTEGER NOT NULL,
          status_error TEXT,
          current_plan_json TEXT,
          plan_updated_at INTEGER,
          prompt_started_at INTEGER,
          last_stop_reason TEXT,
          agent_type TEXT,
          restart_count INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
  },
  {
    name: '022-activity-session-index',
    run: (sql) => {
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_activity_events_session ON activity_events(session_id, created_at DESC) WHERE session_id IS NOT NULL`
      );
    },
  },
  {
    name: '023-session-creator',
    run: (sql) => {
      sql.exec(`ALTER TABLE chat_sessions ADD COLUMN created_by_user_id TEXT`);
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_chat_sessions_created_by ON chat_sessions(created_by_user_id)`
      );
    },
  },
  {
    // Origin tag for SAM-injected messages (e.g. the get_instructions reminder)
    // so the UI can collapse them. Additive column; NULL/absent = normal user
    // message. No DROP/recreate (rule 31 — chat_messages is a CASCADE parent).
    name: '024-chat-message-origin',
    run: (sql) => {
      sql.exec(`ALTER TABLE chat_messages ADD COLUMN origin TEXT`);
    },
  },
  {
    // Legacy messages could be inserted with NULL expiry when callers omitted
    // ttlMs. Backfill in place; the WHERE clause is mandatory for DO migration
    // safety and leaves finite caller-provided expiries untouched.
    name: '025-mailbox-null-ttl-backfill',
    run: (sql) => {
      sql.exec(
        `UPDATE session_inbox
         SET expires_at = created_at + ?
         WHERE expires_at IS NULL`,
        MAILBOX_DEFAULTS.TTL_MS
      );
    },
  },
  {
    name: '026-delivery-aware-attention-expiry',
    run: (sql) => {
      sql.exec(`ALTER TABLE session_attention_markers ADD COLUMN notification_user_id TEXT`);
      sql.exec(`ALTER TABLE session_attention_markers ADD COLUMN next_escalation_at INTEGER`);
      sql.exec(
        `ALTER TABLE session_attention_markers ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0`
      );
      sql.exec(`ALTER TABLE session_attention_markers ADD COLUMN max_expires_at INTEGER`);
      sql.exec(`ALTER TABLE session_attention_markers ADD COLUMN resolved_answer TEXT`);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attention_escalation
          ON session_attention_markers(next_escalation_at)
          WHERE resolved_at IS NULL AND next_escalation_at IS NOT NULL
        `);
    },
  },
  {
    // Worker-owned durable prompt delivery and checkpoint episode foundation.
    // session_inbox remains the only queue; these columns add attempt/receipt
    // reconciliation without creating a competing delivery store.
    name: '027-durable-prompt-delivery-checkpoints',
    run: (sql) => {
      sql.exec(`ALTER TABLE session_state ADD COLUMN prompt_epoch INTEGER`);

      sql.exec(
        `ALTER TABLE session_inbox ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'agent_mailbox'`
      );
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN prompt_message_id TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN next_attempt_at INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN last_error TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN terminal_reason TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN attempt_id TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN attempt_started_at INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN runtime_identity TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN receipt_state TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN receipt_runtime_identity TEXT`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN receipt_checked_at INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN accepted_at INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN adapter_protocol_version INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN receipt_supported INTEGER`);
      sql.exec(`ALTER TABLE session_inbox ADD COLUMN durable_delivery INTEGER NOT NULL DEFAULT 0`);

      sql.exec(`
        UPDATE session_inbox
        SET prompt_message_id = id
        WHERE prompt_message_id IS NULL
      `);
      sql.exec(`
        UPDATE session_inbox
        SET next_attempt_at = created_at
        WHERE next_attempt_at IS NULL AND delivery_state = 'queued'
      `);

      sql.exec(`
        CREATE INDEX idx_inbox_delivery_due
        ON session_inbox(delivery_state, next_attempt_at, created_at)
        WHERE delivery_state IN ('queued', 'retry_wait')
      `);
      sql.exec(`
        CREATE INDEX idx_inbox_delivery_claims
        ON session_inbox(delivery_state, attempt_started_at)
        WHERE delivery_state = 'delivering'
      `);

      sql.exec(`
        CREATE TABLE checkpoint_episodes (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT,
          workspace_id TEXT,
          acp_session_id TEXT NOT NULL,
          prompt_epoch INTEGER NOT NULL,
          reason TEXT NOT NULL,
          state TEXT NOT NULL,
          progress_envelope_json TEXT,
          mailbox_message_id TEXT,
          prompt_delivery_id TEXT,
          preempt_requested_at INTEGER,
          preempt_accepted_at INTEGER,
          ready_observed_at INTEGER,
          resume_accepted_at INTEGER,
          completed_at INTEGER,
          failed_at INTEGER,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(acp_session_id, prompt_epoch)
        )
      `);
      sql.exec(`
        CREATE INDEX idx_checkpoint_episodes_session
        ON checkpoint_episodes(session_id, created_at DESC)
      `);
      sql.exec(`
        CREATE INDEX idx_checkpoint_episodes_state
        ON checkpoint_episodes(state, updated_at)
      `);
    },
  },
  {
    name: '028-idle-cleanup-attention-state',
    run: (sql) => {
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN terminal_state TEXT`);
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN terminal_reason TEXT`);
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN terminal_at INTEGER`);
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN last_error TEXT`);
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN failure_notified_at INTEGER`);
      sql.exec(`ALTER TABLE idle_cleanup_schedule ADD COLUMN attention_marker_id TEXT`);
      sql.exec(`
        CREATE INDEX idx_idle_cleanup_schedule_active_cleanup_at
        ON idle_cleanup_schedule(cleanup_at)
        WHERE terminal_state IS NULL
      `);
      sql.exec(`
        CREATE INDEX idx_idle_cleanup_schedule_terminal
        ON idle_cleanup_schedule(terminal_state, terminal_at)
        WHERE terminal_state IS NOT NULL
      `);
    },
  },
  {
    // Reconciled session-activity state: provenance + terminal-transition
    // reason on the authoritative row, plus bounded probe accounting so a
    // stale working state can be reconciled against the vm-agent instead of
    // trusted indefinitely. Additive columns only (.claude/rules/31).
    name: '029-session-activity-reconciliation',
    run: (sql) => {
      sql.exec(`ALTER TABLE session_state ADD COLUMN activity_source TEXT`);
      sql.exec(`ALTER TABLE session_state ADD COLUMN activity_reason TEXT`);
      sql.exec(`ALTER TABLE session_state ADD COLUMN activity_probe_at INTEGER`);
      sql.exec(
        `ALTER TABLE session_state ADD COLUMN activity_probe_attempts INTEGER NOT NULL DEFAULT 0`
      );
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_state_working_activity
        ON session_state(activity, activity_at)
      `);
    },
  },
  {
    // Normalize harness-owned work into bounded metadata. Raw harness payloads
    // intentionally have no persistence column.
    //
    // Numbered 030 (not 029) because PR #1840's
    // `029-session-activity-reconciliation` landed on main first and is already
    // applied in production. This ledger is keyed by NAME
    // (`runMigrations` skips already-applied names), and this migration has
    // never been applied in any environment — the authoring branch never
    // deployed — so appending it after 029 is safe for both a clean bootstrap
    // and an existing deployment. See .claude/rules/07-env-and-urls.md.
    name: '030-harness-work-and-task-waits',
    run: (sql) => {
      // Each ADD COLUMN is individually guarded so a partial previous run — or a
      // Durable Object that somehow recorded this migration under its
      // pre-renumber name — cannot wedge the DO constructor with a
      // `duplicate column name` error on every subsequent RPC. Same pattern as
      // migrations 011 and 017.
      for (const statement of [
        `ALTER TABLE session_state ADD COLUMN runtime_work_state TEXT CHECK (runtime_work_state IN ('inactive', 'active', 'settling'))`,
        `ALTER TABLE session_state ADD COLUMN runtime_work_count INTEGER CHECK (runtime_work_count IS NULL OR runtime_work_count >= 0)`,
        `ALTER TABLE session_state ADD COLUMN runtime_work_source TEXT`,
        `ALTER TABLE session_state ADD COLUMN runtime_work_updated_at INTEGER`,
        `ALTER TABLE session_state ADD COLUMN runtime_work_progress_at INTEGER`,
      ]) {
        try {
          sql.exec(statement);
        } catch {
          // Column already exists from a partial previous run — safe to ignore.
        }
      }

      sql.exec(`
				CREATE TABLE IF NOT EXISTS task_wait_subscriptions (
					id TEXT PRIMARY KEY,
					parent_task_id TEXT NOT NULL,
					parent_session_id TEXT NOT NULL,
					wait_condition TEXT NOT NULL CHECK (wait_condition IN ('all', 'any')),
					state TEXT NOT NULL CHECK (state IN ('active', 'resolved', 'cancelled')),
					child_count INTEGER NOT NULL CHECK (child_count > 0),
					wake_deadline INTEGER NOT NULL,
					next_reconcile_at INTEGER NOT NULL,
					wake_delivery_id TEXT NOT NULL UNIQUE,
					resolution_reason TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					resolved_at INTEGER
				)
			`);
      sql.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_task_wait_active_parent
				ON task_wait_subscriptions(parent_task_id)
				WHERE state = 'active'
			`);
      sql.exec(`
				CREATE INDEX IF NOT EXISTS idx_task_wait_due
				ON task_wait_subscriptions(next_reconcile_at, wake_deadline)
				WHERE state = 'active'
			`);
      sql.exec(`
				CREATE TABLE IF NOT EXISTS task_wait_children (
					subscription_id TEXT NOT NULL REFERENCES task_wait_subscriptions(id) ON DELETE CASCADE,
					child_task_id TEXT NOT NULL,
					observed_status TEXT,
					observed_at INTEGER,
					PRIMARY KEY (subscription_id, child_task_id)
				)
			`);
      sql.exec(`
				CREATE INDEX IF NOT EXISTS idx_task_wait_child
				ON task_wait_children(child_task_id, subscription_id)
      `);
    },
  },
  {
    // Replay hardening for the task-wait tables created in 030. Kept as a
    // separate additive migration (rather than folded into 030) so any
    // Durable Object that recorded 030 still receives these columns.
    //
    // Numbered 031 for the same reason 030 was renumbered: PR #1840's
    // `029-session-activity-reconciliation` claimed 029 on main first.
    name: '031-task-wait-replay-hardening',
    run: (sql) => {
      for (const statement of [
        `ALTER TABLE task_wait_subscriptions ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE task_wait_subscriptions ADD COLUMN wake_content TEXT`,
        `ALTER TABLE task_wait_subscriptions ADD COLUMN wake_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wake_attempts >= 0)`,
      ]) {
        try {
          sql.exec(statement);
        } catch {
          // Column already exists from a partial previous run — safe to ignore.
        }
      }
      sql.exec(`
        UPDATE task_wait_subscriptions
        SET idempotency_key = 'legacy-' || id
        WHERE idempotency_key = ''
      `);
      sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_wait_idempotency
        ON task_wait_subscriptions(parent_task_id, idempotency_key)
      `);
    },
  },
  {
    name: '032-message-comment-threads',
    run: (sql) => {
      sql.exec(`
        CREATE TABLE comment_threads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          anchor_kind TEXT NOT NULL DEFAULT 'message' CHECK (anchor_kind = 'message'),
          message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          quote TEXT,
          body TEXT NOT NULL,
          author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
          author_id TEXT NOT NULL,
          author_name TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'resolved')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          client_mutation_id TEXT,
          client_mutation_fingerprint TEXT,
          sent_at INTEGER,
          sent_by_type TEXT CHECK (sent_by_type IS NULL OR sent_by_type IN ('human', 'agent')),
          sent_by_id TEXT,
          sent_by_name TEXT,
          resolved_at INTEGER,
          resolved_by_type TEXT CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('human', 'agent')),
          resolved_by_id TEXT,
          resolved_by_name TEXT,
          reopened_at INTEGER,
          reopened_by_type TEXT CHECK (reopened_by_type IS NULL OR reopened_by_type IN ('human', 'agent')),
          reopened_by_id TEXT,
          reopened_by_name TEXT,
          UNIQUE(session_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX idx_comment_threads_session_sequence
        ON comment_threads(session_id, sequence)
      `);
      sql.exec(`
        CREATE INDEX idx_comment_threads_message
        ON comment_threads(session_id, message_id, sequence)
      `);
      sql.exec(`
        CREATE INDEX idx_comment_threads_status
        ON comment_threads(session_id, status, sequence)
      `);

      sql.exec(`
        CREATE TABLE comment_replies (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
          author_id TEXT NOT NULL,
          author_name TEXT,
          created_at INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          client_mutation_id TEXT,
          client_mutation_fingerprint TEXT,
          UNIQUE(thread_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX idx_comment_replies_thread_sequence
        ON comment_replies(thread_id, sequence)
      `);
      sql.exec(`
        CREATE INDEX idx_comment_replies_session
        ON comment_replies(session_id, thread_id)
      `);

      sql.exec(`
        CREATE TABLE comment_status_mutations (
          thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          target_status TEXT NOT NULL CHECK (target_status IN ('open', 'sent', 'resolved')),
          thread_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX idx_comment_status_mutations_session
        ON comment_status_mutations(session_id, created_at)
      `);
    },
  },
  {
    name: '033-library-file-comment-threads',
    run: (sql) => {
      // Library file comments live in their OWN tables, entirely separate from the
      // message comment tables created in migration 032.
      //
      // The obvious alternative — widening `comment_threads` to allow a
      // `library_file` anchor — cannot be done additively: SQLite cannot change a
      // CHECK constraint or remove a NOT NULL in place, so it would require recreating
      // `comment_threads` and its two CASCADE children. Durable Object SQLite has no
      // point-in-time recovery, so dropping a table here is unrecoverable
      // (.claude/rules/31-migration-safety.md, `pnpm quality:do-migration-safety`).
      //
      // Separate tables also keep message-comment session isolation intact by
      // construction: a file thread simply cannot be reached by a session-scoped
      // query, so no message-comment code path needs to learn about nullable
      // session_id. The two anchor kinds are joined at the type layer
      // (`CommentAnchor` in packages/shared/src/types/comments.ts), not in storage.
      //
      // Phase 2 anchor kinds for other file types extend `library_file_comment_threads`
      // additively (new nullable columns), never by widening the message tables.

      sql.exec(`
        CREATE TABLE IF NOT EXISTS library_file_comment_threads (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          anchor_kind TEXT NOT NULL DEFAULT 'library_file' CHECK (anchor_kind = 'library_file'),
          quote TEXT,
          body TEXT NOT NULL,
          author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
          author_id TEXT NOT NULL,
          author_name TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'resolved')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          client_mutation_id TEXT,
          client_mutation_fingerprint TEXT,
          resolved_at INTEGER,
          resolved_by_type TEXT CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('human', 'agent')),
          resolved_by_id TEXT,
          resolved_by_name TEXT,
          reopened_at INTEGER,
          reopened_by_type TEXT CHECK (reopened_by_type IS NULL OR reopened_by_type IN ('human', 'agent')),
          reopened_by_id TEXT,
          reopened_by_name TEXT,
          UNIQUE(file_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_threads_file_sequence
        ON library_file_comment_threads(file_id, sequence)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_threads_status
        ON library_file_comment_threads(file_id, status, sequence)
      `);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS library_file_comment_replies (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES library_file_comment_threads(id) ON DELETE CASCADE,
          file_id TEXT NOT NULL,
          body TEXT NOT NULL,
          author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
          author_id TEXT NOT NULL,
          author_name TEXT,
          created_at INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          client_mutation_id TEXT,
          client_mutation_fingerprint TEXT,
          UNIQUE(thread_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_replies_thread_sequence
        ON library_file_comment_replies(thread_id, sequence)
      `);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS library_file_comment_status_mutations (
          thread_id TEXT NOT NULL REFERENCES library_file_comment_threads(id) ON DELETE CASCADE,
          file_id TEXT NOT NULL,
          client_mutation_id TEXT NOT NULL,
          target_status TEXT NOT NULL CHECK (target_status IN ('open', 'sent', 'resolved')),
          thread_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, client_mutation_id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_status_mutations_file
        ON library_file_comment_status_mutations(file_id, created_at)
      `);
    },
  },
  {
    name: '034-policy-lifecycle-controls',
    run: (sql) => {
      // Policy lifecycle controls — give policies a shelf life and a scope so
      // one-shot workflow policies stop being injected into every session forever.
      //
      // STRICTLY ADDITIVE (rules 31 / 63): two ALTER TABLE ADD COLUMN statements, no
      // table recreation, no DROP. A Durable Object has no D1-style time-travel
      // recovery, so a drop-and-restore here would be unrecoverable.
      //
      // Do not put quoted SQL fragments in these comments: the migration safety
      // scanner extracts every quoted literal in this file — backtick, single AND
      // double — and validates each as a statement, so inline-code prose is checked
      // as if it were real SQL.
      //
      // Both defaults reproduce the pre-migration behavior exactly, so every policy
      // that already exists keeps applying unchanged:
      //   expires_at NULL     -> never expires (what every policy does today)
      //   scope 'always'      -> standing project policy
      //
      // `scope` gets no CHECK constraint, matching `category` / `source` in
      // migration 019 — SQLite cannot add a CHECK via ALTER TABLE, and the value is
      // validated at the write boundary by `validatePolicyLifecycle` in
      // packages/shared/src/constants/policies.ts.
      sql.exec('ALTER TABLE project_policies ADD COLUMN expires_at INTEGER');
      sql.exec("ALTER TABLE project_policies ADD COLUMN scope TEXT NOT NULL DEFAULT 'always'");
    },
  },
  {
    name: '035-comment-thread-activity-indexes',
    run: (sql) => {
      // Indexes for the project-wide comment inbox (GET /projects/:id/comments).
      //
      // STRICTLY ADDITIVE (rule 31): CREATE INDEX only — no table recreation, no
      // DROP, no ALTER. A Durable Object has no D1-style time-travel recovery, so
      // anything destructive here would be unrecoverable.
      //
      // Why these are needed: every index migrations 032/033 created leads with the
      // scope column, session_id or file_id. The project-wide read deliberately has
      // no such predicate — the Durable Object IS the project — and ranks by
      // updated_at, which appeared in no index at all. Verified with EXPLAIN QUERY
      // PLAN against the real schema, both reads degraded to a full table scan plus
      // a temp B-tree sort, so their cost grew with total project comment volume
      // rather than with the page size and the LIMIT bought nothing.
      //
      // Column order matters: updated_at leads because it is the ranking key, and id
      // follows so the sort has a total order and the ranking pass can be answered
      // from the index without touching the table. The status-prefixed variants
      // serve the filtered reads and let their counts run covered.
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_comment_threads_updated_at
        ON comment_threads(updated_at DESC, id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_comment_threads_status_updated_at
        ON comment_threads(status, updated_at DESC, id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_threads_updated_at
        ON library_file_comment_threads(updated_at DESC, id)
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_library_file_comment_threads_status_updated_at
        ON library_file_comment_threads(status, updated_at DESC, id)
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
