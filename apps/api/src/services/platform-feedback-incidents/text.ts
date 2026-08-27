import { redactSensitiveData } from '../observability';
import type { IncidentConfig } from '../platform-feedback-incident-config';
import { redactSecretPatterns } from '../secret-redaction';

const INCIDENT_SIGNATURE_INPUT_MAX_LENGTH = 2_000;
const INCIDENT_SIGNATURE_CANONICAL_MAX_LENGTH = 500;

function stripControlCharacters(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function sanitizeText(value: string, maxLength: number): string {
  return redactSecretPatterns(stripControlCharacters(String(redactSensitiveData(value))))
    .replace(/\b[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b01[a-z0-9]{24}\b/gi, '[id]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeForSignature(value: string): string {
  return sanitizeText(value, INCIDENT_SIGNATURE_INPUT_MAX_LENGTH)
    .toLowerCase()
    .replace(/\b\d{3,}\b/g, '[n]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INCIDENT_SIGNATURE_CANONICAL_MAX_LENGTH);
}

export async function incidentSignature(source: string, fingerprintText: string): Promise<string> {
  const canonical = `${source.trim().toLowerCase()}\n${normalizeForSignature(fingerprintText)}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export function parseEvidenceRefs(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function boundedEvidenceRefs(
  existing: unknown[],
  incoming: unknown[],
  config: IncidentConfig
): string {
  const redacted = redactSensitiveData([...existing, ...incoming]).slice(
    0,
    config.evidenceRefLimit
  );
  let candidate = JSON.stringify(redacted);
  while (
    new TextEncoder().encode(candidate).byteLength > config.evidenceMaxBytes &&
    redacted.length
  ) {
    redacted.pop();
    candidate = JSON.stringify([...redacted, { truncated: true }]);
  }
  if (new TextEncoder().encode(candidate).byteLength > config.evidenceMaxBytes) {
    return JSON.stringify([{ truncated: true }]);
  }
  return candidate;
}

export function evidenceRefsToText(raw: string): string {
  const refs = redactSensitiveData(parseEvidenceRefs(raw));
  return JSON.stringify(refs, null, 2);
}
