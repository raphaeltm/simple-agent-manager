/**
 * Whether a provider error means "this credential was refused" (a verdict about the credential)
 * rather than a temporary limit or an ordinary failure. Split from `node-teardown-authority.ts`.
 */
import { googleErrorInfoOf, ProviderError } from '@simple-agent-manager/providers';

import { GcpApiError } from './gcp-errors';

/**
 * The provider refused this credential, so it can never answer for the instance (reads) or act on
 * it (deletes). Trust the provider's own category first. Rate limits and quotas are temporary even
 * when a provider reports them as 403 (rule 72), so a bare 401/403 counts only when no structured
 * error code names a rate limit, quota or exhausted resource. Messages are never read: they carry
 * resource names, and a refusal on project "quota-prod" must still move on to the next credential.
 * GCP token exchange and service-account impersonation fail with `GcpApiError` (not
 * `ProviderError`) and go through the same test, so a revoked GCP identity gives a named verdict.
 */
export function isCredentialRejection(error: unknown): boolean {
  if (error instanceof ProviderError) {
    if (error.category === 'auth_error') return true;
    if (error.category !== undefined && error.category !== 'unknown') return false;
    const codes = [error.providerCode, googleErrorInfoOf(error)?.reason];
    return isRefusalStatus(error.statusCode) && !codes.some(namesTemporaryLimit);
  }
  if (error instanceof GcpApiError) {
    return (
      isRefusalStatus(error.statusCode) &&
      !googleErrorBodyCodes(error.rawBody).some(namesTemporaryLimit)
    );
  }
  return false;
}

function isRefusalStatus(statusCode: number | undefined): boolean {
  return statusCode === 401 || statusCode === 403;
}

/** A machine error code (Hetzner `rate_limit_exceeded`, Google `RESOURCE_EXHAUSTED`, `quotaExceeded`). */
function namesTemporaryLimit(code: string | undefined): boolean {
  return (
    !!code &&
    /rate_?limit|quota|limit_?exceeded|resource_?(limit|exhausted)|too_?many_?requests/i.test(code)
  );
}

/**
 * The structured codes of a Google error body: `error.status`, `error.errors[].reason`,
 * `error.details[].reason` (ErrorInfo), or the OAuth/STS `error` code. Never `message` or
 * `error_description`, which name resources.
 */
function googleErrorBodyCodes(rawBody: string | undefined): string[] {
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    return [];
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string') return [error];
  if (!error || typeof error !== 'object') return [];
  const { status, errors, details } = error as {
    status?: unknown;
    errors?: unknown;
    details?: unknown;
  };
  const reasons = [errors, details].flatMap((list) =>
    Array.isArray(list) ? list.map((entry) => (entry as { reason?: unknown } | null)?.reason) : []
  );
  return [status, ...reasons].filter((code): code is string => typeof code === 'string');
}
