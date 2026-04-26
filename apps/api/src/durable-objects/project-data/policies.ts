/**
 * Project Policies — CRUD for per-project dynamic policies (Phase 4: Policy Propagation).
 *
 * Policies capture rules, constraints, delegation settings, and preferences
 * stated by humans or inferred by agents. They are stored in the ProjectData DO
 * SQLite and injected into agent instructions via get_instructions.
 */
import type { PolicyCategory, PolicySource } from '@simple-agent-manager/shared';
import { DEFAULT_POLICY_MAX_PER_PROJECT } from '@simple-agent-manager/shared';

import { parseCountCnt, parsePolicyRow } from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMaxPolicies(env: Env): number {
  return Number(env.POLICY_MAX_PER_PROJECT) || DEFAULT_POLICY_MAX_PER_PROJECT;
}

// ─── Policy CRUD ────────────────────────────────────────────────────────────

export function createPolicy(
  sql: SqlStorage,
  env: Env,
  category: PolicyCategory,
  title: string,
  content: string,
  source: PolicySource,
  sourceSessionId: string | null,
  confidence: number,
): { id: string; now: number } {
  const count = parseCountCnt(
    sql.exec('SELECT COUNT(*) as cnt FROM project_policies WHERE active = 1').toArray()[0],
    'policy_count',
  );
  if (count >= getMaxPolicies(env)) {
    throw new Error(`Maximum active policies per project (${getMaxPolicies(env)}) reached`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO project_policies (id, category, title, content, source, source_session_id, confidence, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id, category, title, content, source, sourceSessionId, confidence, now, now,
  );
  return { id, now };
}

export function getPolicy(sql: SqlStorage, policyId: string) {
  const rows = sql.exec(
    'SELECT * FROM project_policies WHERE id = ?',
    policyId,
  ).toArray();
  if (rows.length === 0) return null;
  return parsePolicyRow(rows[0]);
}

export function listPolicies(
  sql: SqlStorage,
  category: string | null,
  activeOnly: boolean,
  limit: number,
  offset: number,
): { policies: ReturnType<typeof parsePolicyRow>[]; total: number } {
  let countQuery = 'SELECT COUNT(*) as cnt FROM project_policies';
  let listQuery = 'SELECT * FROM project_policies';
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (activeOnly) {
    conditions.push('active = 1');
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  if (conditions.length > 0) {
    const where = ' WHERE ' + conditions.join(' AND ');
    countQuery += where;
    listQuery += where;
  }

  listQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const total = parseCountCnt(
    sql.exec(countQuery, ...params).toArray()[0],
    'policy_list_count',
  );

  const rows = sql.exec(listQuery, ...params, limit, offset).toArray();
  const policies = rows.map((row) => parsePolicyRow(row));

  return { policies, total };
}

export function updatePolicy(
  sql: SqlStorage,
  policyId: string,
  updates: {
    title?: string;
    content?: string;
    category?: PolicyCategory;
    active?: boolean;
    confidence?: number;
  },
): boolean {
  const existing = getPolicy(sql, policyId);
  if (!existing) return false;

  const now = Date.now();

  // Update all columns using COALESCE-style approach to avoid dynamic SQL.
  // Each field falls back to its existing value when not provided.
  sql.exec(
    'UPDATE project_policies SET title = ?, content = ?, category = ?, active = ?, confidence = ?, updated_at = ? WHERE id = ?',
    updates.title ?? existing.title,
    updates.content ?? existing.content,
    updates.category ?? existing.category,
    updates.active !== undefined ? (updates.active ? 1 : 0) : (existing.active ? 1 : 0),
    updates.confidence ?? existing.confidence,
    now,
    policyId,
  );
  return true;
}

export function removePolicy(sql: SqlStorage, policyId: string): boolean {
  const existing = getPolicy(sql, policyId);
  if (!existing) return false;

  const now = Date.now();
  sql.exec(
    'UPDATE project_policies SET active = 0, updated_at = ? WHERE id = ?',
    now, policyId,
  );
  return true;
}

/**
 * Get all active policies for injection into agent instructions.
 * Ordered by category then created_at for consistent presentation.
 */
export function getActivePolicies(sql: SqlStorage, env: Env): ReturnType<typeof parsePolicyRow>[] {
  const max = getMaxPolicies(env);
  const rows = sql.exec(
    `SELECT * FROM project_policies
     WHERE active = 1
     ORDER BY category ASC, created_at ASC
     LIMIT ?`,
    max,
  ).toArray();
  return rows.map((row) => parsePolicyRow(row));
}
