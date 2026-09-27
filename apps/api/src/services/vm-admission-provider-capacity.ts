import {
  classifyHetznerAccountLimit,
  type HetznerAccountLimit,
  ProviderError,
} from '@simple-agent-manager/providers';
import type { CredentialSource } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import {
  first,
  getVmAdmissionConfig,
  parseIsoMs,
  toIso,
  truncateDiagnosticMessage,
  type VmAdmissionScope,
  type VmProviderCapacityInfo,
  type VmProviderCapacityRow,
} from './vm-admission-control-types';

export async function activeProviderCapacityCooldown(
  env: Env,
  providerDomainKey: string
): Promise<VmProviderCapacityRow | null> {
  const row = await first<VmProviderCapacityRow>(
    env.DATABASE,
    `
      SELECT provider_domain_key, provider, credential_domain_key, state, reason,
        provider_category, provider_code, provider_status_code, provider_message, retry_at
      FROM vm_provider_capacity_state
      WHERE provider_domain_key = ?
      LIMIT 1
    `,
    [providerDomainKey]
  );
  if (!row || row.state !== 'cooldown') return null;
  const retryMs = parseIsoMs(row.retry_at);
  return retryMs && retryMs > Date.now() ? row : null;
}

/**
 * A provider account quota, recorded as a cooldown on the whole credential domain before the
 * task is parked on `provider_account_capacity` until capacity returns.
 *
 * Every Hetzner account limit qualifies — servers, vCPU cores and anything else
 * `resource_limit_exceeded` covers. A core quota reaches this only after the attempt chain has no
 * smaller offering left to descend to (`node-provisioning-core-quota.ts`); until then a smaller
 * offering may still fit, and a domain-wide cooldown would stall every other task in it.
 */
export function classifyVmProviderCapacityError(err: unknown): VmProviderCapacityInfo | null {
  if (!(err instanceof ProviderError) || !classifyHetznerAccountLimit(err)) return null;
  return {
    provider: err.providerName,
    providerCategory: err.category,
    providerCode: err.providerCode ?? null,
    providerStatusCode: err.statusCode ?? null,
    providerMessage: err.message,
  };
}

/**
 * User-legible text for a provider account quota: which limit, whose account, what the user can
 * do about it, and the provider's own words for operators. Replaces the bare
 * "hetzner API error (403): shared core limit exceeded" that three failed wakes showed on
 * 2026-09-25.
 */
export function describeProviderAccountLimit(input: {
  limit: HetznerAccountLimit;
  providerMessage: string;
  credentialSource?: CredentialSource | null;
}): string {
  const account = accountOwnerPhrase(input.credentialSource);
  const reached =
    input.limit.resource === 'cores'
      ? `${account} has reached its ${input.limit.coreClass ? `${input.limit.coreClass} ` : ''}vCPU core limit, and no smaller server type this compute pool allows fits under it.`
      : input.limit.resource === 'servers'
        ? `${account} has reached its server limit.`
        : `${account} has reached one of its resource limits.`;
  const remedy =
    input.credentialSource === 'platform'
      ? 'Capacity frees up as other machines are released; try again later.'
      : 'Delete unused nodes to free capacity, or raise the limit in the Hetzner Console (Limits).';
  return `${reached} ${remedy} Provider error: ${input.providerMessage}`;
}

function accountOwnerPhrase(credentialSource: CredentialSource | null | undefined): string {
  if (credentialSource === 'platform') return "SAM's shared Hetzner account";
  if (credentialSource === 'project') return "This project's Hetzner account";
  return 'Your Hetzner account';
}

export async function recordVmProviderCapacityFailure(
  env: Env,
  input: {
    scope: VmAdmissionScope;
    error: unknown;
  }
): Promise<VmProviderCapacityInfo | null> {
  const info = classifyVmProviderCapacityError(input.error);
  if (!info) return null;
  const config = getVmAdmissionConfig(env);
  const nowMs = Date.now();
  const now = toIso(nowMs);
  const retryAt = toIso(nowMs + config.providerCooldownMs);
  const providerMessage = truncateDiagnosticMessage(
    info.providerMessage,
    config.diagnosticMessageMaxLength
  );
  await env.DATABASE.prepare(
    `
      INSERT INTO vm_provider_capacity_state (
        provider_domain_key, provider, credential_domain_key, state, reason,
        provider_category, provider_code, provider_status_code, provider_message,
        failure_count, retry_at, last_failure_at, updated_at
      )
      VALUES (?, ?, ?, 'cooldown', 'provider_account_capacity', ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(provider_domain_key) DO UPDATE SET
        state = 'cooldown',
        reason = 'provider_account_capacity',
        provider_category = excluded.provider_category,
        provider_code = excluded.provider_code,
        provider_status_code = excluded.provider_status_code,
        provider_message = excluded.provider_message,
        failure_count = failure_count + 1,
        retry_at = excluded.retry_at,
        last_failure_at = excluded.last_failure_at,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      input.scope.providerDomainKey,
      input.scope.provider,
      input.scope.credentialDomainKey,
      info.providerCategory,
      info.providerCode,
      info.providerStatusCode,
      providerMessage,
      retryAt,
      now,
      now
    )
    .run();
  return { ...info, providerMessage };
}

export async function recordVmProviderCapacitySuccess(
  env: Env,
  scope: VmAdmissionScope
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `
      INSERT INTO vm_provider_capacity_state (
        provider_domain_key, provider, credential_domain_key, state,
        failure_count, last_success_at, updated_at
      )
      VALUES (?, ?, ?, 'ok', 0, ?, ?)
      ON CONFLICT(provider_domain_key) DO UPDATE SET
        state = 'ok',
        reason = NULL,
        retry_at = NULL,
        provider_category = NULL,
        provider_code = NULL,
        provider_status_code = NULL,
        provider_message = NULL,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `
  )
    .bind(scope.providerDomainKey, scope.provider, scope.credentialDomainKey, now, now)
    .run();
}
