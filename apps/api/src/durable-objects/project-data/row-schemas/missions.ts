import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Mission state entry row schema
// =============================================================================

const MissionStateEntryRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  entry_type: v.string(),
  title: v.string(),
  content: v.nullable(v.string()),
  source_task_id: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parseMissionStateEntryRow(row: unknown) {
  const r = parseRow(MissionStateEntryRowSchema, row, 'mission_state_entry');
  return {
    id: r.id,
    missionId: r.mission_id,
    entryType: r.entry_type,
    title: r.title,
    content: r.content,
    sourceTaskId: r.source_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// =============================================================================
// Handoff packet row schema
// =============================================================================

const HandoffPacketRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  from_task_id: v.string(),
  to_task_id: v.nullable(v.string()),
  summary: v.string(),
  facts: v.nullable(v.string()),
  open_questions: v.nullable(v.string()),
  artifact_refs: v.nullable(v.string()),
  suggested_actions: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseHandoffPacketRow(row: unknown) {
  const r = parseRow(HandoffPacketRowSchema, row, 'handoff_packet');
  return {
    id: r.id,
    missionId: r.mission_id,
    fromTaskId: r.from_task_id,
    toTaskId: r.to_task_id,
    summary: r.summary,
    facts: r.facts ? JSON.parse(r.facts) : [],
    openQuestions: r.open_questions ? JSON.parse(r.open_questions) : [],
    artifactRefs: r.artifact_refs ? JSON.parse(r.artifact_refs) : [],
    suggestedActions: r.suggested_actions ? JSON.parse(r.suggested_actions) : [],
    createdAt: r.created_at,
  };
}
