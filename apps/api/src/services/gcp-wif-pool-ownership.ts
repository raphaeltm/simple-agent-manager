/**
 * One owner per Google Cloud workload identity pool.
 *
 * SAM signs an identity token for whatever pool a stored GCP credential names. A pool whose
 * provider checks only SAM's issuer, with a `pool/*` binding (the user-level guided setup before
 * this module existed), accepts any token SAM signs. So user B could save a credential naming
 * user A's pool and impersonate A's service account. This module refuses that on the Worker side.
 * Owners are one SAM user (their user-level and project-scoped credentials may share a pool) or
 * the installation (platform credentials). A credential may name a `(gcpProjectNumber, wifPoolId)`
 * only when
 * - no credential of a different owner names it, and
 * - the pool is unclaimed or claimed by the same owner. The first owner whose credential names a
 *   pool claims it, and the claim outlives that credential: deleting or re-pointing a credential
 *   in SAM leaves the trust an earlier setup granted in Google, so it must not free the pool for
 *   someone else. An operator releases a claim by deleting its row (see the self-hosting guide).
 *
 * Pool identities live inside encrypted credential payloads, so they are indexed in
 * `gcp_wif_pool_index`, one row per stored credential, keyed by the row's IV. Writers do not
 * maintain the index: every check first indexes rows whose IV the index has not seen, in the same
 * D1 batch (one transaction) as the read of the pool's holders. A writer that skips the index, a
 * deleted credential, or a rotation therefore cannot leave the check reading stale data.
 *
 * The holders read may be served by a read replica at or after the request's bookmark; the
 * claim insert and its re-read are one write batch on the primary, which is what decides who
 * holds an unclaimed pool.
 *
 * I/O per check when nothing changed: one D1 round trip, no decryption, no admin-settings read.
 * A first-time claim adds one round trip for that pool. A new or re-encrypted credential adds
 * one page of decrypts plus two round trips per `gcpWif.poolIndexPageSize` rows, within
 * `gcpWif.poolIndexBudgetMs`; past the budget the check refuses rather than trust a partial index.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { AppError } from '../middleware/error';
import {
  DEFAULT_GCP_WIF_POOL_INDEX_PAGE_SIZE,
  DEFAULT_GCP_WIF_POOL_INDEX_UNREADABLE_RETRY_MINUTES,
} from './admin-settings-gcp-catalog-definitions';
import { resolveAdminSetting } from './admin-settings-resolution';
import { decrypt } from './encryption';
import {
  CLAIM_POOL_SQL,
  POOL_HOLDERS_SQL,
  READ_CLAIM_SQL,
  UNINDEXED_ROWS_SQL,
  UPSERT_INDEX_SQL,
} from './gcp-wif-pool-ownership-sql';
import { extractCloudProviderToken, parseGcpCredential } from './provider-credential-codecs';

/** Who a stored GCP credential belongs to, for pool ownership. */
export type GcpWifPoolOwner = { kind: 'platform' } | { kind: 'user'; userId: string };

/** The pool a workload-identity credential names, in comparable form. */
export interface GcpWifPoolIdentity {
  gcpProjectNumber: string;
  wifPoolId: string;
  /** `<projectNumber>/<poolId>`, the index and claim key. */
  key: string;
}

// Google project numbers never start with 0, so `0123` cannot alias `123`.
const PROJECT_NUMBER_PATTERN = /^[1-9]\d{0,19}$/;
const POOL_ID_PATTERN = /^[a-z0-9-]{1,63}$/;

/**
 * Normalize a pool identity, or return null when the values cannot name a real pool. Google
 * resource IDs are lowercase and STS audiences use the project number, so a value that differs
 * only in case or surrounding whitespace is the same pool.
 */
export function gcpWifPoolIdentity(
  gcpProjectNumber: string,
  wifPoolId: string
): GcpWifPoolIdentity | null {
  if (typeof gcpProjectNumber !== 'string' || typeof wifPoolId !== 'string') return null;
  const projectNumber = gcpProjectNumber.trim();
  const poolId = wifPoolId.trim().toLowerCase();
  if (!PROJECT_NUMBER_PATTERN.test(projectNumber) || !POOL_ID_PATTERN.test(poolId)) return null;
  return { gcpProjectNumber: projectNumber, wifPoolId: poolId, key: `${projectNumber}/${poolId}` };
}

