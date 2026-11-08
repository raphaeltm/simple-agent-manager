/**
 * Google APIs attach a `google.rpc.ErrorInfo` to most errors under `error.details[]`. Its `reason`
 * is the machine-readable cause, where `error.status` is only the coarse class: a 403
 * `PERMISSION_DENIED` can be an API that is turned off (`SERVICE_DISABLED`), a missing IAM grant
 * (`IAM_PERMISSION_DENIED`) or a token minted without the scope (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`).
 * Each needs a different recovery action, so callers read the reason rather than the status.
 *
 * Docs: https://cloud.google.com/apis/design/errors#error_info
 */
import type { ProviderError, ProviderErrorContext } from './types';

export interface GoogleErrorInfo {
  /** For example `SERVICE_DISABLED`. */
  reason: string;
  /** For example `googleapis.com`. */
  domain?: string;
  /** The API the error is about, from `metadata.service`, for example `cloudbilling.googleapis.com`. */
  service?: string;
}

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
/** Google's reasons and service names are short identifiers; anything longer is not one. */
const MAX_FIELD_CHARS = 128;
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_FIELD_CHARS && IDENTIFIER.test(value)
    ? value
    : undefined;
}

/** Read the first ErrorInfo from a Google error object (`body.error`); null when there is none. */
export function parseGoogleErrorInfo(error: Record<string, unknown> | null): GoogleErrorInfo | null {
  const details = error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    const entry = detail as Record<string, unknown>;
    if (entry['@type'] !== ERROR_INFO_TYPE) continue;
    const reason = identifier(entry.reason);
    if (!reason) continue;
    const metadata =
      entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? (entry.metadata as Record<string, unknown>)
        : {};
    const domain = identifier(entry.domain);
    const service = identifier(metadata.service);
    return { reason, ...(domain ? { domain } : {}), ...(service ? { service } : {}) };
  }
  return null;
}

export function googleErrorInfoContext(info: GoogleErrorInfo): ProviderErrorContext {
  return { googleErrorInfo: { ...info } };
}

/** The ErrorInfo `providerFetch` recorded on a provider error, or null. */
export function googleErrorInfoOf(error: ProviderError): GoogleErrorInfo | null {
  const raw = error.context?.googleErrorInfo;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const reason = identifier(record.reason);
  if (!reason) return null;
  const domain = identifier(record.domain);
  const service = identifier(record.service);
  return { reason, ...(domain ? { domain } : {}), ...(service ? { service } : {}) };
}
