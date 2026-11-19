/** Deployment-owned insert-once cutover. No runtime/admin authentication surface. */
import { createHash } from 'node:crypto';
import { readStorageEvidence } from './reliability-storage-evidence.mjs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACTIVATION_KEY = 'reliability.storage.activation.v1';
const API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_WINDOW_SECONDS = 60; // Must match the existing MCP protocol default.

export const INSERT_ACTIVATION = `INSERT INTO platform_settings (key, value)
SELECT ?1, json_object('publishedAt', unixepoch(), 'rateCutoverAt', CAST(?2 AS INTEGER),
  'bootLogCutoverAt', CAST(?2 AS INTEGER), 'windowSeconds', CAST(?3 AS INTEGER))
WHERE typeof(?2) IN ('integer', 'real') AND typeof(?3) IN ('integer', 'real')
  AND ?2 = CAST(?2 AS INTEGER) AND ?3 = CAST(?3 AS INTEGER)
  AND ?2 > unixepoch() AND ?3 > 0 AND CAST(?2 AS INTEGER) % CAST(?3 AS INTEGER) = 0
  AND NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = ?1)`;

export function verifyLiveVersion(deployment, version, expectedSha, expectedVersion) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !expectedVersion) {
    throw new Error('Exact expected SHA and Worker version are required');
  }
  if (
    deployment?.versions?.length !== 1 ||
    deployment.versions[0].version_id !== expectedVersion ||
    deployment.versions[0].percentage !== 100 ||
    version?.id !== expectedVersion ||
    version?.annotations?.['workers/message'] !== `commit:${expectedSha}`
  ) {
    throw new Error('Live 100% Worker version does not match the pinned release');
  }
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Missing live Worker bindings');
  for (const name of ['MCP_RATE_COUNTER', 'WORKSPACE_BOOT_LOG']) {
    if (!bindings.some((b) => b.name === name && b.type === 'durable_object_namespace')) {
      throw new Error(`Missing compatible binding ${name}`);
    }
  }
  const database = bindings.find((b) => b.name === 'DATABASE' && b.type === 'd1')?.id;
  if (!database) throw new Error('Missing primary DATABASE binding');
  const rawWindow = bindings.find((b) => b.name === 'MCP_RATE_LIMIT_WINDOW_SECONDS')?.text;
  // Runtime parsePositiveInt accepts parseInt and defaults for nonpositive/invalid values.
  const parsed = Number.parseInt(rawWindow ?? '', 10);
  const windowSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_SECONDS;
  if (!Number.isSafeInteger(windowSeconds)) throw new Error('Invalid live MCP window');
  return { database, windowSeconds };
}

export function verifyRecord(record, cutover, windowSeconds) {
  if (
    !record ||
    !Number.isSafeInteger(record.publishedAt) ||
    record.publishedAt < 0 ||
    record.rateCutoverAt !== cutover ||
    record.bootLogCutoverAt !== cutover ||
    record.windowSeconds !== windowSeconds ||
    cutover <= record.publishedAt ||
    cutover % windowSeconds !== 0
  )
    throw new Error('Conflicting or invalid immutable activation');
  return record;
}

export async function activateStorage({
  query,
  verifyLive,
  cutover,
  publish,
  now = () => Math.floor(Date.now() / 1000),
}) {
  if (!Number.isSafeInteger(cutover) || cutover < 1) throw new Error('Invalid cutover second');
  const { database, windowSeconds } = await verifyLive();
  if (cutover % windowSeconds !== 0) throw new Error('Cutover must align with the live window');
  const read = async () => {
    const result = await query(database, 'SELECT value FROM platform_settings WHERE key = ?', [
      ACTIVATION_KEY,
    ]);
    const rows = result.results;
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid activation query result');
    return rows.length ? verifyRecord(JSON.parse(rows[0].value), cutover, windowSeconds) : null;
  };
  const existing = await read();
  if (existing) return { outcome: 'existing', record: existing, database, windowSeconds };
  if (cutover <= now()) throw new Error('Unpublished cutover must be in the future');
  if (!publish) return { outcome: 'preflight', record: null, database, windowSeconds, cutover };
  // Recheck immediately before the sole mutation. The workflow holds the deployment lock.
  const checked = await verifyLive();
  if (checked.database !== database || checked.windowSeconds !== windowSeconds)
    throw new Error('Live configuration changed');
  await query(database, INSERT_ACTIVATION, [ACTIVATION_KEY, cutover, windowSeconds]);
  // Even after ambiguous/zero-row publication, only exact immutable readback proves success.
  const record = await read();
  if (!record) throw new Error('Activation publication was not confirmed; inspect before retrying');
  return { outcome: 'published', record, database, windowSeconds };
}

async function main() {
  const env = process.env;
  const environment = env.DEPLOY_ENVIRONMENT;
  if (!['staging', 'production'].includes(environment))
    throw new Error('Invalid deployment environment');
  const stack = environment === 'production' ? 'prod' : 'staging';
  const prefix =
    env.RESOURCE_PREFIX?.trim() ||
    (env.BASE_DOMAIN?.trim()
      ? `s${createHash('sha256').update(env.BASE_DOMAIN.trim()).digest('hex').slice(0, 6)}`
      : null);
  if (!prefix || !env.CF_ACCOUNT_ID || !env.CF_API_TOKEN)
    throw new Error('Existing deployment configuration and credentials required');
  const worker = `${prefix}-api-${stack}`;
  const base = `${API}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    // Never log response bodies: Worker bindings may include sensitive plain_text values.
    if (!response.ok || value.success !== true)
      throw new Error(`Cloudflare operation failed (HTTP ${response.status})`);
    return value.result;
  };
  const verifyEvidence = Boolean(env.VERIFY_WORKSPACE_ID || env.VERIFY_RATE_IDENTITY);
  if (verifyEvidence && env.PUBLISH_ACTIVATION === 'true')
    throw new Error('Evidence verification cannot publish');
  const result = await activateStorage({
    cutover: Number(env.CUTOVER_AT),
    publish: env.PUBLISH_ACTIVATION === 'true',
    verifyLive: async () => {
      const deployments = await api(`/workers/scripts/${encodeURIComponent(worker)}/deployments`);
      const version = await api(
        `/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(env.EXPECTED_VERSION)}`
      );
      return verifyLiveVersion(
        deployments.deployments?.[0],
        version,
        env.EXPECTED_SHA,
        env.EXPECTED_VERSION
      );
    },
    query: async (database, sql, params) => {
      const rows = await api(`/d1/database/${encodeURIComponent(database)}/query`, { sql, params });
      if (
        rows?.length !== 1 ||
        rows[0].success !== true ||
        rows[0].meta?.served_by_primary !== true
      )
        throw new Error('D1 query failed');
      return rows[0];
    },
  });
  let storageEvidence;
  if (verifyEvidence) {
    if (!result.record || result.record.rateCutoverAt > Math.floor(Date.now() / 1000))
      throw new Error('Active immutable record required for evidence');
    storageEvidence = await readStorageEvidence({
      api,
      worker,
      workspaceId: env.VERIFY_WORKSPACE_ID,
      rateIdentity: env.VERIFY_RATE_IDENTITY,
    });
  }
  const evidence = {
    environment,
    worker,
    expectedSha: env.EXPECTED_SHA,
    expectedVersion: env.EXPECTED_VERSION,
    ...result,
    ...(storageEvidence ? { storageEvidence } : {}),
  };
  writeFileSync('reliability-storage-activation.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
