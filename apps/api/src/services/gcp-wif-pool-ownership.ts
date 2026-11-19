/**
 * One owner per Google Cloud workload identity pool.
 *
 * SAM signs an identity token for whatever pool a stored GCP credential names. A pool whose
 * provider checks only SAM's issuer, with a `pool/*` binding (the user-level guided setup before
 * this module existed), accepts any token SAM signs. So user B could save a credential naming
 * user A's pool and impersonate A's service account. This module refuses that on the Worker side:
 * a credential may name a `(gcpProjectNumber, wifPoolId)` only when no credential belonging to a
 * different owner names it. Owners are one SAM user (user-level and project-scoped credentials of
 * the same user may share a pool) or the installation (platform credentials).
 *
 * Pool identities live inside encrypted credential payloads, so they are indexed in
 * `gcp_wif_pool_index`, one row per stored credential, keyed by the row's IV. Writers do not
 * maintain the index: every check first indexes rows whose IV the index has not seen (a new or
 * re-encrypted row), then reads owners only through index rows whose source row still exists with
 * the same IV. A writer that forgets the index, a deleted credential, or a rotation therefore
 * cannot leave the check reading stale data. Deployment credentials store their pool in plaintext
 * and are read directly.
 *
 * Per check: one D1 round trip (the unindexed-row probe and the owner lookup run as one batch).
 * Only when a credential was added or re-encrypted since the last check does it decrypt those
 * rows, page by page, inside a time budget, and run the owner lookup again.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { AppError } from '../middleware/error';
import { resolveAdminSetting } from './admin-settings-resolution';
import { decrypt } from './encryption';
import { extractCloudProviderToken, parseGcpCredential } from './provider-credential-codecs';

/** Who a stored GCP credential belongs to, for pool ownership. */
export type GcpWifPoolOwner = { kind: 'platform' } | { kind: 'user'; userId: string };

/** The pool a workload-identity credential names, in comparable form. */
export interface GcpWifPoolIdentity {
  gcpProjectNumber: string;
  wifPoolId: string;
  /** `<projectNumber>/<poolId>`, the index key. */
  key: string;
}

const PROJECT_NUMBER_PATTERN = /^\d{1,20}$/;
const POOL_ID_PATTERN = /^[a-z0-9-]{1,63}$/;

/**
 * Normalize a pool identity, or return null when the values cannot name a real pool. Google
 * resource IDs are lowercase and STS audiences use the project number, so a value that differs
 * only in case or whitespace is the same pool.
 */
export function gcpWifPoolIdentity(
  gcpProjectNumber: string,
  wifPoolId: string
): GcpWifPoolIdentity | null {
  const projectNumber = gcpProjectNumber.trim();
  const poolId = wifPoolId.trim().toLowerCase();
  if (!PROJECT_NUMBER_PATTERN.test(projectNumber) || !POOL_ID_PATTERN.test(poolId)) return null;
  return { gcpProjectNumber: projectNumber, wifPoolId: poolId, key: `${projectNumber}/${poolId}` };
}

/**
 * The pool a decrypted cloud-provider payload names, or null when it is not a GCP
 * workload-identity credential. Never throws: stored payloads come in several encodings
 * (raw tokens for other providers, `{provider, token}` wrappers, GCP JSON), and a payload this
 * cannot read must not break the check for every other credential (rule 41).
 */
export function gcpWifPoolFromDecryptedPayload(decrypted: string): GcpWifPoolIdentity | null {
  try {
    const credential = parseGcpCredential(extractCloudProviderToken('gcp', decrypted));
    if (credential.authType !== 'workload-identity') return null;
    return gcpWifPoolIdentity(credential.gcpProjectNumber, credential.wifPoolId);
  } catch {
    return null;
  }
}

export class GcpWifPoolOwnedByAnotherOwnerError extends AppError {
  constructor() {
    super(
      409,
      'GCP_WIF_POOL_OWNED_BY_ANOTHER_OWNER',
      'This Google Cloud workload identity pool is already used by a credential that belongs to a different SAM owner. Each SAM user, and the installation itself, must use its own pool.'
    );
    this.name = 'GcpWifPoolOwnedByAnotherOwnerError';
  }
}

