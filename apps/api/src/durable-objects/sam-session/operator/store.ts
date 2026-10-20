import {
  DEFAULT_SAM_MAX_CONVERSATIONS,
  DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { buildSafeFtsQuery } from '../../../lib/fts5';
import { ulid } from '../../../lib/ulid';
import type { SamDispatchReservation } from '../../../services/sam-dispatch-reservation';
import { migrateSamHistory } from '../schema';

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing private SAM state');
  return value;
}

/** Private, per-user operator control state. No project-visible transcript is stored here. */
export type TurnState =
  'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface OperatorTurn {
  id: string;
  request_key: string;
  conversation_id: string;
  message: string;
  generation: number;
  state: TurnState;
  response: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export interface OperatorAction {
  /** Response projection only; never an authorization grant. */
  available?: boolean;
  id: string;
  turn_id: string;
  operation: string;
  input_json: string;
  state: 'pending' | 'approval_required' | 'completed' | 'rejected' | 'uncertain';
  result_json: string | null;
  created_at: number;
}

export class OperatorStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T = (fn) => fn()
  ) {
    migrateSamHistory(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      enabled INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
      user_id TEXT, conversation_id TEXT
    )`);
    sql.exec('INSERT OR IGNORE INTO operator_settings(singleton) VALUES(1)');
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_turns (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, message TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL, response TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS operator_one_active_turn
      ON operator_turns((1)) WHERE state IN ('accepted', 'running')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_actions (
      id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, operation TEXT NOT NULL,
      input_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT,
      created_at INTEGER NOT NULL
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS operator_actions_turn ON operator_actions(turn_id)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS operator_dispatch_reservations(action_id TEXT PRIMARY KEY,identity_json TEXT NOT NULL)'
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS operator_forks(request_key TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,task_id TEXT NOT NULL)'
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS operator_rate_limit (singleton INTEGER PRIMARY KEY, window_start INTEGER NOT NULL, used INTEGER NOT NULL)'
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_conversation_tasks (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, parent_task_id TEXT,
      state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
    )`);
    this.transaction(() => {
      let conversationId = this.settings().conversationId;
      if (!conversationId) {
        const existing = sql
          .exec(
            "SELECT id FROM conversations WHERE type='human' ORDER BY updated_at DESC,id DESC LIMIT 1"
          )
          .toArray()[0];
        conversationId = existing ? String(existing.id) : crypto.randomUUID();
        sql.exec(
          "INSERT OR IGNORE INTO conversations(id,title,type) VALUES(?,'SAM','human')",
          conversationId
        );
        sql.exec(
          'UPDATE operator_settings SET conversation_id=? WHERE singleton=1',
          conversationId
        );
      }
      sql.exec(
        'INSERT OR IGNORE INTO operator_conversation_tasks(id,conversation_id,created_at) VALUES(?,?,?)',
        crypto.randomUUID(),
        conversationId,
        Date.now()
      );
    });
  }

  settings() {
    const row = required(
      this.sql.exec('SELECT * FROM operator_settings WHERE singleton=1').toArray()[0]
    );
    return {
      enabled: row.enabled === 1,
      generation: Number(row.generation),
      userId: typeof row.user_id === 'string' ? row.user_id : null,
      conversationId: typeof row.conversation_id === 'string' ? row.conversation_id : null,
    };
  }

  bindUser(userId: string): void {
    const previous = this.settings().userId;
    if (previous && previous !== userId) throw new Error('Operator identity mismatch');
    this.sql.exec('UPDATE operator_settings SET user_id=? WHERE singleton=1', userId);
  }

  setEnabled(enabled: boolean): void {
    if (this.settings().enabled === enabled) return;
    this.sql.exec(
      'UPDATE operator_settings SET enabled=?, generation=generation+1 WHERE singleton=1',
      enabled ? 1 : 0
    );
    if (!enabled) {
      this.sql.exec(
        "UPDATE operator_turns SET state='cancelled',error='SAM was disabled',updated_at=? WHERE state IN ('accepted','running')",
        Date.now()
      );
      this.sql.exec("UPDATE operator_actions SET state='rejected' WHERE state='approval_required'");
    }
  }

  isCurrent(turn: OperatorTurn): boolean {
    const settings = this.settings();
    return (
      settings.enabled &&
      settings.generation === turn.generation &&
      this.turn(turn.id)?.state === 'running'
    );
  }

  turn(id: string): OperatorTurn | null {
    return (
      this.sql
        .exec<OperatorTurn & Record<string, SqlStorageValue>>(
          'SELECT * FROM operator_turns WHERE id=?',
          id
        )
        .toArray()[0] ?? null
    );
  }

  accept(
    requestKey: string,
    message: string,
    budget?: { limit: number; windowMs: number }
  ): { turn: OperatorTurn; replayed: boolean } {
    const existing = this.sql
      .exec<OperatorTurn & Record<string, SqlStorageValue>>(
        'SELECT * FROM operator_turns WHERE request_key=?',
        requestKey
      )
      .toArray()[0];
    if (existing) {
      if (existing.message !== message) throw new Error('REQUEST_KEY_CONFLICT');
      return { turn: existing, replayed: true };
    }
    const settings = this.settings();
    if (!settings.enabled) throw new Error('SAM_DISABLED');
    if (this.active()) throw new Error('TURN_ACTIVE');
    const id = crypto.randomUUID();
    const now = Date.now();
    if (budget) {
      const windowStart = Math.floor(now / budget.windowMs) * budget.windowMs;
      const row = this.sql
        .exec('SELECT window_start,used FROM operator_rate_limit WHERE singleton=1')
        .toArray()[0];
      if (row?.window_start === windowStart && Number(row.used) >= budget.limit)
        throw new Error('RATE_LIMITED');
      this.sql.exec(
        'INSERT INTO operator_rate_limit VALUES(1,?,1) ON CONFLICT(singleton) DO UPDATE SET window_start=excluded.window_start,used=CASE WHEN operator_rate_limit.window_start=excluded.window_start THEN operator_rate_limit.used+1 ELSE 1 END',
        windowStart
      );
    }
    this.sql.exec(
      "INSERT INTO operator_turns(id,request_key,conversation_id,message,generation,state,created_at,updated_at) VALUES(?,?,?,?,?,'accepted',?,?)",
      id,
      requestKey,
      required(settings.conversationId),
      message,
      settings.generation,
      now,
      now
    );
    this.appendMessage(`operator:${id}:user`, 'user', message);
    return { turn: required(this.turn(id)), replayed: false };
  }

  active(): OperatorTurn | null {
    return (
      this.sql
        .exec<OperatorTurn & Record<string, SqlStorageValue>>(
          "SELECT * FROM operator_turns WHERE state IN ('accepted','running') LIMIT 1"
        )
        .toArray()[0] ?? null
    );
  }

  setState(
    id: string,
    state: TurnState,
    response: string | null = null,
    error: string | null = null
  ): void {
    this.transaction(() => {
      this.sql.exec(
        'UPDATE operator_turns SET state=?,response=?,error=?,updated_at=? WHERE id=?',
        state,
        response,
        error,
        Date.now(),
        id
      );
      if (state === 'cancelled')
        this.sql.exec(
          "UPDATE operator_actions SET state='rejected' WHERE turn_id=? AND state='approval_required'",
          id
        );
      if (response) this.appendMessage(`operator:${id}:assistant`, 'assistant', response);
    });
  }

  conversation() {
    const id = required(this.settings().conversationId);
    const task = required(
      this.sql
        .exec(
          'SELECT id,parent_task_id FROM operator_conversation_tasks WHERE conversation_id=?',
          id
        )
        .toArray()[0]
    );
    const legacy =
      this.sql
        .exec(
          "SELECT 1 FROM messages WHERE conversation_id=? AND id NOT LIKE 'operator:%' LIMIT 1",
          id
        )
        .toArray().length > 0;
    return { conversationId: id, backingTaskId: String(task.id), legacyHistoryAvailable: legacy };
  }

  fork(
    requestKey: string,
    limits = {
      conversations: DEFAULT_SAM_MAX_CONVERSATIONS,
      messages: DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
    }
  ) {
    const previous = this.sql
      .exec('SELECT conversation_id,task_id FROM operator_forks WHERE request_key=?', requestKey)
      .toArray()[0];
    if (previous)
      return {
        conversationId: String(previous.conversation_id),
        backingTaskId: String(previous.task_id),
        replayed: true,
      };
    if (this.active()) throw new Error('TURN_ACTIVE');
    const count = Number(
      this.sql.exec('SELECT COUNT(*) AS count FROM conversations').toArray()[0]?.count ?? 0
    );
    if (count >= limits.conversations) throw new Error('CONVERSATION_LIMIT');
    const parent = this.conversation();
    const conversationId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    this.transaction(() => {
      this.sql.exec(
        "INSERT INTO conversations(id,title,type) VALUES(?,'SAM — private branch','human')",
        conversationId
      );
      this.sql.exec(
        'INSERT INTO operator_conversation_tasks(id,conversation_id,parent_task_id,created_at) VALUES(?,?,?,?)',
        taskId,
        conversationId,
        parent.backingTaskId,
        Date.now()
      );
      this.sql.exec(
        "INSERT INTO messages(id,conversation_id,role,content,sequence,created_at) SELECT 'fork:' || ? || ':' || id,?,role,content,sequence,created_at FROM (SELECT * FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY sequence DESC LIMIT ?)",
        conversationId,
        conversationId,
        parent.conversationId,
        limits.messages
      );
      this.sql.exec(
        'INSERT INTO messages_fts(rowid,content) SELECT rowid,content FROM messages WHERE conversation_id=?',
        conversationId
      );
      this.sql.exec('INSERT INTO operator_forks VALUES(?,?,?)', requestKey, conversationId, taskId);
      this.sql.exec(
        'UPDATE operator_settings SET conversation_id=? WHERE singleton=1',
        conversationId
      );
    });
    return { conversationId, backingTaskId: taskId, replayed: false };
  }

  contextMessages(
    limit: number
  ): Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> {
    return this.sql
      .exec(
        "SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY sequence DESC LIMIT ?",
        required(this.settings().conversationId),
        limit
      )
      .toArray()
      .reverse()
      .map((row) =>
        row.role === 'user'
          ? { role: 'user' as const, content: String(row.content) }
          : { role: 'assistant' as const, content: String(row.content) }
      );
  }

  searchHistory(query: string, limit: number) {
    const expression = buildSafeFtsQuery(query);
    if (!expression) return [];
    return this.sql
      .exec(
        `SELECT m.id,m.conversation_id,m.role,m.sequence,m.created_at,
      snippet(messages_fts,0,'','', '…',64) AS excerpt
      FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.role IN ('user','assistant')
      ORDER BY m.created_at DESC,m.sequence DESC LIMIT ?`,
        expression,
        limit
      )
      .toArray();
  }

  unresolvedActions(limit: number) {
    return this.sql
      .exec(
        "SELECT id,turn_id,operation,state,created_at FROM operator_actions WHERE state IN ('uncertain','approval_required') ORDER BY created_at DESC LIMIT ?",
        limit
      )
      .toArray();
  }

  private appendMessage(id: string, role: 'user' | 'assistant', content: string): void {
    const conversationId = required(this.settings().conversationId);
    if (this.sql.exec('SELECT 1 FROM messages WHERE id=?', id).toArray().length) return;
    this.sql.exec(
      'INSERT INTO messages(id,conversation_id,role,content,sequence) SELECT ?,?,?,?,COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?',
      id,
      conversationId,
      role,
      content,
      conversationId
    );
    this.sql.exec(
      'INSERT INTO messages_fts(rowid,content) SELECT rowid,content FROM messages WHERE id=?',
      id
    );
    this.sql.exec("UPDATE conversations SET updated_at=datetime('now') WHERE id=?", conversationId);
  }

  list(limit: number, before?: { createdAt: number; id: string }): OperatorTurn[] {
    return this.sql
      .exec<OperatorTurn & Record<string, SqlStorageValue>>(
        'SELECT * FROM operator_turns WHERE conversation_id=? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?',
        required(this.settings().conversationId),
        before?.createdAt ?? Number.MAX_SAFE_INTEGER,
        before?.createdAt ?? Number.MAX_SAFE_INTEGER,
        before?.id ?? '',
        limit
      )
      .toArray()
      .reverse();
  }

  actions(turnId: string): OperatorAction[] {
    return this.sql
      .exec<OperatorAction & Record<string, SqlStorageValue>>(
        'SELECT * FROM operator_actions WHERE turn_id=? ORDER BY created_at,id',
        turnId
      )
      .toArray();
  }

  action(id: string): OperatorAction | null {
    return (
      this.sql
        .exec<OperatorAction & Record<string, SqlStorageValue>>(
          'SELECT * FROM operator_actions WHERE id=?',
          id
        )
        .toArray()[0] ?? null
    );
  }

  reserveAction(
    id: string,
    turnId: string,
    operation: string,
    input: string,
    approval: boolean
  ): OperatorAction {
    this.sql.exec(
      'INSERT OR IGNORE INTO operator_actions(id,turn_id,operation,input_json,state,created_at) VALUES(?,?,?,?,?,?)',
      id,
      turnId,
      operation,
      input,
      approval ? 'approval_required' : 'pending',
      Date.now()
    );
    return required(this.action(id));
  }

  dispatchReservation(actionId: string): SamDispatchReservation {
    this.sql.exec(
      'INSERT OR IGNORE INTO operator_dispatch_reservations VALUES(?,?)',
      actionId,
      JSON.stringify({
        taskId: ulid(),
        sessionId: ulid(),
        initialMessageId: ulid(),
        statusEventId: ulid(),
      })
    );
    const row = required(
      this.sql
        .exec(
          'SELECT identity_json FROM operator_dispatch_reservations WHERE action_id=?',
          actionId
        )
        .toArray()[0]
    );
    return v.parse(
      v.object({
        taskId: v.string(),
        sessionId: v.string(),
        initialMessageId: v.string(),
        statusEventId: v.string(),
      }),
      JSON.parse(String(row.identity_json))
    );
  }

  finishAction(id: string, state: OperatorAction['state'], result: unknown): void {
    this.sql.exec(
      'UPDATE operator_actions SET state=?,result_json=? WHERE id=?',
      state,
      JSON.stringify(result),
      id
    );
  }
}
