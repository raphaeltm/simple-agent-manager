import { describe, expect, it } from 'vitest';

import {
  analyzeRepeatedErrors,
  analyzeSeverityMismatches,
  buildSuccessPatternClause,
  formatReport,
  SUCCESS_PATTERNS,
} from './check-observability-noise';

describe('check-observability-noise', () => {
  describe('SUCCESS_PATTERNS', () => {
    it('includes expected lifecycle terms', () => {
      expect(SUCCESS_PATTERNS).toContain('started');
      expect(SUCCESS_PATTERNS).toContain('connected');
      expect(SUCCESS_PATTERNS).toContain('healthy');
      expect(SUCCESS_PATTERNS).toContain('running');
      expect(SUCCESS_PATTERNS).toContain('completed');
      expect(SUCCESS_PATTERNS).toContain('heartbeat');
    });
  });

  describe('buildSuccessPatternClause', () => {
    it('produces OR-joined LIKE clauses for the given column', () => {
      const clause = buildSuccessPatternClause('message');
      expect(clause).toContain("message LIKE '%started%'");
      expect(clause).toContain("message LIKE '%healthy%'");
      expect(clause).toContain(' OR ');
      // Should have one clause per pattern
      const orCount = (clause.match(/ OR /g) ?? []).length;
      expect(orCount).toBe(SUCCESS_PATTERNS.length - 1);
    });
  });

  describe('analyzeRepeatedErrors', () => {
    it('returns empty for rows below threshold', () => {
      const rows = [{ message: 'some error', cnt: 5 }];
      const findings = analyzeRepeatedErrors(rows, 10);
      expect(findings).toHaveLength(0);
    });

    it('flags rows at or above threshold', () => {
      const rows = [
        { message: 'timeout connecting', cnt: 15 },
        { message: 'another error', cnt: 10 },
      ];
      const findings = analyzeRepeatedErrors(rows, 10);
      expect(findings).toHaveLength(2);
      expect(findings[0].category).toBe('repeated-error');
      expect(findings[0].count).toBe(15);
    });

    it('detects ingest-401 pattern', () => {
      const rows = [
        { message: 'POST /api/admin/observability/logs/ingest returned 401', cnt: 50 },
      ];
      const findings = analyzeRepeatedErrors(rows, 10);
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('ingest-401');
      expect(findings[0].severity).toBe('high');
    });

    it('truncates long messages to 120 chars', () => {
      const longMsg = 'x'.repeat(200);
      const rows = [{ message: longMsg, cnt: 20 }];
      const findings = analyzeRepeatedErrors(rows, 10);
      expect(findings[0].message.length).toBeLessThanOrEqual(123); // 120 + '...'
    });
  });

  describe('analyzeSeverityMismatches', () => {
    it('returns empty for rows below threshold', () => {
      const rows = [{ message: 'VM agent started', cnt: 2 }];
      const findings = analyzeSeverityMismatches(rows, 5);
      expect(findings).toHaveLength(0);
    });

    it('flags success-like messages at threshold', () => {
      const rows = [
        { message: 'workspace container started successfully', cnt: 10 },
        { message: 'node heartbeat received', cnt: 8 },
      ];
      const findings = analyzeSeverityMismatches(rows, 5);
      expect(findings).toHaveLength(2);
      expect(findings[0].category).toBe('severity-mismatch');
      expect(findings[0].severity).toBe('medium');
    });
  });

  describe('formatReport', () => {
    it('reports no noise when empty', () => {
      const report = formatReport([]);
      expect(report).toContain('No significant log noise detected');
    });

    it('groups findings by severity', () => {
      const findings = [
        { category: 'ingest-401' as const, severity: 'high' as const, message: 'ingest 401', count: 50 },
        { category: 'severity-mismatch' as const, severity: 'medium' as const, message: 'started ok', count: 12 },
      ];
      const report = formatReport(findings);
      expect(report).toContain('HIGH SEVERITY');
      expect(report).toContain('MEDIUM SEVERITY');
      expect(report).toContain('ingest-401');
      expect(report).toContain('(50x)');
      expect(report).toContain('Total findings: 2');
    });
  });
});
