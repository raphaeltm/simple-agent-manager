/**
 * Durable Object migration compatibility resolution.
 *
 * Reads the target API Worker's deployed migration state from Cloudflare and
 * resolves the checked-in migration history against it: applied entries are
 * preserved exactly, and only pending legacy `new_classes` creates are emitted
 * as `new_sqlite_classes` (new Cloudflare accounts cannot create KV-backed
 * Durable Object namespaces — error 10099, issue #1614).
 *
 * Every ambiguous state fails closed: Wrangler treats an unknown deployed tag
 * as a reason to submit the entire local migration history, which can replay
 * immutable namespace history.
 */

import type { MigrationEntry } from './types.js';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const WORKERS_LIST_PAGE_SIZE = 1000;

/**
 * The migration-state probe runs immediately after `wrangler deploy` on the
 * two-pass first install, where the scripts listing can briefly lag the
 * just-created Worker. The probe is read-only and idempotent, so transient
 * failures are retried a bounded number of times before failing the deploy.
 */
const DEFAULT_MIGRATION_STATE_PROBE_ATTEMPTS = 3;
const DEFAULT_MIGRATION_STATE_PROBE_RETRY_DELAY_MS = 2000;

const NEVER_DELETE_WORKER_GUIDANCE =
  'Never delete a Worker that has served SAM traffic to recover from this: deleting it destroys all Durable Object data.';

function requireCloudflareApiToken(operation: string): string {
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error(`CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required to ${operation}`);
  }
  return apiToken;
}

function readBoundedIntEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    console.warn(`  ${name}="${raw}" is not an integer >= ${minimum}; using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

async function fetchCloudflareMigrationState(
  url: string,
  apiToken: string,
  operation: string
): Promise<Response> {
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  } catch {
    throw new Error(`${operation}: Cloudflare API request failed`);
  }
}

/**
 * Single read of the deployed migration state. Returns null only when
 * Cloudflare's exact Worker settings endpoint confirms that the target Worker
 * does not exist. For an existing Worker, reads the latest applied Durable
 * Object migration tag from Workers script metadata.
 *
 * SECURITY: the settings endpoint's 200 response body contains plaintext
 * values for every `plain_text` binding, including the live SETUP_TOKEN.
 * Only the HTTP status may be inspected here — never read or log the body.
 */
async function probeDeployedWorkerMigrationTag(
  accountId: string,
  workerName: string,
  apiToken: string
): Promise<string | null> {
  const scriptsUrl =
    `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts?per_page=${WORKERS_LIST_PAGE_SIZE}`;
  const listOperation = `Failed to list Workers while reading migration state for "${workerName}"`;
  const scriptsResponse = await fetchCloudflareMigrationState(scriptsUrl, apiToken, listOperation);
  if (!scriptsResponse.ok) {
    throw new Error(`${listOperation} (HTTP ${scriptsResponse.status})`);
  }

  let payload: unknown;
  try {
    payload = await scriptsResponse.json();
  } catch {
    throw new Error(`${listOperation}: Cloudflare returned an invalid JSON response`);
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('success' in payload) ||
    payload.success !== true ||
    !('result' in payload) ||
    !Array.isArray(payload.result)
  ) {
    throw new Error(`${listOperation}: Cloudflare returned an invalid response`);
  }

  const worker = payload.result.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === workerName
  );
  if (!worker) {
    const readOperation = `Failed to read Durable Object migration state for Worker "${workerName}"`;
    const settingsUrl =
      `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}` +
      `/workers/scripts/${encodeURIComponent(workerName)}/settings`;
    const settingsResponse = await fetchCloudflareMigrationState(
      settingsUrl,
      apiToken,
      readOperation
    );

    if (settingsResponse.status === 404) {
      return null;
    }
    if (!settingsResponse.ok) {
      throw new Error(`${readOperation} (HTTP ${settingsResponse.status})`);
    }
    throw new Error(
      `Worker "${workerName}" exists but is absent from the Workers scripts listing; ` +
        `refusing to assume clean migration state. This can be transient listing lag ` +
        `immediately after the Worker was created — re-running the deployment is safe.`
    );
  }
  if (typeof worker.migration_tag !== 'string' || worker.migration_tag.length === 0) {
    throw new Error(
      `Existing Worker "${workerName}" has no migration_tag; refusing to replay Durable Object migrations. ` +
        `If the Worker was created moments ago this can be propagation lag — re-running the deployment is safe. ` +
        `Otherwise this Worker was not created by SAM's deploy pipeline and must be investigated manually. ` +
        NEVER_DELETE_WORKER_GUIDANCE
    );
  }
  return worker.migration_tag;
}