const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,63}$/;
const SERVICE_ACCOUNT_EMAIL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9][a-z0-9.-]{0,252}$/i;

/**
 * Refuse a credential whose provider ID or service account could change the STS audience or the
 * impersonation URL they are interpolated into (path segments, query strings).
 */
export function assertGcpWifCredentialShape(credential: {
  wifProviderId: string;
  serviceAccountEmail: string;
}): void {
  if (
    typeof credential.wifProviderId !== 'string' ||
    typeof credential.serviceAccountEmail !== 'string' ||
    !PROVIDER_ID_PATTERN.test(credential.wifProviderId) ||
    !SERVICE_ACCOUNT_EMAIL_PATTERN.test(credential.serviceAccountEmail)
  ) {
    log.warn('gcp_wif_pool.invalid_credential_shape', { action: 'refused' });
    throw new GcpWifPoolInvalidError();
  }
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
      'This Google Cloud workload identity pool already belongs to a different SAM owner. Each SAM user, and the installation itself, must use its own pool.'
    );
    this.name = 'GcpWifPoolOwnedByAnotherOwnerError';
  }
}

export class GcpWifPoolInvalidError extends AppError {
  constructor() {
    super(
      400,
      'GCP_WIF_POOL_INVALID',
      'The Google Cloud project number must be digits, the workload identity pool and provider IDs may contain only lowercase letters, digits and hyphens, and the service account must be an email address.'
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

interface PoolHolderRow {
  sourceTable: string;
  sourceId: string;
  ownerKind: 'user' | 'platform';
  ownerUserId: string | null;
}

function isSourceTable(value: unknown): value is SourceTable {
  return value === 'credentials' || value === 'platform_credentials' || value === 'cc_credentials';
}

function toUnindexedRow(row: Record<string, unknown>): UnindexedRow | null {
  const { sourceTable, sourceId, ownerKind, ownerUserId, encryptedToken, iv } = row;
  if (
    !isSourceTable(sourceTable) ||
    typeof sourceId !== 'string' ||
    typeof encryptedToken !== 'string' ||
    typeof iv !== 'string'
  ) {
    return null;
  }
  if (ownerKind === 'platform') {
    return { sourceTable, sourceId, ownerKind, ownerUserId: null, encryptedToken, iv };
  }
  if (ownerKind === 'user' && typeof ownerUserId === 'string') {
    return { sourceTable, sourceId, ownerKind, ownerUserId, encryptedToken, iv };
  }
  return null;
}

function toPoolHolderRow(row: Record<string, unknown>): PoolHolderRow | null {
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

/**
 * Parse every row or fail closed. A row these queries return always has these shapes (the
 * columns are NOT NULL), so an unparseable row means the check cannot be trusted: treating it
 * as absent could hide an unindexed credential or a foreign holder.
 */
function parseAll<T>(
  results: Record<string, unknown>[],
  parse: (row: Record<string, unknown>) => T | null,
  context: string
): T[] {
  const parsed: T[] = [];
  for (const row of results) {
    const value = parse(row);
    if (!value) {
      log.error('gcp_wif_pool_index.row_unparseable', { context, action: 'refused' });
      throw new GcpWifPoolIndexUnavailableError();
    }
    parsed.push(value);
  }
  return parsed;
}

function ownerLabel(owner: GcpWifPoolOwner): string {
  return owner.kind === 'platform' ? 'platform' : `user:${owner.userId}`;
}

function heldBy(row: PoolHolderRow, owner: GcpWifPoolOwner): boolean {
  if (owner.kind === 'platform') return row.ownerKind === 'platform';
  return row.ownerKind === 'user' && row.ownerUserId === owner.userId;
}

function ownerColumns(owner: GcpWifPoolOwner): ['user' | 'platform', string | null] {
  return owner.kind === 'platform' ? ['platform', null] : ['user', owner.userId];
}

function retryCutoff(retryMinutes: number): string {
  return new Date(Date.now() - retryMinutes * 60_000).toISOString();
}

/**
 * Decrypt and index one page; claim each named pool for the row's owner if it is unclaimed.
 * Returns the number of D1 statements issued.
 */
async function indexRows(env: Env, rows: UnindexedRow[]): Promise<number> {
  const key = getCredentialEncryptionKey(env);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    let poolKey: string | null = null;
    let unreadable = 0;
    try {
      const decrypted = await decrypt(row.encryptedToken, row.iv, key);
      poolKey = gcpWifPoolFromDecryptedPayload(decrypted)?.key ?? null;
    } catch (err) {
      // An unreadable row cannot be exchanged either. It is retried after
      // `gcpWif.poolIndexUnreadableRetryMinutes` (a key fix makes it readable without a new IV),
      // not on every check, so one bad row cannot stall every check (rule 41, rule 47).
      unreadable = 1;
      log.error('gcp_wif_pool_index.row_unreadable', {
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        error: err instanceof Error ? err.message : String(err),
        action: 'indexed_unreadable',
      });
    }
    statements.push(
      env.DATABASE.prepare(UPSERT_INDEX_SQL).bind(
        row.sourceTable,
        row.sourceId,
        row.iv,
        row.ownerKind,
        row.ownerUserId,
        poolKey,
        unreadable,
        now
      )
    );
    if (poolKey) {
      statements.push(
        env.DATABASE.prepare(CLAIM_POOL_SQL).bind(poolKey, row.ownerKind, row.ownerUserId, now)
      );
    }
  }
  if (statements.length > 0) await env.DATABASE.batch(statements);
  return statements.length;
}

async function readIndexSettings(env: Env): Promise<{
  pageSize: number;
  budgetMs: number;
  retryMinutes: number;
  maxQueries: number;
}> {
  const [pageSize, budgetMs, retryMinutes, maxQueries] = await Promise.all([
    resolveAdminSetting(env, 'gcpWif.poolIndexPageSize'),
    resolveAdminSetting(env, 'gcpWif.poolIndexBudgetMs'),
    resolveAdminSetting(env, 'gcpWif.poolIndexUnreadableRetryMinutes'),
    resolveAdminSetting(env, 'gcpWif.poolIndexMaxQueriesPerCheck'),
  ]);
  return {
    pageSize: Number(pageSize),
    budgetMs: Number(budgetMs),
    retryMinutes: Number(retryMinutes),
    maxQueries: Number(maxQueries),
  };
}

/**
 * Bring the index up to date, then return everything that holds `pool`: its claim, live
 * credentials naming it, and deployment credentials naming it. Throws
 * GcpWifPoolIndexUnavailableError when unindexed rows remain after the time budget.
 */
/** Both statements of a two-statement batch returned a row array, or the check cannot be trusted. */
function batchRows(
  results: D1Result<Record<string, unknown>>[] | undefined,
  context: string
): [Record<string, unknown>[], Record<string, unknown>[]] {
  const first = Array.isArray(results) && results.length === 2 ? results[0]?.results : undefined;
  const second = Array.isArray(results) && results.length === 2 ? results[1]?.results : undefined;
  if (!Array.isArray(first) || !Array.isArray(second)) {
    log.error('gcp_wif_pool_index.batch_malformed', { context, action: 'refused' });
    throw new GcpWifPoolIndexUnavailableError();
  }
  return [first, second];
}

/** D1 statements one page of indexing can issue: the probe batch plus up to two per row. */
function queriesPerPage(pageSize: number): number {
  return 2 + 2 * pageSize;
}

/**
 * Bring the index up to date, then return everything that holds `pool`: its claim, live
 * credentials naming it, and deployment credentials naming it. Throws
 * GcpWifPoolIndexUnavailableError when unindexed rows remain after the time budget or the query
 * budget (`gcpWif.poolIndexMaxQueriesPerCheck`, kept under D1's per-invocation query limit), or
 * when D1 fails while indexing. Progress is durable, so the next check continues.
 */
async function listPoolHolders(env: Env, pool: GcpWifPoolIdentity): Promise<PoolHolderRow[]> {
  const holders = env.DATABASE.prepare(POOL_HOLDERS_SQL).bind(
    pool.key,
    pool.key,
    pool.gcpProjectNumber,
    pool.wifPoolId
  );
  // Settings are read only when something needs indexing, so the steady state costs one batch.
  let settings: Awaited<ReturnType<typeof readIndexSettings>> | null = null;
  let deadline = Infinity;
  let queries = 0;
  let indexedAny = false;
  for (;;) {
    const pageSize = settings?.pageSize ?? DEFAULT_GCP_WIF_POOL_INDEX_PAGE_SIZE;
    const cutoff = retryCutoff(
      settings?.retryMinutes ?? DEFAULT_GCP_WIF_POOL_INDEX_UNREADABLE_RETRY_MINUTES
    );
    const [unindexedRows, holderRows] = batchRows(
      await env.DATABASE.batch<Record<string, unknown>>([
        env.DATABASE.prepare(UNINDEXED_ROWS_SQL).bind(cutoff, cutoff, cutoff, pageSize),
        holders,
      ]),
      'probe'
    );
    queries += 2;
    const unindexed = parseAll(unindexedRows, toUnindexedRow, 'unindexed');
    if (unindexed.length === 0) {
      const found = parseAll(holderRows, toPoolHolderRow, 'holders');
      if (indexedAny) {
        log.info('gcp_wif_pool_index.reconciled', { poolKey: pool.key, holders: found.length });
      }
      return found;
    }
    if (!settings) {
      settings = await readIndexSettings(env);
      deadline = Date.now() + settings.budgetMs;
    } else if (
      Date.now() >= deadline ||
      queries + queriesPerPage(settings.pageSize) > settings.maxQueries
    ) {
      log.error('gcp_wif_pool_index.budget_exhausted', {
        poolKey: pool.key,
        budgetMs: settings.budgetMs,
        queries,
        maxQueries: settings.maxQueries,
        remainingPage: unindexed.length,
        action: 'refused',
      });
      throw new GcpWifPoolIndexUnavailableError();
    }
    try {
      queries += await indexRows(env, unindexed);
    } catch (err) {
      log.error('gcp_wif_pool_index.index_write_failed', {
        poolKey: pool.key,
        error: err instanceof Error ? err.message : String(err),
        action: 'refused',
      });
      throw new GcpWifPoolIndexUnavailableError();
    }
    indexedAny = true;
  }
}

function refuse(
  context: string,
  pool: GcpWifPoolIdentity,
  owner: GcpWifPoolOwner,
  foreign: PoolHolderRow[]
): never {
  // A designed refusal, logged at warn (rule 34): one line per refused attempt.
  log.warn('gcp_wif_pool.cross_owner_refused', {
    context,
    poolKey: pool.key,
    owner: ownerLabel(owner),
    conflicting: foreign.map((row) => `${row.sourceTable}:${row.sourceId}`),
    conflictingOwnerKinds: [...new Set(foreign.map((row) => row.ownerKind))],
    action: 'refused',
  });
  throw new GcpWifPoolOwnedByAnotherOwnerError();
}

/**
 * Refuse when the pool is claimed by, or named by a credential of, a different owner; otherwise
 * claim it for `owner` if nobody has. `context` names the caller (a save route or the token
 * exchange) for the structured log line.
 */
export async function assertGcpWifPoolOwnership(
  env: Env,
  pool: { gcpProjectNumber: string; wifPoolId: string },
  owner: GcpWifPoolOwner,
  context: string
): Promise<void> {
  const identity = gcpWifPoolIdentity(pool.gcpProjectNumber, pool.wifPoolId);
  if (!identity) {
    log.warn('gcp_wif_pool.invalid_identity', {
      context,
      owner: ownerLabel(owner),
      action: 'refused',
    });
    throw new GcpWifPoolInvalidError();
  }
  const holders = await listPoolHolders(env, identity);
  const foreign = holders.filter((row) => !heldBy(row, owner));
  if (foreign.length > 0) refuse(context, identity, owner, foreign);
  if (holders.some((row) => row.sourceTable === 'gcp_wif_pool_claims')) return;

  // Unclaimed: claim it. The primary key decides a concurrent claim, so re-read the winner.
  const [ownerKind, ownerUserId] = ownerColumns(owner);
  const [, claimRows] = batchRows(
    await env.DATABASE.batch<Record<string, unknown>>([
      env.DATABASE.prepare(CLAIM_POOL_SQL).bind(
        identity.key,
        ownerKind,
        ownerUserId,
        new Date().toISOString()
      ),
      env.DATABASE.prepare(READ_CLAIM_SQL).bind(identity.key),
    ]),
    'claim'
  );
  const claim = parseAll(claimRows, toPoolHolderRow, 'claim');
  const [winner] = claim;
  if (!winner || claim.length !== 1) throw new GcpWifPoolIndexUnavailableError();
  if (!heldBy(winner, owner)) refuse(context, identity, owner, claim);
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
