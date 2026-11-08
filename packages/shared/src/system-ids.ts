/**
 * Well-known ids of internal system rows seeded by D1 migrations.
 *
 * Both rows were introduced for the retired anonymous-trial product (migrations 0043 and 0045),
 * which is why the stored ids still say "trials". They outlive it because other code depends on
 * them, and they must never be deleted: deleting either cascades into real data.
 *
 * - The system user (`status = 'system'`) is the fallback `created_by` for platform config rows
 *   and is excluded from every "first real human" and operator check.
 * - The system installation is the placeholder `installation_id` for projects with no GitHub App
 *   installation (Artifacts- and GitLab-backed projects; `projects.installation_id` is NOT NULL).
 */
export const SYSTEM_USER_ID = 'system_anonymous_trials';

export const SYSTEM_INSTALLATION_ID = 'system_anonymous_trials_installation';
