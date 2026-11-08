/** Request helpers shared by the project library routes (`library.ts`). */
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getMaxSearchLength } from '../services/file-library-config';

export function validateSearchLength(search: string | undefined, env: Env): void {
  if (search && search.length > getMaxSearchLength(env)) {
    throw errors.badRequest(
      `Search query exceeds maximum length of ${getMaxSearchLength(env)} characters`
    );
  }
}

export function getEncryptionKey(env: Env): string {
  const key = env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  if (!key) {
    throw errors.internal('Encryption key not configured');
  }
  return key;
}

export function requireParam(value: string | undefined, name: string): string {
  if (!value) {
    throw errors.badRequest(`Missing required parameter: ${name}`);
  }
  return value;
}
