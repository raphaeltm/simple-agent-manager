import {
  DEFAULT_CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT,
  DEFAULT_CREDENTIAL_LIMIT_ADMISSION_MAX_ATTEMPTS,
  DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS,
  DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE,
  DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETRY_DELAY_MS,
  DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT,
  DEFAULT_CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT,
  DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS,
  DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS,
  DEFAULT_CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS,
  DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_PROVIDERS,
  DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_SOURCES,
  DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_WINDOW_TYPES,
  DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import type { CredentialLimitRuntimeConfig } from './types';

function parseThreshold(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  return parsed;
}

function parseIntegerEnv(
  value: string | undefined,
  fallback: number,
  input: { min: number; max: number }
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < input.min || parsed > input.max) return fallback;
  return parsed;
}

function parseCsvAllowlist(value: string | undefined, fallback: readonly string[]): ReadonlySet<string> {
  if (value === undefined || value.trim() === '') return new Set(fallback);
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries.length > 0 ? entries : fallback);
}

export function resolveCredentialLimitConfig(env: Env): CredentialLimitRuntimeConfig {
  const warningPercent = parseThreshold(
    env.CREDENTIAL_LIMIT_WARNING_PERCENT,
    DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT
  );
  const criticalPercent = parseThreshold(
    env.CREDENTIAL_LIMIT_CRITICAL_PERCENT,
    DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT
  );

  return {
    warningPercent:
      warningPercent <= criticalPercent ? warningPercent : DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT,
    criticalPercent:
      warningPercent <= criticalPercent ? criticalPercent : DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT,
    maxObservationsPerReport: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT,
      DEFAULT_CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT,
      { min: 1, max: 100 }
    ),
    observationMaxAgeMs: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS,
      DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS,
      { min: 1_000, max: 30 * 24 * 60 * 60_000 }
    ),
    observationFutureSkewMs: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS,
      DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS,
      { min: 0, max: 60 * 60_000 }
    ),
    resetMaxFutureMs: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS,
      DEFAULT_CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS,
      { min: 60_000, max: 30 * 24 * 60 * 60_000 }
    ),
    supportedProviders: parseCsvAllowlist(
      env.CREDENTIAL_LIMIT_SUPPORTED_PROVIDERS,
      DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_PROVIDERS
    ),
    supportedSources: parseCsvAllowlist(
      env.CREDENTIAL_LIMIT_SUPPORTED_SOURCES,
      DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_SOURCES
    ),
    supportedWindowTypes: parseCsvAllowlist(
      env.CREDENTIAL_LIMIT_SUPPORTED_WINDOW_TYPES,
      DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_WINDOW_TYPES
    ),
    admissionMaxActivePerProject: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT,
      DEFAULT_CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT,
      { min: 1, max: 100_000 }
    ),
    admissionRetryBatchSize: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE,
      DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE,
      { min: 1, max: 500 }
    ),
    admissionMaxAttempts: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_ADMISSION_MAX_ATTEMPTS,
      DEFAULT_CREDENTIAL_LIMIT_ADMISSION_MAX_ATTEMPTS,
      { min: 1, max: 100 }
    ),
    admissionRetryDelayMs: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_ADMISSION_RETRY_DELAY_MS,
      DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETRY_DELAY_MS,
      { min: 0, max: 24 * 60 * 60_000 }
    ),
    admissionRetentionDays: parseIntegerEnv(
      env.CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS,
      DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS,
      { min: 1, max: 365 }
    ),
  };
}
