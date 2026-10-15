import * as v from 'valibot';

/** Deployment-owned, insert-once record in the existing primary database. */
export const RELIABILITY_STORAGE_ACTIVATION_KEY = 'reliability.storage.activation.v1';
export interface StorageActivation {
  publishedAt: number;
  rateCutoverAt: number;
  bootLogCutoverAt: number;
  windowSeconds: number;
}

/** Never cache an absent record or read from a replica: old bridge versions must
 * observe the same activation as new ones. Database failures fail closed. */
export async function readStorageActivation(
  database: D1Database
): Promise<StorageActivation | null> {
  const row = await database
    .withSession('first-primary')
    .prepare('SELECT value FROM platform_settings WHERE key = ?')
    .bind(RELIABILITY_STORAGE_ACTIVATION_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  const seconds = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
  const record = v.parse(
    v.object({
      publishedAt: seconds,
      rateCutoverAt: seconds,
      bootLogCutoverAt: seconds,
      windowSeconds: seconds,
    }),
    JSON.parse(row.value)
  );
  if (
    !record ||
    ![
      record.publishedAt,
      record.rateCutoverAt,
      record.bootLogCutoverAt,
      record.windowSeconds,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    record.windowSeconds === 0 ||
    record.rateCutoverAt <= record.publishedAt ||
    record.bootLogCutoverAt <= record.publishedAt ||
    record.rateCutoverAt % record.windowSeconds !== 0
  ) {
    throw new Error('Invalid shared reliability storage activation');
  }
  return record;
}
