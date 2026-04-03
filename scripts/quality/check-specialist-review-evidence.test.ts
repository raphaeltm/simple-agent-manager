import { describe, expect, it } from 'vitest';

import {
  extractReviewSection,
  hasNeedsHumanReviewLabel,
  isAgentAuthored,
  isExplicitHumanNA,
  parseReviewTable,
  validateReviewEvidence,
} from './check-specialist-review-evidence.js';

// ---------------------------------------------------------------------------
// Helper to build a PR body with a review evidence section
// ---------------------------------------------------------------------------
function buildBody(options: {
  rows?: string[];
  extraSections?: string;
  agentAuthored?: boolean;
  humanNA?: boolean;
  omitSection?: boolean;
}) {
  const coAuthor = options.agentAuthored
    ? '\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'
    : '';

  if (options.omitSection) {
    return `## Summary\n\nSome PR description.${coAuthor}`;
  }

  const tableHeader = '| Reviewer | Status | Outcome |\n|----------|--------|---------|';
  const tableRows = options.rows?.join('\n') ?? '';
  const humanNA = options.humanNA ? '\nN/A: human-authored PR\n' : '';

  return `## Summary

Some PR description.

## Specialist Review Evidence

${humanNA}${options.rows ? `${tableHeader}\n${tableRows}` : ''}

${options.extraSections ?? ''}${coAuthor}`;
}

// ---------------------------------------------------------------------------
// extractReviewSection
// ---------------------------------------------------------------------------
describe('extractReviewSection', () => {
  it('extracts the section when present', () => {
    const body = buildBody({ rows: ['| go-specialist | PASS | no findings |'] });
    const section = extractReviewSection(body);
    expect(section).toBeTruthy();
    expect(section).toContain('go-specialist');
  });

  it('returns null when section is missing', () => {
    const body = '## Summary\n\nJust a PR.';
    expect(extractReviewSection(body)).toBeNull();
  });

  it('stops at the next ## heading', () => {
    const body = `## Specialist Review Evidence

| Reviewer | Status | Outcome |
|----------|--------|---------|
| test | PASS | ok |

## Exceptions

Some exception content.`;

    const section = extractReviewSection(body);
    expect(section).toContain('test');
    expect(section).not.toContain('Exceptions');
  });

  it('stops at ## heading without a preceding blank line (H2)', () => {
    const body = `## Specialist Review Evidence\n| Reviewer | Status | Outcome |\n|---|---|---|\n| test | PASS | ok |\n## Next Section\nContent.`;
    const section = extractReviewSection(body);
    expect(section).not.toContain('Next Section');
  });
});

// ---------------------------------------------------------------------------
// parseReviewTable
// ---------------------------------------------------------------------------
describe('parseReviewTable', () => {
  it('parses valid table rows', () => {
    const section = `
| Reviewer | Status | Outcome |
|----------|--------|---------|
| go-specialist | PASS | no critical findings |
| security-auditor | ADDRESSED | 2 HIGH fixed in commit abc123 |
`;
    const rows = parseReviewTable(section);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      reviewer: 'go-specialist',
      status: 'PASS',
      outcome: 'no critical findings',
    });
    expect(rows[1]).toEqual({
      reviewer: 'security-auditor',
      status: 'ADDRESSED',
      outcome: '2 HIGH fixed in commit abc123',
    });
  });

  it('skips HTML comment rows (template placeholders)', () => {
    const section = `
| Reviewer | Status | Outcome |
|----------|--------|---------|
| <!-- e.g. go-specialist --> | <!-- PASS / ADDRESSED / DISPATCHED / FAILED --> | <!-- summary --> |
`;
    const rows = parseReviewTable(section);
    expect(rows).toHaveLength(0);
  });

  it('returns empty array when no table exists', () => {
    const section = 'No table here, just text.';
    expect(parseReviewTable(section)).toHaveLength(0);
  });

  it('handles malformed rows gracefully', () => {
    const section = `
| Reviewer | Status | Outcome |
|----------|--------|---------|
| incomplete-row |
| valid-reviewer | PASS | ok |
`;
    const rows = parseReviewTable(section);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewer).toBe('valid-reviewer');
  });

  it('normalizes status to uppercase', () => {
    const section = `
| Reviewer | Status | Outcome |
|----------|--------|---------|
| test | pass | ok |
`;
    const rows = parseReviewTable(section);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PASS');
  });

  it('handles pipe characters in the outcome column (M1)', () => {
    const section = `| Reviewer | Status | Outcome |\n|---|---|---|\n| test | PASS | fixed HIGH | MEDIUM |`;
    const rows = parseReviewTable(section);
    expect(rows[0]?.outcome).toBe('fixed HIGH | MEDIUM');
  });

  it('handles padded whitespace in cells (M4)', () => {
    const section = `
| Reviewer           | Status   | Outcome              |
|--------------------|----------|----------------------|
| go-specialist      | PASS     | no findings          |
`;
    const rows = parseReviewTable(section);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewer).toBe('go-specialist');
    expect(rows[0]?.status).toBe('PASS');
    expect(rows[0]?.outcome).toBe('no findings');
  });
});

