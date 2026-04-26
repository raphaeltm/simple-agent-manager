/**
 * Unit tests for the Policy Propagation system (Phase 4).
 *
 * Tests verify:
 * - Shared types and constants
 * - Policy row parsing from DO SQLite
 * - Policy limits resolution from env vars
 * - Configurable defaults via env
 */
import { describe, expect, it } from 'vitest';

import {
  isPolicyCategory,
  isPolicySource,
  POLICY_CATEGORIES,
  POLICY_DEFAULTS,
  POLICY_SOURCES,
  resolvePolicyLimits,
} from '@simple-agent-manager/shared';

import {
  parsePolicyRow,
} from '../../src/durable-objects/project-data/row-schemas';

// ─── Shared Types & Guards ──────────────────────────────────────────────────

describe('Policy shared types', () => {
  it('defines valid categories', () => {
    expect(POLICY_CATEGORIES).toEqual(['rule', 'constraint', 'delegation', 'preference']);
  });

  it('defines valid sources', () => {
    expect(POLICY_SOURCES).toEqual(['explicit', 'inferred']);
  });

  it('isPolicyCategory accepts valid values', () => {
    for (const cat of POLICY_CATEGORIES) {
      expect(isPolicyCategory(cat)).toBe(true);
    }
    expect(isPolicyCategory('invalid')).toBe(false);
    expect(isPolicyCategory('')).toBe(false);
  });

  it('isPolicySource accepts valid values', () => {
    for (const src of POLICY_SOURCES) {
      expect(isPolicySource(src)).toBe(true);
    }
    expect(isPolicySource('invalid')).toBe(false);
    expect(isPolicySource('')).toBe(false);
  });

  it('has correct defaults', () => {
    expect(POLICY_DEFAULTS.maxPerProject).toBe(100);
    expect(POLICY_DEFAULTS.titleMaxLength).toBe(200);
    expect(POLICY_DEFAULTS.contentMaxLength).toBe(2000);
    expect(POLICY_DEFAULTS.listPageSize).toBe(50);
    expect(POLICY_DEFAULTS.listMaxPageSize).toBe(200);
    expect(POLICY_DEFAULTS.defaultConfidence).toBe(0.8);
  });
});

// ─── Policy Limits Resolution ───────────────────────────────────────────────

describe('resolvePolicyLimits', () => {
  it('returns defaults when no env vars set', () => {
    const limits = resolvePolicyLimits({});
    expect(limits.maxPerProject).toBe(100);
    expect(limits.titleMaxLength).toBe(200);
    expect(limits.contentMaxLength).toBe(2000);
    expect(limits.listPageSize).toBe(50);
    expect(limits.listMaxPageSize).toBe(200);
    expect(limits.defaultConfidence).toBe(0.8);
  });

  it('overrides from env vars', () => {
    const limits = resolvePolicyLimits({
      POLICY_MAX_PER_PROJECT: '50',
      POLICY_TITLE_MAX_LENGTH: '100',
      POLICY_CONTENT_MAX_LENGTH: '500',
      POLICY_LIST_PAGE_SIZE: '25',
      POLICY_LIST_MAX_PAGE_SIZE: '100',
      POLICY_DEFAULT_CONFIDENCE: '0.9',
    });
    expect(limits.maxPerProject).toBe(50);
    expect(limits.titleMaxLength).toBe(100);
    expect(limits.contentMaxLength).toBe(500);
    expect(limits.listPageSize).toBe(25);
    expect(limits.listMaxPageSize).toBe(100);
    expect(limits.defaultConfidence).toBe(0.9);
  });

  it('falls back to defaults for invalid env values', () => {
    const limits = resolvePolicyLimits({
      POLICY_MAX_PER_PROJECT: 'not-a-number',
      POLICY_DEFAULT_CONFIDENCE: 'abc',
    });
    expect(limits.maxPerProject).toBe(100);
    expect(limits.defaultConfidence).toBe(0.8);
  });
});

// ─── Row Parsing ────────────────────────────────────────────────────────────

describe('parsePolicyRow', () => {
  const validRow = {
    id: 'pol_01',
    category: 'rule',
    title: 'Always use conventional commits',
    content: 'Commit messages must follow conventional commit format.',
    source: 'explicit',
    source_session_id: 'sess_01',
    confidence: 0.95,
    active: 1,
    created_at: 1714000000,
    updated_at: 1714000000,
  };

  it('parses a valid policy row', () => {
    const result = parsePolicyRow(validRow);
    expect(result.id).toBe('pol_01');
    expect(result.category).toBe('rule');
    expect(result.title).toBe('Always use conventional commits');
    expect(result.content).toBe('Commit messages must follow conventional commit format.');
    expect(result.source).toBe('explicit');
    expect(result.sourceSessionId).toBe('sess_01');
    expect(result.confidence).toBe(0.95);
    expect(result.active).toBe(true);
    expect(result.createdAt).toBe(1714000000);
    expect(result.updatedAt).toBe(1714000000);
  });

  it('handles null source_session_id', () => {
    const row = { ...validRow, source_session_id: null };
    const result = parsePolicyRow(row);
    expect(result.sourceSessionId).toBeNull();
  });

  it('handles active as boolean', () => {
    const row = { ...validRow, active: true };
    const result = parsePolicyRow(row);
    expect(result.active).toBe(true);
  });

  it('converts active=0 to false', () => {
    const row = { ...validRow, active: 0 };
    const result = parsePolicyRow(row);
    expect(result.active).toBe(false);
  });

  it('throws on missing required fields', () => {
    expect(() => parsePolicyRow({ id: 'pol_01' })).toThrow();
  });

  it('throws on null input', () => {
    expect(() => parsePolicyRow(null)).toThrow();
  });
});
