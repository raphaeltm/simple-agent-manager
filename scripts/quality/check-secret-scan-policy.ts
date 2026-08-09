export interface SecretFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Secret?: string;
  Match?: string;
}

export interface SecretScanResult {
  ok: boolean;
  sanitizedFindings: Omit<SecretFinding, 'Secret' | 'Match'>[];
  errors: string[];
}

export function redactSecretScanOutput(output: string): string {
  return output
    .replace(/("Secret"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/("Match"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, '$1[REDACTED]');
}

export function evaluateGitleaksFindings(rawJson: string): SecretScanResult {
  let parsed: unknown;
  try {
    parsed = rawJson.trim() ? (JSON.parse(rawJson) as unknown) : [];
  } catch {
    return { ok: false, sanitizedFindings: [], errors: ['Gitleaks output was not valid JSON.'] };
  }

  const findings = Array.isArray(parsed) ? (parsed as SecretFinding[]) : [];
  const sanitizedFindings = findings.map(
    ({ Secret: _secret, Match: _match, ...safeFinding }) => safeFinding
  );
  return {
    ok: findings.length === 0,
    sanitizedFindings,
    errors:
      findings.length === 0
        ? []
        : [`Gitleaks reported ${findings.length} finding(s). Secret values redacted.`],
  };
}

export function gitleaksArgsForMode(mode: 'current-tree' | 'pr-range', range?: string): string[] {
  if (mode === 'current-tree') return ['detect', '--no-git', '--redact', '--report-format=json'];
  if (!range) throw new Error('PR range is required for pr-range scans');
  return ['detect', '--log-opts', range, '--redact', '--report-format=json'];
}
