import type { ApiError } from '@simple-agent-manager/shared';

import type { PlatformCapability } from '../services/platform-capabilities';

/**
 * Custom error class for API errors with status codes.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): ApiError {
    return {
      error: this.error,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * Common error factory functions.
 */
export const errors = {
  badRequest: (message: string, details?: Record<string, unknown>) =>
    new AppError(400, 'BAD_REQUEST', message, details),

  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),

  forbidden: (message = 'Access denied') => new AppError(403, 'FORBIDDEN', message),

  notFound: (resource = 'Resource') => new AppError(404, 'NOT_FOUND', `${resource} not found`),

  gone: (message = 'Resource is gone') => new AppError(410, 'GONE', message),

  conflict: (message: string) => new AppError(409, 'CONFLICT', message),

  unprocessable: (message: string, details?: Record<string, unknown>) =>
    new AppError(422, 'UNPROCESSABLE_ENTITY', message, details),

  paymentRequired: (message = 'Payment required') => new AppError(402, 'PAYMENT_REQUIRED', message),

  tooManyRequests: (message = 'Too many requests') =>
    new AppError(429, 'TOO_MANY_REQUESTS', message),

  internal: (message = 'Internal server error') => new AppError(500, 'INTERNAL_ERROR', message),

  serviceUnavailable: (message = 'Service unavailable') =>
    new AppError(503, 'SERVICE_UNAVAILABLE', message),

  /**
   * A platform service this installation does not have (for example Workers AI off
   * Cloudflare). A designed 4xx: the request was valid, the installation cannot serve it,
   * and retrying will not help. `feature` names the capability in
   * services/platform-capabilities.ts.
   */
  /** A platform service this installation does not have (services/platform-capabilities.ts). */
  featureUnavailable: (feature: PlatformCapability, message: string) =>
    new AppError(404, 'FEATURE_UNAVAILABLE', message, { feature }),
};
