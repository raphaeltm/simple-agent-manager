import { redactCredentialTokens } from '../lib/credential-token-redaction';

export const REDACTED = '[REDACTED]';

/** Secret shapes beyond the shared credential tokens (`lib/credential-token-redaction.ts`). */
const SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /([?&](?:access_token|api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi,
  /\b[a-fA-F0-9]{64,}\b/g,
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
] as const;

export function redactSecretPatterns(value: string): string {
  // Credential tokens first, so a whole token is replaced before a generic shape (long base64,
  // hex) can match only a fragment of it.
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, REDACTED),
    redactCredentialTokens(value, REDACTED)
  );
}
