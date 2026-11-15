import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';

type FirstSuperadminEnv = Pick<Env, 'DATABASE'>;

const log = createModuleLogger('first-superadmin');

/**
 * Durable marker: initial administration of an ordinary (no `BOOTSTRAP_OWNER_EMAIL`) install is
 * established. Written by migration 0243 for installs that already had a superadmin, and by
 * {@link establishFirstSuperadmin} when it elects one. While it exists nobody is auto-promoted,
 * even if every superadmin is later deleted.
 */
export const FIRST_SUPERADMIN_SETTING = 'setup.firstSuperadminEstablished';

/**
 * Promote the bound user only when every guard holds inside this one statement: the user is a real
 * (`status != 'system'`), non-suspended, non-superadmin account; it is the ONLY real user; and the
 * election has not completed. D1 runs the statement atomically, so the guards are race-safe.
 *
 * The only-real-user guard does three jobs. A later sign-up never wins against an existing
 * account, whatever that account's role or status. No other superadmin can exist (one would be
 * another real user). And two racing sign-ups whose rows both exist both lose: the install fails
 * closed with no administrator rather than electing by timing. A winner chosen by `created_at`
 * would also promote the oldest account on an upgraded install with several users and no
 * superadmin, which this election must never do.
 */
const ELECT_SQL = `
UPDATE users
SET role = 'superadmin', status = 'active', updated_at = cast(unixepoch() * 1000 as integer)
WHERE id = ?
  AND role != 'superadmin'
  AND status != 'system'
  AND status != 'suspended'
  AND NOT EXISTS (
    SELECT 1 FROM users other
    WHERE other.id != ?
      AND other.status != 'system'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_settings election
    WHERE election.key = ?
  )`;

/**
 * Record the marker for the oldest real superadmin, if one exists. Runs after `ELECT_SQL` in the
 * same batch, so it names the user just elected; it also backfills an install that has a
 * superadmin but no marker. It writes nothing while no superadmin exists, so a refused election
 * leaves the install open for its sole real user.
 */
const RECORD_SQL = `
INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
SELECT ?, json_object('version', 1, 'ownerId', administrator.id), CURRENT_TIMESTAMP, administrator.id
FROM users administrator
WHERE administrator.role = 'superadmin'
  AND administrator.status != 'system'
ORDER BY administrator.created_at, administrator.id
LIMIT 1`;

/**
 * Elect the first administrator of an ordinary install after BetterAuth has inserted the user.
 *
 * The initial read keeps later sign-ins to one query. It also reports an install with more than
 * one real superadmin (`first-superadmin.multiple_superadmins`): superadmin is never granted
 * through the admin API, so a second one can only come from the pre-0243 sign-up race or a manual
 * database edit, and an operator must decide which accounts to keep. Nothing is changed for them.
 */
export async function establishFirstSuperadmin(
  env: FirstSuperadminEnv,
  userId: string
): Promise<void> {
  const state = await env.DATABASE.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM platform_settings WHERE key = ?) AS established,
       (SELECT COUNT(*) FROM users WHERE role = 'superadmin' AND status != 'system') AS superadmins`
  )
    .bind(FIRST_SUPERADMIN_SETTING)
    .first<{ established: number; superadmins: number }>();
  if (state && state.superadmins > 1) {
    log.warn('multiple_superadmins', {
      superadminCount: state.superadmins,
      signingInUserId: userId,
      action: 'reported_for_operator_review',
    });
  }
  if (state?.established) return;

  const [elected] = await env.DATABASE.batch([
    env.DATABASE.prepare(ELECT_SQL).bind(userId, userId, FIRST_SUPERADMIN_SETTING),
    env.DATABASE.prepare(RECORD_SQL).bind(FIRST_SUPERADMIN_SETTING),
  ]);
  if ((elected?.meta.changes ?? 0) > 0) log.info('elected', { userId });
}
