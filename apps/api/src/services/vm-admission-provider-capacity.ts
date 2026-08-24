import { ProviderError } from '@simple-agent-manager/providers';

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

export function classifyVmProviderCapacityError(err: unknown): VmProviderCapacityInfo | null {
  if (!(err instanceof ProviderError)) return null;
  if (
    err.providerName === 'hetzner' &&
    err.statusCode === 403 &&
    (err.providerCode === 'server_limit_exceeded' ||
      err.message.toLowerCase().includes('server_limit_exceeded') ||
      err.message.toLowerCase().includes('server limit'))
  ) {
    return {
      provider: err.providerName,
      providerCategory: err.category,
      providerCode: err.providerCode ?? 'server_limit_exceeded',
      providerStatusCode: err.statusCode,
      providerMessage: err.message,
    };
  }
  return null;
}

export function isProviderAccountCapacityError(err: unknown): boolean {
  return classifyVmProviderCapacityError(err) !== null;
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
