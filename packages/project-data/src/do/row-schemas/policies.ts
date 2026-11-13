import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Project Policy row schemas (Phase 4: Policy Propagation)
// =============================================================================

const PolicyRowSchema = v.object({
  id: v.string(),
  category: v.string(),
  title: v.string(),
  content: v.string(),
  source: v.string(),
  source_session_id: v.nullable(v.string()),
  confidence: v.number(),
  active: v.union([v.number(), v.boolean()]),
  // Lifecycle columns added by DO migration 034. Both are tolerated as absent so a
  // row read through a stale/partial schema degrades to the pre-migration defaults
  // instead of throwing and taking the whole read down (rule 50).
  expires_at: v.optional(v.nullable(v.number())),
  scope: v.optional(v.nullable(v.string())),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parsePolicyRow(row: unknown): {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  sourceSessionId: string | null;
  confidence: number;
  active: boolean;
  scope: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
} {
  const r = parseRow(PolicyRowSchema, row, 'project_policy');
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    content: r.content,
    source: r.source,
    sourceSessionId: r.source_session_id,
    confidence: r.confidence,
    active: r.active === 1 || r.active === true,
    scope: r.scope ?? 'always',
    expiresAt: r.expires_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
