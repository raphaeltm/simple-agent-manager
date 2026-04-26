/**
 * Mission State Entries & Handoff Packets — per-project DO storage for mission orchestration.
 */
import type {
  HandoffLimits,
  MissionStateEntryType,
  MissionStateLimits,
} from '@simple-agent-manager/shared';

import { parseCountCnt, parseHandoffPacketRow, parseMissionStateEntryRow } from './row-schemas';
import { generateId } from './types';

// ─── Mission State Entries ──────────────────────────────────────────────────

export function createMissionStateEntry(
  sql: SqlStorage,
  missionId: string,
  entryType: MissionStateEntryType,
  title: string,
  content: string | null,
  sourceTaskId: string | null,
  limits: MissionStateLimits,
): { id: string; createdAt: number } {
  // Enforce limits
  const count = parseCountCnt(
    sql.exec(
      'SELECT COUNT(*) as cnt FROM mission_state_entries WHERE mission_id = ?',
      missionId,
    ).toArray()[0],
    'mission_state_entry_count',
  );
  if (count >= limits.maxStateEntries) {
    throw new Error(
      `Maximum state entries per mission (${limits.maxStateEntries}) reached`,
    );
  }

  if (title.length > limits.stateTitleMaxLength) {
    throw new Error(
      `Title exceeds maximum length (${limits.stateTitleMaxLength})`,
    );
  }
  if (content && content.length > limits.stateContentMaxLength) {
    throw new Error(
      `Content exceeds maximum length (${limits.stateContentMaxLength})`,
    );
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO mission_state_entries (id, mission_id, entry_type, title, content, source_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, missionId, entryType, title, content, sourceTaskId, now, now,
  );
  return { id, createdAt: now };
}

export function getMissionStateEntries(
  sql: SqlStorage,
  missionId: string,
  entryType?: MissionStateEntryType,
) {
  if (entryType) {
    return sql
      .exec(
        `SELECT * FROM mission_state_entries WHERE mission_id = ? AND entry_type = ? ORDER BY created_at DESC`,
        missionId, entryType,
      )
      .toArray()
      .map(parseMissionStateEntryRow);
  }
  return sql
    .exec(
      `SELECT * FROM mission_state_entries WHERE mission_id = ? ORDER BY created_at DESC`,
      missionId,
    )
    .toArray()
    .map(parseMissionStateEntryRow);
}

export function getMissionStateEntry(sql: SqlStorage, entryId: string) {
  const rows = sql
    .exec('SELECT * FROM mission_state_entries WHERE id = ?', entryId)
    .toArray();
  if (rows.length === 0) return null;
  return parseMissionStateEntryRow(rows[0]);
}

export function updateMissionStateEntry(
  sql: SqlStorage,
  entryId: string,
  updates: { title?: string; content?: string | null },
  limits: MissionStateLimits,
) {
  if (updates.title && updates.title.length > limits.stateTitleMaxLength) {
    throw new Error(
      `Title exceeds maximum length (${limits.stateTitleMaxLength})`,
    );
  }
  if (updates.content && updates.content.length > limits.stateContentMaxLength) {
    throw new Error(
      `Content exceeds maximum length (${limits.stateContentMaxLength})`,
    );
  }

  const now = Date.now();
  const setClauses: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }
  if (updates.content !== undefined) {
    setClauses.push('content = ?');
    params.push(updates.content);
  }

  params.push(entryId);
  sql.exec(
    `UPDATE mission_state_entries SET ${setClauses.join(', ')} WHERE id = ?`,
    ...params,
  );
}

export function deleteMissionStateEntry(sql: SqlStorage, entryId: string): boolean {
  const existing = sql
    .exec('SELECT id FROM mission_state_entries WHERE id = ?', entryId)
    .toArray();
  if (existing.length === 0) return false;
  sql.exec('DELETE FROM mission_state_entries WHERE id = ?', entryId);
  return true;
}

// ─── Handoff Packets ─────────���──────────────────────────────────────────────

export function createHandoffPacket(
  sql: SqlStorage,
  missionId: string,
  fromTaskId: string,
  toTaskId: string | null,
  summary: string,
  facts: unknown[],
  openQuestions: string[],
  artifactRefs: unknown[],
  suggestedActions: string[],
  limits: HandoffLimits,
): { id: string; createdAt: number } {
  // Enforce limits
  const count = parseCountCnt(
    sql.exec(
      'SELECT COUNT(*) as cnt FROM handoff_packets WHERE mission_id = ?',
      missionId,
    ).toArray()[0],
    'handoff_packet_count',
  );
  if (count >= limits.maxHandoffs) {
    throw new Error(
      `Maximum handoff packets per mission (${limits.maxHandoffs}) reached`,
    );
  }

  if (summary.length > limits.summaryMaxLength) {
    throw new Error(
      `Summary exceeds maximum length (${limits.summaryMaxLength})`,
    );
  }
  if (facts.length > limits.maxFacts) {
    throw new Error(`Maximum facts per handoff (${limits.maxFacts}) exceeded`);
  }
  if (openQuestions.length > limits.maxOpenQuestions) {
    throw new Error(
      `Maximum open questions per handoff (${limits.maxOpenQuestions}) exceeded`,
    );
  }
  if (artifactRefs.length > limits.maxArtifactRefs) {
    throw new Error(
      `Maximum artifact refs per handoff (${limits.maxArtifactRefs}) exceeded`,
    );
  }
  if (suggestedActions.length > limits.maxSuggestedActions) {
    throw new Error(
      `Maximum suggested actions per handoff (${limits.maxSuggestedActions}) exceeded`,
    );
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO handoff_packets (id, mission_id, from_task_id, to_task_id, summary, facts, open_questions, artifact_refs, suggested_actions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    missionId,
    fromTaskId,
    toTaskId,
    summary,
    JSON.stringify(facts),
    JSON.stringify(openQuestions),
    JSON.stringify(artifactRefs),
    JSON.stringify(suggestedActions),
    now,
  );
  return { id, createdAt: now };
}

export function getHandoffPackets(sql: SqlStorage, missionId: string) {
  return sql
    .exec(
      `SELECT * FROM handoff_packets WHERE mission_id = ? ORDER BY created_at DESC`,
      missionId,
    )
    .toArray()
    .map(parseHandoffPacketRow);
}

export function getHandoffPacket(sql: SqlStorage, handoffId: string) {
  const rows = sql
    .exec('SELECT * FROM handoff_packets WHERE id = ?', handoffId)
    .toArray();
  if (rows.length === 0) return null;
  return parseHandoffPacketRow(rows[0]);
}

export function getHandoffPacketsForTask(sql: SqlStorage, taskId: string) {
  return sql
    .exec(
      `SELECT * FROM handoff_packets WHERE from_task_id = ? OR to_task_id = ? ORDER BY created_at DESC`,
      taskId, taskId,
    )
    .toArray()
    .map(parseHandoffPacketRow);
}
