/**
 * GCP API error handling and sanitization.
 *
 * Provides a custom error class for GCP API errors and a sanitization function
 * that maps raw GCP errors to user-friendly messages without leaking internal
 * resource paths, IAM policies, or service account details.
 */

import { AppError } from '../middleware/error';
import { log } from '../lib/logger';

/**
 * Custom error class for GCP API failures.
 * Preserves full diagnostic context for server-side logging while carrying
 * a sanitized message suitable for client responses.
 */
export class GcpApiError extends Error {
  /** The GCP API operation that failed (e.g., 'create_wif_pool', 'enable_apis'). */
  readonly step: string;
  /** HTTP status code from the GCP API response, if available. */
  readonly statusCode?: number;
  /** Raw response body from the GCP API (for server-side logging only). */
  readonly rawBody?: string;

  constructor(opts: {
    step: string;
    message: string;
    statusCode?: number;
    rawBody?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'GcpApiError';
    this.step = opts.step;
    this.statusCode = opts.statusCode;
    this.rawBody = opts.rawBody;
    if (opts.cause) {
      this.cause = opts.cause;
    }
  }
}

/** User-facing error messages mapped from GCP HTTP status codes. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request to Google Cloud was invalid. Please check your project configuration.',
  401: 'Google Cloud authentication expired. Please re-authenticate with Google.',
  403: 'Permission denied. Please ensure your Google account has the required permissions on this project.',
  404: 'The requested Google Cloud resource was not found. Please verify your project ID.',
  409: 'A Google Cloud resource conflict occurred. The resource may already exist.',
  429: 'Google Cloud API rate limit exceeded. Please wait a moment and try again.',
  500: 'Google Cloud encountered an internal error. Please try again later.',
  503: 'Google Cloud is temporarily unavailable. Please try again later.',
};

/** Step-specific user-facing hints for common operations. */
const STEP_HINTS: Record<string, string> = {
  list_projects: 'Failed to list Google Cloud projects.',
  get_project_number: 'Failed to retrieve project details.',
  enable_apis: 'Failed to enable required Google Cloud APIs. Ensure your account has the Service Usage Admin role.',
  create_wif_pool: 'Failed to configure workload identity. Ensure your account has the IAM Admin role.',
  create_oidc_provider: 'Failed to configure the identity provider.',
  update_oidc_provider: 'Failed to update the identity provider.',
  create_service_account: 'Failed to create the service account. Ensure your account has the IAM Admin role.',
  grant_wif_user: 'Failed to configure identity federation on the service account.',
  grant_project_roles: 'Failed to grant project permissions. Ensure your account has the Project IAM Admin role.',
  poll_operation: 'A Google Cloud operation timed out or failed.',
  sts_exchange: 'Google Cloud token exchange failed. The OIDC setup may need to be reconfigured.',
  sa_impersonation: 'Failed to authenticate with the service account.',
};

/**
 * Returns true if the GCP error represents an upstream/server failure
 * (as opposed to a client-side permission or input issue).
 */
function isUpstreamFailure(err: unknown): boolean {
  if (err instanceof GcpApiError) {
    const s = err.statusCode;
    return s !== undefined && (s >= 500 || s === 429);
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return true; // Unknown errors are treated as upstream failures
}

/**
 * Create an AppError with the appropriate HTTP status from a GCP error.
 *
 * - Client-side GCP errors (400, 401, 403, 404) → HTTP 400
 * - Upstream GCP errors (429, 500, 503, timeout) → HTTP 502
 * - Unknown errors → HTTP 502
 */
export function toSanitizedAppError(err: unknown, context?: string): AppError {
  const message = sanitizeGcpError(err, context);

  if (isUpstreamFailure(err)) {
    return new AppError(502, 'GCP_UPSTREAM_ERROR', message);
  }
  return new AppError(400, 'BAD_REQUEST', message);
}

/**
 * Sanitize a GCP error for client-facing responses.
 *
 * Logs the full error details server-side, then returns a user-friendly
 * message with no internal resource paths, IAM policy details, or
 * service account emails.
 */
export function sanitizeGcpError(err: unknown, context?: string): string {
  if (err instanceof GcpApiError) {
    // Log full details server-side
    log.error('gcp_api_error', {
      step: err.step,
      statusCode: err.statusCode,
      message: err.message,
      rawBody: err.rawBody,
      context,
    });

    // Build user-friendly message
    const stepHint = STEP_HINTS[err.step] || 'A Google Cloud operation failed.';
    const statusHint = err.statusCode ? STATUS_MESSAGES[err.statusCode] : undefined;

    if (statusHint) {
      return `${stepHint} ${statusHint}`;
    }

    return `${stepHint} Please check your Google Cloud project permissions and try again.`;
  }

  // Handle abort/timeout errors
  if (err instanceof Error && err.name === 'AbortError') {
    log.error('gcp_api_timeout', { message: err.message, context });
    return 'The request to Google Cloud timed out. Please try again.';
  }

  // Generic fallback — log whatever we got but don't expose it
  log.error('gcp_error_unknown_type', { error: String(err), context });
  return 'Failed to communicate with Google Cloud. Please check your project permissions and try again.';
}
