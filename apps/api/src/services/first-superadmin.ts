import type { Env } from '../env';

type FirstSuperadminEnv = Pick<Env, 'DATABASE'>;

export const FIRST_SUPERADMIN_SETTING = 'setup.firstSuperadminEstablished';

/**
 * Elect the first ordinary-install administrator after BetterAuth has inserted the user.
 *
 * The initial read only avoids a write batch on every later login. The INSERT and promotion are
 * the authoritative security boundary: D1 executes the batch atomically, the settings primary
 * key admits one winner, and the UPDATE trusts only the user id stored by that winning INSERT.
 */
export async function establishFirstSuperadmin(
  env: FirstSuperadminEnv,
  userId: string
): Promise<void> {
  const established = await env.DATABASE.prepare(
    'SELECT 1 AS established FROM platform_settings WHERE key = ? LIMIT 1'
  )
    .bind(FIRST_SUPERADMIN_SETTING)
    .first();
  if (established) return;

  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
       SELECT ?, json_object('version', 1, 'ownerId', selected.id), CURRENT_TIMESTAMP, selected.id
       FROM users selected
       WHERE selected.id = COALESCE(
         (SELECT administrator.id FROM users administrator
          WHERE administrator.role = 'superadmin' AND administrator.status != 'system'
          ORDER BY administrator.id LIMIT 1),
         (SELECT candidate.id FROM users candidate
          WHERE candidate.id = ?
            AND candidate.status != 'system'
            AND candidate.status != 'suspended'
          LIMIT 1)
       )`
    ).bind(FIRST_SUPERADMIN_SETTING, userId),
    env.DATABASE.prepare(
      `UPDATE users
       SET role = 'superadmin', status = 'active'
       WHERE id = ?
         AND role != 'superadmin'
         AND status != 'system'
         AND status != 'suspended'
         AND EXISTS (
           SELECT 1 FROM platform_settings election
           WHERE election.key = ?
             AND json_extract(election.value, '$.version') = 1
             AND json_extract(election.value, '$.ownerId') = users.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM users administrator
           WHERE administrator.role = 'superadmin'
             AND administrator.status != 'system'
         )`
    ).bind(userId, FIRST_SUPERADMIN_SETTING),
  ]);
}