export class GcpWifPoolInvalidError extends AppError {
  constructor() {
    super(
      400,
      'GCP_WIF_POOL_INVALID',
      'The Google Cloud project number must be digits and the workload identity pool ID may contain only lowercase letters, digits and hyphens.'
    );
    this.name = 'GcpWifPoolInvalidError';
  }
}

export class GcpWifPoolIndexUnavailableError extends AppError {
  constructor() {
    super(
      503,
      'GCP_WIF_POOL_INDEX_UNAVAILABLE',
      'SAM could not confirm who owns this Google Cloud workload identity pool. Try again shortly.'
    );
    this.name = 'GcpWifPoolIndexUnavailableError';
  }
}

/** True for the refusals this module raises, which callers must surface unchanged. */
export function isGcpWifPoolOwnershipError(err: unknown): boolean {
  return (
    err instanceof GcpWifPoolOwnedByAnotherOwnerError ||
    err instanceof GcpWifPoolInvalidError ||
    err instanceof GcpWifPoolIndexUnavailableError
  );
}

type SourceTable = 'credentials' | 'platform_credentials' | 'cc_credentials';

interface UnindexedRow {
  sourceTable: SourceTable;
  sourceId: string;
  ownerKind: 'user' | 'platform';
  ownerUserId: string | null;
  encryptedToken: string;
  iv: string;
}

interface PoolOwnerRow {
  sourceTable: string;
  sourceId: string;
  ownerKind: 'user' | 'platform';
  ownerUserId: string | null;
}

// Every stored row that can be exchanged as a GCP credential. Composable credentials do not
// record their provider in plaintext, so every cloud-provider row is indexed once (a non-GCP row
// is stored with a NULL pool and is not decrypted again until it is re-encrypted).
const UNINDEXED_ROWS_SQL = `
SELECT 'credentials' AS sourceTable, c.id AS sourceId, 'user' AS ownerKind, c.user_id AS ownerUserId,
       c.encrypted_token AS encryptedToken, c.iv AS iv
  FROM credentials c
 WHERE c.provider = 'gcp' AND c.credential_type = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'credentials' AND i.source_id = c.id
                      AND i.iv = c.iv AND i.owner_kind = 'user' AND i.owner_user_id = c.user_id)
UNION ALL
SELECT 'platform_credentials', p.id, 'platform', NULL, p.encrypted_token, p.iv
  FROM platform_credentials p
 WHERE p.provider = 'gcp' AND p.credential_type = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'platform_credentials' AND i.source_id = p.id
                      AND i.iv = p.iv AND i.owner_kind = 'platform')
UNION ALL
SELECT 'cc_credentials', cc.id, 'user', cc.owner_id, cc.encrypted_token, cc.iv
  FROM cc_credentials cc
 WHERE cc.kind = 'cloud-provider'
   AND NOT EXISTS (SELECT 1 FROM gcp_wif_pool_index i
                    WHERE i.source_table = 'cc_credentials' AND i.source_id = cc.id
                      AND i.iv = cc.iv AND i.owner_kind = 'user' AND i.owner_user_id = cc.owner_id)
LIMIT ?`;

// Owners of one pool. Index rows of deleted credentials drop out through the existence checks.
// The read is used only when the unindexed-row probe in the same D1 batch (one transaction)
// returned nothing, so every remaining index row already matches its credential's current IV and
// owner. Inactive and disabled rows still count: they can be re-enabled, and the pool's binding
// in Google still trusts them.
const POOL_OWNERS_SQL = `
SELECT i.source_table AS sourceTable, i.source_id AS sourceId, i.owner_kind AS ownerKind,
       i.owner_user_id AS ownerUserId
  FROM gcp_wif_pool_index i
 WHERE i.pool_key = ?
   AND (
     (i.source_table = 'credentials' AND EXISTS (
        SELECT 1 FROM credentials c WHERE c.id = i.source_id AND c.provider = 'gcp'
           AND c.credential_type = 'cloud-provider'))
     OR (i.source_table = 'platform_credentials' AND EXISTS (
        SELECT 1 FROM platform_credentials p WHERE p.id = i.source_id AND p.provider = 'gcp'
           AND p.credential_type = 'cloud-provider'))
     OR (i.source_table = 'cc_credentials' AND EXISTS (
        SELECT 1 FROM cc_credentials cc WHERE cc.id = i.source_id AND cc.kind = 'cloud-provider'))
   )
UNION ALL
SELECT 'project_deployment_credentials', d.id, 'user', d.user_id
  FROM project_deployment_credentials d
 WHERE d.provider = 'gcp' AND d.gcp_project_number = ? AND lower(trim(d.wif_pool_id)) = ?`;

