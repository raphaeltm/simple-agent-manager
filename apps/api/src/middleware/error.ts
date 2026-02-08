import type { ApiError } from '@simple-agent-manager/shared';

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

  unauthorized: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', message),

  forbidden: (message = 'Access denied') =>
    new AppError(403, 'FORBIDDEN', message),

  notFound: (resource = 'Resource') =>
    new AppError(404, 'NOT_FOUND', `${resource} not found`),

  conflict: (message: string) =>
    new AppError(409, 'CONFLICT', message),

  paymentRequired: (message = 'Payment required') =>
    new AppError(402, 'PAYMENT_REQUIRED', message),

  internal: (message = 'Internal server error') =>
    new AppError(500, 'INTERNAL_ERROR', message),
};
