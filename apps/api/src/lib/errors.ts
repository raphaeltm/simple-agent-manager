import type { Context } from 'hono';
import type { ApiError } from '@simple-agent-manager/shared';

/**
 * Standard error codes
 */
export const ErrorCodes = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_ERROR: 'validation_error',
  PROVIDER_ERROR: 'provider_error',
  INTERNAL_ERROR: 'internal_error',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  WORKSPACE_ALREADY_STOPPED: 'workspace_already_stopped',
  WORKSPACE_NOT_RUNNING: 'workspace_not_running',
  EXEC_NOT_SUPPORTED: 'exec_not_supported',
  INVALID_REPO_URL: 'invalid_repo_url',
  INVALID_SIZE: 'invalid_size',
  // Note: INVALID_API_KEY removed - users authenticate via `claude login`
  GITHUB_NOT_CONNECTED: 'github_not_connected',
  REPO_NOT_ACCESSIBLE: 'repo_not_accessible',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Create a standard error response
 */
export function errorResponse(
  c: Context,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
) {
  const body: ApiError = {
    error: code,
    message,
    ...(details && { details }),
  };
  return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503);
}

/**
 * 400 Bad Request
 */
export function badRequest(c: Context, code: ErrorCode, message: string) {
  return errorResponse(c, 400, code, message);
}

/**
 * 401 Unauthorized
 */
export function unauthorized(c: Context, message = 'Unauthorized') {
  return errorResponse(c, 401, ErrorCodes.UNAUTHORIZED, message);
}

/**
 * 404 Not Found
 */
export function notFound(c: Context, message = 'Resource not found') {
  return errorResponse(c, 404, ErrorCodes.NOT_FOUND, message);
}

/**
 * 409 Conflict
 */
export function conflict(c: Context, code: ErrorCode, message: string) {
  return errorResponse(c, 409, code, message);
}

/**
 * 500 Internal Server Error
 */
export function internalError(c: Context, message = 'Internal server error') {
  return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, message);
}

/**
 * 502 Bad Gateway (provider error)
 */
export function providerError(c: Context, message: string) {
  return errorResponse(c, 502, ErrorCodes.PROVIDER_ERROR, message);
}

/**
 * 503 Service Unavailable
 */
export function serviceUnavailable(c: Context, message: string) {
  return errorResponse(c, 503, ErrorCodes.PROVIDER_UNAVAILABLE, message);
}
