/**
 * Project Policies — CRUD for per-project dynamic policies (Phase 4: Policy Propagation).
 *
 * Policies capture rules, constraints, delegation settings, and preferences
 * stated by humans or inferred by agents. They are stored in the ProjectData DO
 * SQLite and injected into agent instructions via get_instructions.
 */
import type { PolicyCategory, PolicyScope, PolicySource } from '@simple-agent-manager/shared';
import { DEFAULT_POLICY_MAX_PER_PROJECT } from '@simple-agent-manager/shared';

import { parseCountCnt, parsePolicyRow } from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMaxPolicies(env: Env): number {
  return Number(env.POLICY_MAX_PER_PROJECT) || DEFAULT_POLICY_MAX_PER_PROJECT;
}

/**
 * The "still applies right now" predicate.
 *
 * A policy applies when it is active AND either has no expiry or has not reached
 * it yet. Expiry is evaluated at READ time — there is deliberately no sweep, cron,
 * or alarm that flips expired rows to inactive (rule 47: no new control loop for
 * something a WHERE clause answers for free).
 *
 * Note what this predicate is NOT applied to: `getPolicy` and `listPolicies` both
 * keep returning expired policies, because a human needs to be able to see that a
 * policy exists and why it stopped applying. Only the agent-injection read filters.
 */
const APPLIES_NOW_SQL = 'active = 1 AND (expires_at IS NULL OR expires_at > ?)';

/**
 * The two statements that apply the predicate above, composed ONCE here at module
 * scope rather than interpolated at the `sql.exec()` call sites.
 *
 * Both forms would execute identically, but composing here means the string handed
 * to `sql.exec()` is a fixed load-time constant with no call-site interpolation at
 * all — which is what `scripts/quality/ast-checks.ts` (`sql-injection`,
 * `parameterized-sql`) requires, and it keeps every executed statement greppable in
 * one place. The predicate itself stays single-sourced, so the cap count and the
 * injection read cannot drift apart.
 *
 * Placeholder order matters: the `?` inside APPLIES_NOW_SQL binds `now`, and the
 * trailing `LIMIT ?` binds the cap.
 */
const COUNT_APPLIES_NOW_SQL = `SELECT COUNT(*) as cnt FROM project_policies WHERE ${APPLIES_NOW_SQL}`;

const SELECT_APPLIES_NOW_SQL = `SELECT * FROM project_policies
     WHERE ${APPLIES_NOW_SQL}
     ORDER BY category ASC, created_at ASC
     LIMIT ?`;

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
  scope: PolicyScope = 'always',
  expiresAt: number | null = null,
): { id: string; now: number } {
  const now = Date.now();

  // Final server-side guard on the scope/expiry invariant — see updatePolicy.
  if (scope === 'task' && expiresAt === null) {
    throw new Error(
      "a task-scoped policy must set expiresAt so it cannot outlive the work it was captured for (use scope 'always' for a standing policy)",
    );
  }

  // The per-project cap counts only policies that still apply. An expired policy is
  // inert — it is injected into nothing — so letting it consume cap headroom would
  // slowly wedge projects that use short-lived task-scoped policies.
  //
  // KNOWN CHARACTERISTIC: because an expired row is deliberately retained (so a human
  // can still see in `list_policies` / the UI that the policy existed and when it
  // lapsed), total row count is bounded by human/agent write volume rather than by
  // this cap. Adding a naive hard total ceiling would be worse than the growth it
  // prevents: `removePolicy` is a soft delete, so a project that hit the ceiling
  // could never write a policy again. Sizing that ceiling against a real retention
  // or hard-delete path is tracked in
  // tasks/backlog/2026-08-23-policy-row-retention-bound.md (rule 42 — tracked, not silent).
  const count = parseCountCnt(
    sql.exec(COUNT_APPLIES_NOW_SQL, now).toArray()[0],
    'policy_count',
  );
  if (count >= getMaxPolicies(env)) {
    throw new Error(`Maximum active policies per project (${getMaxPolicies(env)}) reached`);
  }

  const id = generateId();
  sql.exec(
    `INSERT INTO project_policies (id, category, title, content, source, source_session_id, confidence, active, scope, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    id, category, title, content, source, sourceSessionId, confidence, scope, expiresAt, now, now,
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
    scope?: PolicyScope;
    expiresAt?: number | null;
  },
): boolean {
  const existing = getPolicy(sql, policyId);
  if (!existing) return false;

  const now = Date.now();

  // Final server-side guard on the scope/expiry invariant, evaluated against the
  // merged post-write state. Both callers (MCP tool handler and REST route) already
  // validate with the same shared helper and produce a friendlier message; this is
  // the choke point that a future third writer cannot bypass (rules 44 / 51).
  const effectiveScope = updates.scope ?? existing.scope;
  const effectiveExpiresAt =
    updates.expiresAt !== undefined ? updates.expiresAt : existing.expiresAt;
  if (effectiveScope === 'task' && effectiveExpiresAt === null) {
    throw new Error(
      "a task-scoped policy must set expiresAt so it cannot outlive the work it was captured for (use scope 'always' for a standing policy)",
    );
  }

  // Update all columns using COALESCE-style approach to avoid dynamic SQL.
  // Each field falls back to its existing value when not provided.
  //
  // `expiresAt` deliberately uses an explicit `!== undefined` check rather than the
  // `??` idiom used above: `null` is a MEANINGFUL value here (it clears an expiry
  // and makes the policy permanent), and `updates.expiresAt ?? existing.expiresAt`
  // would silently treat "clear this expiry" as "leave it alone".
  sql.exec(
    'UPDATE project_policies SET title = ?, content = ?, category = ?, active = ?, confidence = ?, scope = ?, expires_at = ?, updated_at = ? WHERE id = ?',
    updates.title ?? existing.title,
    updates.content ?? existing.content,
    updates.category ?? existing.category,
    updates.active !== undefined ? (updates.active ? 1 : 0) : (existing.active ? 1 : 0),
    updates.confidence ?? existing.confidence,
    updates.scope ?? existing.scope,
    updates.expiresAt !== undefined ? updates.expiresAt : existing.expiresAt,
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
 * Get the policies that currently apply, for injection into agent instructions.
 * Ordered by category then created_at for consistent presentation.
 *
 * Expired policies are filtered out HERE rather than by a background sweep, so a
 * one-shot policy stops costing tokens in every session the moment it lapses,
 * with no new control loop to own (rule 47). The row stays in the table and stays
 * `active`, so `get_policy` and `list_policies` can still show a human that it
 * existed and when it lapsed.
 */
export function getActivePolicies(
  sql: SqlStorage,
  env: Env,
  now: number = Date.now(),
): ReturnType<typeof parsePolicyRow>[] {
  const max = getMaxPolicies(env);
  const rows = sql.exec(SELECT_APPLIES_NOW_SQL, now, max).toArray();
  return rows.map((row) => parsePolicyRow(row));
}
