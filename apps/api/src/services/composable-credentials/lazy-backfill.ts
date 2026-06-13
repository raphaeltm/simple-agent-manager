/**
 * Lazy backfill — auto-populates cc_* tables on first resolution when a user
 * has legacy credentials but no cc_* data yet.
 *
 * This ensures upgrading SAM "just works" without requiring manual migration.
 */

import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import { ccCredentials } from '../../db/schema';
import { runBackfill } from './backfill-service';

/**
 * Check whether a user already has any cc_credentials rows.
 * A single COUNT query — cheap enough to call on every resolution.
 */
export async function hasUserCCData(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ccCredentials.id })
    .from(ccCredentials)
    .where(eq(ccCredentials.ownerId, userId))
    .limit(1);
  return row !== undefined;
}

/**
 * If the user has no cc_* data, run the backfill from legacy tables.
 * Returns true if backfill was performed, false if data already existed.
 */
export async function lazyBackfillIfNeeded(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<boolean> {
  const hasCCData = await hasUserCCData(db, userId);
  if (hasCCData) return false;

  await runBackfill(db, { userId });
  return true;
}
