/**
 * SQL for `pnpm selfhost:create-account` (create-account.ts): an account in the `users` table,
 * the table BetterAuth reads, so email sign-in (emailOTP) then works for the address. BetterAuth
 * needs no `accounts` row for it: its email-code sign-in looks the user up by email
 * (`findUserByEmail`) and creates a session.
 *
 * `celld d1 execute` takes SQL text, not bound parameters, so every value written here is
 * generated or checked first: the email against a strict pattern with no quote characters, the id
 * from a fixed alphabet. Nothing else from the operator reaches the SQL.
 *
 * Rules:
 * - Idempotent: an existing account is never duplicated or overwritten. `--superadmin` promotes
 *   it to superadmin and approves it if it was pending, but never lifts a suspension: that stays
 *   an explicit admin decision in the app.
 * - The operator vouches for the address, so a new row is `email_verified = 1` and `active`,
 *   whatever the signup approval mode says.
 * - Internal sentinel rows (`status = 'system'`, e.g. `system_anonymous_trials`) are never
 *   matched, promoted or counted as an administrator (apps/api/.claude/rules/40).
 */
import { randomInt } from 'node:crypto';

/** Lower-case ASCII, no quotes or spaces, a dot in the domain. */
const ACCOUNT_EMAIL =
  /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_EMAIL_LENGTH = 254;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** BetterAuth's generated ids are 32 characters from the same alphabet. */
const ID_LENGTH = 32;

export function normalizeAccountEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !ACCOUNT_EMAIL.test(email)) {
    throw new Error(
      `"${raw}" is not an email address this command accepts (plain ASCII, no quotes)`
    );
  }
  return email;
}

export function generateAccountId(): string {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

export interface AccountPlan {
  email: string;
  superadmin: boolean;
  id: string;
  nowMs: number;
}

function assertSafe(plan: AccountPlan): void {
  normalizeAccountEmail(plan.email);
  if (!new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`).test(plan.id))
    throw new Error('bad account id');
  if (!Number.isSafeInteger(plan.nowMs) || plan.nowMs <= 0) throw new Error('bad timestamp');
}

const MATCH = (email: string) => `lower(trim(email)) = '${email}' AND status != 'system'`;

/**
 * The statements, in order: create when absent, promote when asked, then report the account and
 * whether the install has an administrator. Run as one batch.
 */
export function createAccountSql(plan: AccountPlan): string {
  assertSafe(plan);
  const { email, id, nowMs } = plan;
  const name = email.split('@')[0] ?? email;
  const role = plan.superadmin ? 'superadmin' : 'user';
  const statements = [
    `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
     SELECT '${id}', '${email}', 1, '${name}', '${role}', 'active', ${nowMs}, ${nowMs}
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(trim(email)) = '${email}')`,
    ...(plan.superadmin
      ? [
          `UPDATE users SET role = 'superadmin',
             status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
             updated_at = ${nowMs}
           WHERE ${MATCH(email)}`,
        ]
      : []),
    `SELECT id, email, role, status, email_verified AS emailVerified,
       (SELECT count(*) FROM users WHERE role = 'superadmin' AND status = 'active') AS activeSuperadmins
     FROM users WHERE ${MATCH(email)}`,
  ];
  return statements.map((statement) => `${statement.replace(/\s+/g, ' ').trim()};`).join('\n');
}
