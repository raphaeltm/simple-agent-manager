import { describe, expect, it } from 'vitest';
import {
  evaluateGitleaksFindings,
  gitleaksArgsForMode,
  redactSecretScanOutput,
} from './check-secret-scan-policy';

describe('secret scan policy', () => {
  it('fails closed on findings while redacting secret and match fields', () => {
    const raw = JSON.stringify([
      {
        RuleID: 'synthetic-rule',
        File: 'fixtures/example.txt',
        StartLine: 1,
        Secret: 'synthetic-not-a-real-secret-value',
        Match: 'TOKEN=synthetic-not-a-real-secret-value',
      },
    ]);

    const result = evaluateGitleaksFindings(raw);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-not-a-real-secret-value');
    expect(result.sanitizedFindings).toEqual([
      { RuleID: 'synthetic-rule', File: 'fixtures/example.txt', StartLine: 1 },
    ]);
  });

  it('redacts raw command output before logs or artifacts can expose values', () => {
    const redacted = redactSecretScanOutput(
      '{"Secret":"synthetic-not-a-real-secret-value","Match":"TOKEN=synthetic-not-a-real-secret-value"}'
    );

    expect(redacted).not.toContain('synthetic-not-a-real-secret-value');
    expect(redacted).toContain('[REDACTED]');
  });

  it('uses current-tree and explicit PR-range modes without full-history scan arguments', () => {
    expect(gitleaksArgsForMode('current-tree')).toEqual([
      'detect',
      '--no-git',
      '--redact',
      '--report-format=json',
    ]);
    expect(gitleaksArgsForMode('pr-range', 'origin/base..HEAD')).toEqual([
      'detect',
      '--log-opts',
      'origin/base..HEAD',
      '--redact',
      '--report-format=json',
    ]);
  });
});