/**
 * Reads the deployed Durable Object migration tag with bounded retries.
 *
 * This intentionally fails closed on incomplete or unreadable state. Wrangler
 * otherwise treats an unknown deployed tag as a reason to submit every local
 * migration, which can replay immutable namespace history. All probe failures
 * are retried (the probe is read-only and idempotent); a missing API token is
 * a deterministic configuration error and fails immediately.
 */
export async function getDeployedWorkerMigrationTag(
  accountId: string,
  workerName: string
): Promise<string | null> {
  const apiToken = requireCloudflareApiToken('read Durable Object migration state');
  const attempts = readBoundedIntEnv(
    'DO_MIGRATION_STATE_PROBE_ATTEMPTS',
    DEFAULT_MIGRATION_STATE_PROBE_ATTEMPTS,
    1
  );
  const retryDelayMs = readBoundedIntEnv(
    'DO_MIGRATION_STATE_PROBE_RETRY_DELAY_MS',
    DEFAULT_MIGRATION_STATE_PROBE_RETRY_DELAY_MS,
    0
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await probeDeployedWorkerMigrationTag(accountId, workerName, apiToken);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `  Durable Object migration state probe attempt ${attempt}/${attempts} failed: ${message}`
        );
        console.warn(`  Retrying in ${retryDelayMs}ms...`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Preserve applied migration entries exactly, while ensuring every pending
 * namespace create uses Cloudflare's supported SQLite storage backend.
 */
export function resolveDurableObjectMigrations(
  migrations: MigrationEntry[] | undefined,
  deployedMigrationTag: string | null
): MigrationEntry[] | undefined {
  if (!migrations || migrations.length === 0) {
    if (deployedMigrationTag !== null) {
      throw new Error(
        `Deployed Durable Object migration tag "${deployedMigrationTag}" cannot be reconciled because the checked-in migration history is empty. ` +
          `Restore the [[migrations]] entries in apps/api/wrangler.toml so the deployed tag appears in the history, then redeploy. ` +
          NEVER_DELETE_WORKER_GUIDANCE
      );
    }
    return undefined;
  }

  const duplicateTag = migrations.find(
    (migration, index) =>
      migrations.findIndex((candidate) => candidate.tag === migration.tag) !== index
  )?.tag;
  if (duplicateTag) {
    throw new Error(`Durable Object migration tag "${duplicateTag}" is duplicated`);
  }

  const appliedIndex =
    deployedMigrationTag === null
      ? -1
      : migrations.findIndex((migration) => migration.tag === deployedMigrationTag);
  if (deployedMigrationTag !== null && appliedIndex === -1) {
    throw new Error(
      `Deployed Durable Object migration tag "${deployedMigrationTag}" is not present in the checked-in history; refusing to replay migrations. ` +
        `The checked-in wrangler.toml is missing migration entries that were already applied to this Worker ` +
        `(often an upgrade merge that dropped fork-local migrations). Restore the missing entries so the ` +
        `deployed tag appears in the history, then redeploy. ` +
        NEVER_DELETE_WORKER_GUIDANCE
    );
  }

  return migrations.map((migration, index) => {
    if (index <= appliedIndex || !migration.new_classes?.length) {
      return migration;
    }

    const {
      new_classes: legacyClasses,
      new_sqlite_classes: sqliteClasses,
      ...unchanged
    } = migration;
    return {
      ...unchanged,
      new_sqlite_classes: [...(sqliteClasses ?? []), ...legacyClasses],
    };
  });
}
