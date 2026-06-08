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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
