/**
 * EXPERIMENT (E3) — runnable migration backfill dry-run against staging D1.
 *
 * This is a READ-ONLY observation tool (Rule 32). It NEVER writes to D1, and it
 * NEVER pulls ciphertext: the SQL projects each row to its NON-SECRET metadata
 * and derives a `secretFingerprint` from a GROUP BY on (user_id, encrypted_token,
 * iv) so the actual encrypted bytes never leave the database. The fingerprint is
 * the dense-rank of that group — distinct secrets get distinct numbers, identical
 * secrets share one — which is all the structural backfill needs to prove dedup.
 *
 * It then feeds that metadata to the PURE `backfill()` mapper and prints the
 * resulting primitive counts + edge-case report. Run it to confirm the migration
 * is non-destructive on real staging data before ever touching production.
 *
 * Usage:
 *   CF_TOKEN=... pnpm --filter @simple-agent-manager/shared exec \
 *     tsx src/experiments/composable-credentials/backfill-dryrun.ts
 *
 * Account / D1 ids are the staging values from .claude/rules/32-cf-api-debugging.md
 * and are overridable via env for other environments.
 */

import { backfill, type SourceCredentialRow, type SourcePlatformRow } from './backfill';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? 'c4e4aebd980b626f6af43ac6b1edcede';
const D1_ID = process.env.CF_D1_ID ?? '1cfaf5d4-8226-47d8-bf26-6ba727ce5718';

// Dense-rank each distinct secret WITHOUT selecting the ciphertext. The rank is a
// stable per-secret integer; identical (user_id, encrypted_token, iv) tuples share
// a rank, distinct ones differ. encrypted_token/iv are used only inside the window
// function — they are never projected into the result set.
const CREDENTIAL_SQL = `
  SELECT
    id,
    user_id        AS userId,
    project_id     AS projectId,
    credential_type AS credentialType,
    agent_type     AS agentType,
    provider,
    credential_kind AS credentialKind,
    is_active      AS isActive,
    'fp-' || DENSE_RANK() OVER (
      ORDER BY user_id, encrypted_token, iv
    ) AS secretFingerprint
  FROM credentials
`;

const PLATFORM_SQL = `
  SELECT
    id,
    credential_type AS credentialType,
    agent_type     AS agentType,
    provider,
    credential_kind AS credentialKind,
    is_enabled     AS isEnabled,
    'plat-fp-' || DENSE_RANK() OVER (
      ORDER BY encrypted_token, iv
    ) AS secretFingerprint
  FROM platform_credentials
`;

interface D1QueryResult<T> {
  success: boolean;
  result: { results: T[] }[];
  errors: { message: string }[];
}

async function d1Query<T>(token: string, sql: string): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    },
  );
  const json = (await res.json()) as D1QueryResult<T>;
  if (!json.success) {
    throw new Error(`D1 query failed: ${json.errors?.map((e) => e.message).join('; ')}`);
  }
  return json.result[0]?.results ?? [];
}

function asBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

async function main(): Promise<void> {
  const token = process.env.CF_TOKEN;
  if (!token) {
    console.error('CF_TOKEN is required (read-only staging D1 token).');
    process.exit(1);
  }

  const rawCreds = await d1Query<Record<string, unknown>>(token, CREDENTIAL_SQL);
  const rawPlatform = await d1Query<Record<string, unknown>>(token, PLATFORM_SQL);

  const credentialRows: SourceCredentialRow[] = rawCreds.map((r) => ({
    id: String(r.id),
    userId: String(r.userId),
    projectId: r.projectId == null ? null : String(r.projectId),
    credentialType: r.credentialType as SourceCredentialRow['credentialType'],
    agentType: r.agentType == null ? null : String(r.agentType),
    provider: String(r.provider ?? ''),
    credentialKind: r.credentialKind as SourceCredentialRow['credentialKind'],
    isActive: asBool(r.isActive),
    secretFingerprint: String(r.secretFingerprint),
  }));

  const platformRows: SourcePlatformRow[] = rawPlatform.map((r) => ({
    id: String(r.id),
    credentialType: r.credentialType as SourcePlatformRow['credentialType'],
    agentType: r.agentType == null ? null : String(r.agentType),
    provider: r.provider == null ? null : String(r.provider),
    credentialKind: r.credentialKind as SourcePlatformRow['credentialKind'],
    isEnabled: asBool(r.isEnabled),
    secretFingerprint: String(r.secretFingerprint),
  }));

  const { report } = backfill(credentialRows, platformRows);

  console.log('=== E3 migration backfill dry-run (staging, READ-ONLY) ===\n');
  console.log('Source rows:');
  console.log(`  credentials          ${report.sourceCredentialRows}`);
  console.log(`  platform_credentials ${report.sourcePlatformRows}\n`);
  console.log('Produced primitives:');
  console.log(`  Credentials      ${report.producedCredentials}`);
  console.log(`  Configurations   ${report.producedConfigurations}`);
  console.log(`  Attachments      ${report.producedAttachments}`);
  console.log(`  PlatformDefaults ${report.producedPlatformDefaults}\n`);
  console.log('Invariants:');
  console.log(`  shared-secret groups (dedup wins)  ${report.sharedSecretGroups}`);
  console.log(`  inactive project rows (Rule 28)    ${report.inactiveProjectRows}\n`);
  if (report.skipped.length > 0) {
    console.log('Skipped (reported, never silently dropped):');
    for (const s of report.skipped) console.log(`  ${s.rowId}: ${s.reason}`);
  } else {
    console.log('Skipped: none — every row mapped cleanly.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