const UPSERT_INDEX_SQL = `
INSERT INTO gcp_wif_pool_index
  (source_table, source_id, iv, owner_kind, owner_user_id, pool_key, indexed_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source_table, source_id) DO UPDATE SET
  iv = excluded.iv, owner_kind = excluded.owner_kind, owner_user_id = excluded.owner_user_id,
  pool_key = excluded.pool_key, indexed_at = excluded.indexed_at`;

function isSourceTable(value: unknown): value is SourceTable {
  return value === 'credentials' || value === 'platform_credentials' || value === 'cc_credentials';
}

function toUnindexedRow(row: Record<string, unknown>): UnindexedRow | null {
  const { sourceTable, sourceId, ownerKind, ownerUserId, encryptedToken, iv } = row;
  if (
    !isSourceTable(sourceTable) ||
    typeof sourceId !== 'string' ||
    (ownerKind !== 'user' && ownerKind !== 'platform') ||
    (ownerUserId !== null && typeof ownerUserId !== 'string') ||
    typeof encryptedToken !== 'string' ||
    typeof iv !== 'string'
  ) {
    return null;
  }
  return { sourceTable, sourceId, ownerKind, ownerUserId, encryptedToken, iv };
}

function toPoolOwnerRow(row: Record<string, unknown>): PoolOwnerRow | null {
  const { sourceTable, sourceId, ownerKind, ownerUserId } = row;
  if (
    typeof sourceTable !== 'string' ||
    typeof sourceId !== 'string' ||
    (ownerKind !== 'user' && ownerKind !== 'platform') ||
    (ownerUserId !== null && typeof ownerUserId !== 'string')
  ) {
    return null;
  }
  return { sourceTable, sourceId, ownerKind, ownerUserId };
}

function ownerLabel(owner: GcpWifPoolOwner): string {
  return owner.kind === 'platform' ? 'platform' : `user:${owner.userId}`;
}

function belongsToOwner(row: PoolOwnerRow, owner: GcpWifPoolOwner): boolean {
  if (owner.kind === 'platform') return row.ownerKind === 'platform';
  return row.ownerKind === 'user' && row.ownerUserId === owner.userId;
}

async function readIndexSettings(env: Env): Promise<{ pageSize: number; budgetMs: number }> {
  const [pageSize, budgetMs] = await Promise.all([
    resolveAdminSetting(env, 'gcpWif.poolIndexPageSize'),
    resolveAdminSetting(env, 'gcpWif.poolIndexBudgetMs'),
  ]);
  return { pageSize: Number(pageSize), budgetMs: Number(budgetMs) };
}

/** Decrypt and index one page of unindexed rows. A row that fails is indexed with no pool. */
async function indexRows(env: Env, rows: UnindexedRow[]): Promise<void> {
  const key = getCredentialEncryptionKey(env);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    let poolKey: string | null = null;
    try {
      const decrypted = await decrypt(row.encryptedToken, row.iv, key);
      poolKey = gcpWifPoolFromDecryptedPayload(decrypted)?.key ?? null;
    } catch (err) {
      // An unreadable row cannot be exchanged either, so it owns no pool. Recording it stops
      // it being decrypted again on every check until it is re-encrypted (rule 41, rule 47).
      log.error('gcp_wif_pool_index.row_unreadable', {
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        error: err instanceof Error ? err.message : String(err),
        action: 'indexed_without_pool',
      });
    }
    statements.push(
      env.DATABASE.prepare(UPSERT_INDEX_SQL).bind(
        row.sourceTable,
        row.sourceId,
        row.iv,
        row.ownerKind,
        row.ownerKind === 'platform' ? null : row.ownerUserId,
        poolKey,
        now
      )
    );
  }
  if (statements.length > 0) await env.DATABASE.batch(statements);
}

