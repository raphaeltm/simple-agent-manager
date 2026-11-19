/**
 * Why an exact credential binding did not resolve.
 *
 * `createProviderForExactCredential` returns `null` for several different conditions, and
 * strict teardown used to report all of them as "credentials missing". The common one after a
 * re-save is not a missing credential at all: the row still exists and is enabled, but its
 * ciphertext generation is no longer the one the node was placed with. The recovery action
 * differs (rule 72): a removed credential can be re-added; a re-saved one can never again prove
 * anything about a VM placed under its old generation, so the node needs an operator.
 *
 * This reads the same row the resolver reads, with the same scope predicates, but WITHOUT the
 * generation comparison, then compares the generation itself. It never decrypts anything.
 */
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import {
  type ExactProviderCredentialBinding,
  exactCredentialGenerationMatches,
  parseProviderCredentialReference,
} from './provider-credential-exact';

/**
 * - `generation_changed`: the pinned row exists, is enabled/active, and is for this provider, but
 *   its secret was re-saved or rotated since placement.
 * - `unavailable`: the pinned row is gone, disabled, for another provider or scope, or the
 *   binding itself cannot name a row. Composable (`cc_credentials`) rows never rotate in place
 *   (a rotation inserts a new row), so an unresolved cc binding is always `unavailable`.
 */
export type ExactCredentialUnresolvedCause = 'generation_changed' | 'unavailable';

type CredentialRow = {
  encryptedToken: string;
  iv: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export async function diagnoseExactCredentialUnresolved(
  db: ReturnType<typeof drizzle>,
  userId: string,
  targetProvider: CredentialProvider,
  projectId: string | null,
  exactCredential: ExactProviderCredentialBinding
): Promise<ExactCredentialUnresolvedCause> {
  const reference = parseProviderCredentialReference(exactCredential.credentialReference);
  if (!reference) return 'unavailable';

  let row: CredentialRow | undefined;
  if (exactCredential.credentialSource === 'platform' && reference.kind === 'platformCredential') {
    [row] = await db
      .select()
      .from(schema.platformCredentials)
      .where(
        and(
          eq(schema.platformCredentials.id, reference.id),
          eq(schema.platformCredentials.credentialType, 'cloud-provider'),
          eq(schema.platformCredentials.isEnabled, true),
          eq(schema.platformCredentials.provider, targetProvider)
        )
      )
      .limit(1);
  } else if (exactCredential.credentialSource === 'user' && reference.kind === 'credential') {
    [row] = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.id, reference.id),
          eq(schema.credentials.userId, userId),
          isNull(schema.credentials.projectId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          eq(schema.credentials.isActive, true),
          eq(schema.credentials.provider, targetProvider)
        )
      )
      .limit(1);
  } else if (
    exactCredential.credentialSource === 'project' &&
    reference.kind === 'credential' &&
    projectId
  ) {
    [row] = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.id, reference.id),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          eq(schema.credentials.isActive, true),
          eq(schema.credentials.provider, targetProvider)
        )
      )
      .limit(1);
  }
  if (!row) return 'unavailable';
  const generation = await exactCredentialGenerationMatches(exactCredential, row);
  return generation.matches ? 'unavailable' : 'generation_changed';
}
