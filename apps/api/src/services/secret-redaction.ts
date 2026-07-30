export const REDACTED = '[REDACTED]';

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[a-fA-F0-9]{64,}\b/g,
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
] as const;

export function redactSecretPatterns(value: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, REDACTED), value);
}
