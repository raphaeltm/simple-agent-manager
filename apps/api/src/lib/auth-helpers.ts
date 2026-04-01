import { errors } from '../middleware/error';

/**
 * Extract and validate a Bearer token from an Authorization header.
 * Throws 401 if the header is missing, malformed, or the token is empty.
 */
export function extractBearerToken(authHeader: string | undefined | null): string {
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7);
  if (!token) {
    throw errors.unauthorized('Empty bearer token');
  }
  return token;
}
