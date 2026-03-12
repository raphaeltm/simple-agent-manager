/**
 * Shared route utility functions.
 *
 * Consolidates helpers that were duplicated across multiple route files:
 * - parsePositiveInt (was in projects.ts, tasks.ts)
 * - requireRouteParam (was in tasks.ts)
 */

import { errors } from '../middleware/error';

/**
 * Parse a query parameter as a positive integer, returning a fallback on failure.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Require a route parameter to be present, throwing 400 if missing.
 */
export function requireRouteParam(
  c: { req: { param: (name: string) => string | undefined } },
  name: string
): string {
  const value = c.req.param(name);
  if (!value) {
    throw errors.badRequest(`${name} is required`);
  }
  return value;
}