function parseRows<T>(
  results: Record<string, unknown>[] | undefined,
  parse: (row: Record<string, unknown>) => T | null,
  context: string
): T[] {
  const parsed: T[] = [];
  for (const row of results ?? []) {
    const value = parse(row);
    if (value) parsed.push(value);
    else log.error('gcp_wif_pool_index.row_skipped', { context, action: 'skipped' });
  }
  return parsed;
}

/**
 * Bring the index up to date, then return every live credential that names `pool`.
 * Throws GcpWifPoolIndexUnavailableError when unindexed rows remain after the time budget,
 * because an incomplete index cannot prove that no other owner names the pool.
 */
async function listPoolOwners(env: Env, pool: GcpWifPoolIdentity): Promise<PoolOwnerRow[]> {
  const { pageSize, budgetMs } = await readIndexSettings(env);
  const deadline = Date.now() + budgetMs;
  const ownersStatement = env.DATABASE.prepare(POOL_OWNERS_SQL).bind(
    pool.key,
    pool.gcpProjectNumber,
    pool.wifPoolId
  );
  let indexedAny = false;
  for (;;) {
    const [unindexedResult, ownersResult] = await env.DATABASE.batch<Record<string, unknown>>([
      env.DATABASE.prepare(UNINDEXED_ROWS_SQL).bind(pageSize),
      ownersStatement,
    ]);
    const unindexed = parseRows(unindexedResult?.results, toUnindexedRow, 'unindexed');
    if (unindexed.length === 0) {
      const owners = parseRows(ownersResult?.results, toPoolOwnerRow, 'owners');
      if (indexedAny) {
        log.info('gcp_wif_pool_index.reconciled', { poolKey: pool.key, owners: owners.length });
      }
      return owners;
    }
    if (Date.now() >= deadline) {
      log.error('gcp_wif_pool_index.budget_exhausted', {
        poolKey: pool.key,
        budgetMs,
        remainingPage: unindexed.length,
        action: 'refused',
      });
      throw new GcpWifPoolIndexUnavailableError();
    }
    await indexRows(env, unindexed);
    indexedAny = true;
  }
}

/**
 * Refuse when a credential belonging to a different owner names `pool`.
 * `context` names the caller (save route or token exchange) for the structured log line.
 */
export async function assertGcpWifPoolOwnership(
  env: Env,
  pool: { gcpProjectNumber: string; wifPoolId: string },
  owner: GcpWifPoolOwner,
  context: string
): Promise<void> {
  const identity = gcpWifPoolIdentity(pool.gcpProjectNumber, pool.wifPoolId);
  if (!identity) {
    log.error('gcp_wif_pool.invalid_identity', {
      context,
      owner: ownerLabel(owner),
      action: 'refused',
    });
    throw new GcpWifPoolInvalidError();
  }
  const owners = await listPoolOwners(env, identity);
  const foreign = owners.filter((row) => !belongsToOwner(row, owner));
  if (foreign.length === 0) return;
  log.error('gcp_wif_pool.cross_owner_refused', {
    context,
    poolKey: identity.key,
    owner: ownerLabel(owner),
    conflictingCredentials: foreign.map((row) => `${row.sourceTable}:${row.sourceId}`),
    conflictingOwnerKinds: [...new Set(foreign.map((row) => row.ownerKind))],
    action: 'refused',
  });
  throw new GcpWifPoolOwnedByAnotherOwnerError();
}

/**
 * Save-time form of the check for a decrypted or about-to-be-encrypted cloud-provider payload.
 * Payloads that are not GCP workload-identity credentials pass through untouched.
 */
export async function assertGcpWifPayloadOwnership(
  env: Env,
  payload: string,
  owner: GcpWifPoolOwner,
  context: string
): Promise<void> {
  const credential = (() => {
    try {
      return parseGcpCredential(extractCloudProviderToken('gcp', payload));
    } catch {
      return null;
    }
  })();
  if (credential?.authType !== 'workload-identity') return;
  await assertGcpWifPoolOwnership(env, credential, owner, context);
}