// ---------------------------------------------------------------------------
// isAgentAuthored
// ---------------------------------------------------------------------------
describe('isAgentAuthored', () => {
  it('detects Co-Authored-By: Claude', () => {
    expect(isAgentAuthored('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>')).toBe(true);
  });

  it('returns false for human PRs', () => {
    expect(isAgentAuthored('Just a normal PR body.')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAgentAuthored('co-authored-by: claude')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isExplicitHumanNA
// ---------------------------------------------------------------------------
describe('isExplicitHumanNA', () => {
  it('detects N/A: human-authored PR', () => {
    expect(isExplicitHumanNA('N/A: human-authored PR')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isExplicitHumanNA('n/a: Human-Authored PR')).toBe(true);
  });

  it('returns false for other content', () => {
    expect(isExplicitHumanNA('Some other text')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasNeedsHumanReviewLabel
// ---------------------------------------------------------------------------
describe('hasNeedsHumanReviewLabel', () => {
  it('detects the label', () => {
    expect(hasNeedsHumanReviewLabel([{ name: 'needs-human-review' }])).toBe(true);
  });

  it('returns false when label is absent', () => {
    expect(hasNeedsHumanReviewLabel([{ name: 'bug' }, { name: 'enhancement' }])).toBe(false);
  });

  it('handles empty labels', () => {
    expect(hasNeedsHumanReviewLabel([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateReviewEvidence — integration tests
// ---------------------------------------------------------------------------
describe('validateReviewEvidence', () => {
  // --- PASS cases ---

  it('passes when all reviewers show PASS', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: [
        '| go-specialist | PASS | no critical findings |',
        '| security-auditor | PASS | no critical findings |',
      ],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.reviewers).toHaveLength(2);
  });

  it('passes when all reviewers show ADDRESSED', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| security-auditor | ADDRESSED | 2 HIGH fixed in abc123 |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
  });

  it('passes with mix of PASS and ADDRESSED', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: [
        '| go-specialist | PASS | no findings |',
        '| security-auditor | ADDRESSED | fixed |',
      ],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
  });

  it('passes for human-authored PRs without the section', () => {
    const body = buildBody({ omitSection: true, agentAuthored: false });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
  });

  it('passes for explicit N/A: human-authored PR', () => {
    const body = buildBody({ humanNA: true, agentAuthored: true });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
  });

  it('passes with DEFERRED status but warns', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| test-engineer | DEFERRED | deferred to backlog |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('DEFERRED');
  });

  // --- FAIL cases ---

  it('fails when any reviewer shows DISPATCHED', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: [
        '| go-specialist | PASS | no findings |',
        '| security-auditor | DISPATCHED | launched but not returned |',
      ],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('DISPATCHED');
    expect(result.failures[0]).toContain('security-auditor');
  });

  it('fails when any reviewer shows FAILED', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| go-specialist | FAILED | timed out |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('FAILED');
  });

  it('fails when needs-human-review label is present', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| go-specialist | PASS | ok |'],
    });
    const result = validateReviewEvidence(body, [{ name: 'needs-human-review' }]);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('needs-human-review');
  });

  it('fails when agent-authored PR has no review section', () => {
    const body = buildBody({ omitSection: true, agentAuthored: true });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('missing');
  });

  it('fails when agent-authored PR has empty table', () => {
    const body = buildBody({ agentAuthored: true, rows: [] });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('empty');
  });

  it('fails with unrecognized status', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| test | UNKNOWN_STATUS | something |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('unrecognized status');
  });

  it('fails with mixed statuses where one is blocking', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: [
        '| go-specialist | PASS | ok |',
        '| security-auditor | PASS | ok |',
        '| cloudflare-specialist | DISPATCHED | pending |',
      ],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('cloudflare-specialist');
  });

  // --- Edge cases ---

  it('handles table with only comment/template rows as empty', () => {
    const body = `## Summary

Some PR.

## Specialist Review Evidence

| Reviewer | Status | Outcome |
|----------|--------|---------|
| <!-- e.g. go-specialist --> | <!-- PASS --> | <!-- summary --> |

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;

    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('empty');
  });

  it('handles needs-human-review label with other labels', () => {
    const result = validateReviewEvidence('## Summary\n\nSome PR.', [
      { name: 'enhancement' },
      { name: 'needs-human-review' },
      { name: 'bug' },
    ]);
    expect(result.pass).toBe(false);
  });

  it('handles case-insensitive status matching', () => {
    const body = buildBody({
      agentAuthored: true,
      rows: ['| test | dispatched | still running |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('DISPATCHED');
  });

  // --- Reviewer-requested edge cases (C1, H1, H2, H3, M1) ---

  it('label-only failure does not mention missing section (C1)', () => {
    const body = buildBody({ agentAuthored: true, omitSection: true });
    const result = validateReviewEvidence(body, [{ name: 'needs-human-review' }]);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('needs-human-review');
    expect(result.failures[0]).not.toContain('missing');
    expect(result.failures[0]).not.toContain('empty');
  });

  it('passes for human-authored PR with empty table (H1)', () => {
    const body = buildBody({ agentAuthored: false, rows: [] });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('passes and ignores table rows when N/A marker is present (H3)', () => {
    const body = buildBody({
      agentAuthored: true,
      humanNA: true,
      rows: ['| go-specialist | DISPATCHED | still running |'],
    });
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when agent-authored PR has section but no table header (L3)', () => {
    const body = `## Summary\n\nSome PR.\n\n## Specialist Review Evidence\n\nReviews were conducted verbally.\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;
    const result = validateReviewEvidence(body, []);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('empty');
  });
});
