import { createHash } from 'node:crypto';

export interface SecretFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Secret?: string;
  Match?: string;
}

export interface ReviewedSecretFindingGroup {
  classification: 'code-identifier' | 'documented-example' | 'synthetic-test-fixture';
  reason: string;
  owner: string;
  reviewedAt: string;
  expiresAt: string;
  digests: string[];
}

export interface SecretFindingBaseline {
  version: 1;
  matcherVersion: 'gitleaks-finding-v2-unredacted';
  baseCommit: string;
  groups: ReviewedSecretFindingGroup[];
}

export interface SecretScanResult {
  ok: boolean;
  totalFindingCount: number;
  reviewedFindingCount: number;
  newFindingCount: number;
  errors: string[];
}

export function redactSecretScanOutput(output: string): string {
  return output
    .replace(/("Secret"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/("Match"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, '$1[REDACTED]');
}

function normalizeFindingPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function secretFindingDigest(finding: SecretFinding): string | undefined {
  if (
    typeof finding.RuleID !== 'string' ||
    typeof finding.File !== 'string' ||
    !Number.isInteger(finding.StartLine) ||
    typeof finding.Secret !== 'string' ||
    typeof finding.Match !== 'string'
  ) {
    return undefined;
  }
  if (/\[?REDACTED\]?/i.test(finding.Secret) || /\[?REDACTED\]?/i.test(finding.Match)) {
    return undefined;
  }

  return createHash('sha256')
    .update(
      JSON.stringify([
        'gitleaks-finding-v2-unredacted',
        finding.RuleID,
        normalizeFindingPath(finding.File),
        finding.StartLine,
        finding.Secret,
        finding.Match,
      ])
    )
    .digest('hex');
}

function parseBaseline(rawJson: string, now: Date): { digests: Set<string>; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    return { digests: new Set(), errors: ['The reviewed Gitleaks baseline was not valid JSON.'] };
  }

  const baseline = parsed as Partial<SecretFindingBaseline>;
  if (
    typeof baseline !== 'object' ||
    baseline === null ||
    baseline.version !== 1 ||
    baseline.matcherVersion !== 'gitleaks-finding-v2-unredacted' ||
    typeof baseline.baseCommit !== 'string' ||
    !Array.isArray(baseline.groups)
  ) {
    return { digests: new Set(), errors: ['The reviewed Gitleaks baseline schema was invalid.'] };
  }

  const digests = new Set<string>();
  for (const group of baseline.groups) {
    const reviewed = group as Partial<ReviewedSecretFindingGroup>;
    const expiry =
      typeof reviewed.expiresAt === 'string' ? new Date(reviewed.expiresAt) : undefined;
    if (
      (reviewed.classification !== 'code-identifier' &&
        reviewed.classification !== 'documented-example' &&
        reviewed.classification !== 'synthetic-test-fixture') ||
      typeof reviewed.reason !== 'string' ||
      reviewed.reason.length === 0 ||
      typeof reviewed.owner !== 'string' ||
      reviewed.owner.length === 0 ||
      typeof reviewed.reviewedAt !== 'string' ||
      Number.isNaN(new Date(reviewed.reviewedAt).valueOf()) ||
      !expiry ||
      Number.isNaN(expiry.valueOf()) ||
      !Array.isArray(reviewed.digests) ||
      reviewed.digests.length === 0 ||
      reviewed.digests.some(
        (digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      )
    ) {
      return { digests: new Set(), errors: ['A reviewed Gitleaks baseline entry was invalid.'] };
    }
    if (expiry <= now) {
      return { digests: new Set(), errors: ['A reviewed Gitleaks baseline entry has expired.'] };
    }
    for (const digest of reviewed.digests) {
      if (digests.has(digest)) {
        return {
          digests: new Set(),
          errors: ['The reviewed Gitleaks baseline has a duplicate entry.'],
        };
      }
      digests.add(digest);
    }
  }

  return { digests, errors: [] };
}

export function evaluateGitleaksFindings(
  rawJson: string,
  baselineJson = '{"version":1,"matcherVersion":"gitleaks-finding-v2-unredacted","baseCommit":"none","groups":[]}',
  now = new Date()
): SecretScanResult {
  let parsed: unknown;
  try {
    parsed = rawJson.trim() ? (JSON.parse(rawJson) as unknown) : [];
  } catch {
    return {
      ok: false,
      totalFindingCount: 0,
      reviewedFindingCount: 0,
      newFindingCount: 0,
      errors: ['Gitleaks output was not valid JSON.'],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      totalFindingCount: 0,
      reviewedFindingCount: 0,
      newFindingCount: 0,
      errors: ['Gitleaks output was not a JSON array.'],
    };
  }
  if (parsed.some((finding) => typeof finding !== 'object' || finding === null)) {
    return {
      ok: false,
      totalFindingCount: parsed.length,
      reviewedFindingCount: 0,
      newFindingCount: parsed.length,
      errors: ['Gitleaks output contained an invalid finding.'],
    };
  }

  const baseline = parseBaseline(baselineJson, now);
  if (baseline.errors.length > 0) {
    return {
      ok: false,
      totalFindingCount: parsed.length,
      reviewedFindingCount: 0,
      newFindingCount: parsed.length,
      errors: baseline.errors,
    };
  }

  let reviewedFindingCount = 0;
  let invalidFindingCount = 0;
  for (const finding of parsed as SecretFinding[]) {
    const digest = secretFindingDigest(finding);
    if (!digest) invalidFindingCount += 1;
    else if (baseline.digests.has(digest)) reviewedFindingCount += 1;
  }
  const newFindingCount = parsed.length - reviewedFindingCount;
  const errors: string[] = [];
  if (invalidFindingCount > 0) {
    errors.push('Gitleaks output contained an incomplete finding.');
  }
  if (newFindingCount > 0) {
    errors.push(
      `Gitleaks reported ${newFindingCount} new finding(s). Details are withheld by policy.`
    );
  }

  return {
    ok: errors.length === 0,
    totalFindingCount: parsed.length,
    reviewedFindingCount,
    newFindingCount,
    errors,
  };
}

export function gitleaksArgsForMode(mode: 'current-tree' | 'pr-range', range?: string): string[] {
  // Exact baselines must include the actual match bytes. The caller captures
  // the report in a private temporary directory and never forwards scanner
  // stdout/stderr or finding metadata to logs.
  const privateReport = ['--no-banner', '--no-color', '--report-format=json'];
  if (mode === 'current-tree') return ['dir', '.', ...privateReport];
  if (!range) throw new Error('PR range is required for pr-range scans');
  return ['git', '.', '--log-opts', range, ...privateReport];
}
