/**
 * Which Google APIs a connected GCP credential can use, and why not.
 *
 * Two sources feed the answer shown on the credential:
 * - What Google reported: a Cloud Billing call refused with `SERVICE_DISABLED` (API off) or an
 *   IAM denial. Recorded in KV per credential when the price refresh or a user's "Check again"
 *   sees it, and cleared when a call succeeds.
 * - What SAM's setup enabled: Workload Identity credentials record `enabledApis`; an API in
 *   `GCP_REQUIRED_APIS` that setup never enabled is flagged until a call to it succeeds.
 *
 * These are owner-fixable states of the user's own Google project, not SAM faults, so they are
 * shown to the owner rather than raised to operators (`.claude/rules/72`).
 */
import {
  googleErrorInfoOf,
  probeGcpBillingAccess,
  ProviderError,
} from '@simple-agent-manager/providers';
import {
  GCP_APIS_ENABLED_BEFORE_TRACKING,
  GCP_CLOUD_BILLING_SERVICE,
  GCP_PRICE_CATALOG_SCOPE,
  GCP_REQUIRED_APIS,
  GCP_SERVICE_NAME_PATTERN,
  type GcpApiIssue,
  gcpApiLabel,
  type GcpCredential,
  type GcpCredentialMetadata,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings-resolution';
import { createGcpTokenProvider, type GcpTokenOwner } from './gcp-token-provider';
import { toGcpCredentialMetadata } from './provider-credential-codecs';

export const GCP_API_HEALTH_KV_PREFIX = 'gcp-api-health:v1:';

/** An owner-fixable reason Google refused a call. */
export type ObservedGcpApiReason = 'api_disabled' | 'permission_denied';

export interface ObservedGcpApiIssue {
  service: string;
  reason: ObservedGcpApiReason;
  observedAt: string;
}

interface StoredGcpApiHealth {
  issues: ObservedGcpApiIssue[];
  /** Services a call has succeeded against, so setup drift no longer flags them. */
  confirmed: string[];
}

/** IAM refusals the project owner fixes with a grant; anything else is not theirs to fix. */
const OWNER_FIXABLE_DENIALS = new Set(['IAM_PERMISSION_DENIED', 'USER_PROJECT_DENIED']);

/**
 * Classify a failed call to `service` as owner-fixable, or null when it is a genuine fault that
 * operators should hear about. Only Google's structured `ErrorInfo.reason` decides: a 403 without
 * one, or with a reason such as `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (SAM asked for the wrong scope),
 * stays a fault rather than being guessed into the owner's lap.
 */
export function classifyGcpApiError(
  error: unknown,
  service: string
): { service: string; reason: ObservedGcpApiReason } | null {
  if (!(error instanceof ProviderError) || error.providerName !== 'gcp') return null;
  const info = googleErrorInfoOf(error);
  if (!info) return null;
  if (info.reason === 'SERVICE_DISABLED') {
    const reported = info.service && GCP_SERVICE_NAME_PATTERN.test(info.service) ? info.service : null;
    return { service: reported ?? service, reason: 'api_disabled' };
  }
  if (OWNER_FIXABLE_DENIALS.has(info.reason)) return { service, reason: 'permission_denied' };
  return null;
}

/**
 * Structured fields of a provider error that are safe to log: no message text, which can echo
 * request details. Empty for other errors.
 */
export function safeProviderErrorFields(error: unknown): Record<string, string | number> {
  if (!(error instanceof ProviderError)) return {};
  const info = googleErrorInfoOf(error);
  const fields: Record<string, string | number> = { category: error.category };
  if (error.statusCode !== undefined) fields.statusCode = error.statusCode;
  if (error.providerCode) fields.providerCode = error.providerCode;
  if (info) {
    fields.googleReason = info.reason;
    if (info.service) fields.googleService = info.service;
  }
  return fields;
}

function healthKey(credentialId: string): string {
  return `${GCP_API_HEALTH_KV_PREFIX}${credentialId}`;
}

async function readStored(env: Env, credentialId: string): Promise<StoredGcpApiHealth> {
  const raw = await env.KV.get(healthKey(credentialId), 'json');
  const empty: StoredGcpApiHealth = { issues: [], confirmed: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const record = raw as Record<string, unknown>;
  const issues = Array.isArray(record.issues)
    ? record.issues.filter(
        (issue): issue is ObservedGcpApiIssue =>
          !!issue &&
          typeof issue === 'object' &&
          typeof issue.service === 'string' &&
          (issue.reason === 'api_disabled' || issue.reason === 'permission_denied') &&
          typeof issue.observedAt === 'string' &&
          !Number.isNaN(Date.parse(issue.observedAt))
      )
    : [];
  const confirmed = Array.isArray(record.confirmed)
    ? record.confirmed.filter((service): service is string => typeof service === 'string')
    : [];
  return { issues, confirmed };
}

async function writeStored(env: Env, credentialId: string, health: StoredGcpApiHealth) {
  if (health.issues.length === 0 && health.confirmed.length === 0) {
    await env.KV.delete(healthKey(credentialId));
    return;
  }
  await env.KV.put(healthKey(credentialId), JSON.stringify(health));
}

/** Record that Google refused `issue.service` for this credential. */
export async function recordGcpApiIssue(
  env: Env,
  credentialId: string,
  issue: { service: string; reason: ObservedGcpApiReason },
  now: Date
): Promise<void> {
  const health = await readStored(env, credentialId);
  await writeStored(env, credentialId, {
    issues: [
      ...health.issues.filter((existing) => existing.service !== issue.service),
      { ...issue, observedAt: now.toISOString() },
    ],
    confirmed: health.confirmed.filter((service) => service !== issue.service),
  });
}

/** Record that a call to `service` succeeded for this credential. */
export async function confirmGcpApi(env: Env, credentialId: string, service: string) {
  const health = await readStored(env, credentialId);
  const alreadyConfirmed = health.confirmed.includes(service);
  const issues = health.issues.filter((issue) => issue.service !== service);
  if (alreadyConfirmed && issues.length === health.issues.length) return;
  await writeStored(env, credentialId, {
    issues,
    confirmed: alreadyConfirmed ? health.confirmed : [...health.confirmed, service],
  });
}

/** Forget everything recorded for a credential that was deleted or replaced. */
export async function deleteGcpApiHealth(env: Env, credentialId: string): Promise<void> {
  await env.KV.delete(healthKey(credentialId));
}

/**
 * The API issues to show on a credential: Google's reports younger than
 * `gcpCatalog.apiIssueTtlMinutes`, then required APIs that SAM's Workload Identity setup never
 * enabled and no call has since confirmed. Service-account-key credentials are set up by hand, so
 * only Google's reports apply to them.
 */
export async function listGcpApiIssues(
  env: Env,
  credentialId: string,
  credential: GcpCredential,
  now = new Date()
): Promise<GcpApiIssue[]> {
  const ttlMs = Number(await resolveAdminSetting(env, 'gcpCatalog.apiIssueTtlMinutes')) * 60_000;
  const health = await readStored(env, credentialId);
  const issues: GcpApiIssue[] = health.issues
    .filter((issue) => Date.parse(issue.observedAt) + ttlMs > now.getTime())
    .map((issue) => ({
      service: issue.service,
      label: gcpApiLabel(issue.service),
      reason: issue.reason,
      observedAt: issue.observedAt,
    }));

  if (credential.authType === 'workload-identity') {
    const enabled = new Set(credential.enabledApis ?? GCP_APIS_ENABLED_BEFORE_TRACKING);
    for (const api of GCP_REQUIRED_APIS) {
      if (enabled.has(api.service) || health.confirmed.includes(api.service)) continue;
      if (issues.some((issue) => issue.service === api.service)) continue;
      issues.push({ service: api.service, label: api.label, reason: 'not_enabled_by_setup' });
    }
  }
  return issues;
}

/**
 * `listGcpApiIssues` for a response path: a KV or settings failure must not fail the request
 * that merely displays the credential, so it degrades to "no known issues" and logs.
 */
export async function listGcpApiIssuesSafely(
  env: Env,
  credentialId: string,
  credential: GcpCredential
): Promise<GcpApiIssue[]> {
  try {
    return await listGcpApiIssues(env, credentialId, credential);
  } catch (error) {
    log.warn('gcp_api_health.read_failed', {
      credentialId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

/** The browser-safe credential projection plus its API issues, as every credential response sends it. */
export async function toGcpCredentialMetadataWithApiIssues(
  env: Env,
  credentialId: string,
  credential: GcpCredential
): Promise<GcpCredentialMetadata> {
  return {
    ...toGcpCredentialMetadata(credential),
    apiIssues: await listGcpApiIssuesSafely(env, credentialId, credential),
  };
}

export type GcpCloudBillingProbeResult = 'ok' | 'owner_fixable' | 'fault';

/**
 * Check right now whether a credential can read the Cloud Billing Catalog, and record the answer
 * the same way the price refresh does. Backs the owner's "Check again" after they enable the API.
 * One token exchange and one single-SKU request, bounded by `gcpCatalog.priceRequestTimeoutMs`.
 */
export async function probeGcpCloudBilling(
  env: Env,
  credentialId: string,
  credential: GcpCredential,
  owner: GcpTokenOwner,
  now = new Date()
): Promise<GcpCloudBillingProbeResult> {
  const requestTimeoutMs = Number(
    await resolveAdminSetting(env, 'gcpCatalog.priceRequestTimeoutMs')
  );
  try {
    const token = await createGcpTokenProvider(credential, owner, env, {
      scopes: [GCP_PRICE_CATALOG_SCOPE],
    })();
    await probeGcpBillingAccess(token, { requestTimeoutMs });
    await confirmGcpApi(env, credentialId, GCP_CLOUD_BILLING_SERVICE);
    return 'ok';
  } catch (error) {
    const ownerFixable = classifyGcpApiError(error, GCP_CLOUD_BILLING_SERVICE);
    if (ownerFixable) await recordGcpApiIssue(env, credentialId, ownerFixable, now);
    log.warn('gcp_api_health.cloud_billing_probe_failed', {
      credentialId,
      ownerFixable: ownerFixable?.reason ?? null,
      errorName: error instanceof Error ? error.name : 'unknown',
      ...safeProviderErrorFields(error),
    });
    return ownerFixable ? 'owner_fixable' : 'fault';
  }
}
