import type { Context, Next } from 'hono';
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

/**
 * Error handling middleware for Hono.
 */
export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (err) {
      console.error('Request error:', err);

      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }

      // Handle unknown errors
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json(
        {
          error: 'INTERNAL_ERROR',
          message,
        } satisfies ApiError,
        500
      );
    }
  };
}
