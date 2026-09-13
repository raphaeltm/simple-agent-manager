import type { Env } from '../../env';
import { recordCredentialLimitObservationsBestEffort } from './producer';
import type {
  CredentialLimitObservation,
  CredentialLimitStatus,
  ProxyCredentialLimitContext,
} from './types';
import { normalizeCredentialSource, normalizeInteger, normalizeTimestamp } from './values';

export const CREDENTIAL_LIMIT_PROVIDER_HEADERS = [
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-priority-input-tokens-limit',
  'anthropic-ratelimit-priority-input-tokens-remaining',
  'anthropic-ratelimit-priority-input-tokens-reset',
  'anthropic-ratelimit-priority-output-tokens-limit',
  'anthropic-ratelimit-priority-output-tokens-remaining',
  'anthropic-ratelimit-priority-output-tokens-reset',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-project-tokens',
  'x-ratelimit-remaining-project-tokens',
  'x-ratelimit-reset-project-tokens',
] as const;

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  return normalizeInteger(Number(value));
}

function utilizationFromLimitRemaining(
  limit: number | null,
  remaining: number | null
): number | null {
  if (limit === null || remaining === null || limit <= 0 || remaining < 0) return null;
  return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
}

function parseRetryAfter(value: string | null, observedAt: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return observedAt + Math.max(0, Math.trunc(seconds * 1000));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAnthropicReset(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOpenAIReset(headers: Headers, name: string, observedAt: number): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const durationMs = parseOpenAIDurationMs(trimmed);
  if (durationMs !== null) return observedAt + durationMs;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseOpenAIDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?ms$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -2))));
  }
  if (/^\d+(\.\d+)?s$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 1000));
  }
  if (/^\d+(\.\d+)?m$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 60_000));
  }
  if (/^\d+(\.\d+)?h$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 3_600_000));
  }
  let totalMs = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  for (const match of trimmed.matchAll(pattern)) {
    matched = true;
    const amountText = match[1];
    const unitText = match[2];
    if (!amountText || !unitText) return null;
    const amount = Number(amountText);
    const unit = unitText.toLowerCase();
    if (!Number.isFinite(amount)) return null;
    if (unit === 'ms') totalMs += amount;
    if (unit === 's') totalMs += amount * 1000;
    if (unit === 'm') totalMs += amount * 60_000;
    if (unit === 'h') totalMs += amount * 3_600_000;
  }
  return matched ? Math.max(0, Math.trunc(totalMs)) : null;
}

function proxyContextIsRecordable(
  context: ProxyCredentialLimitContext
): context is ProxyCredentialLimitContext & {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: 'user' | 'project' | 'platform';
} {
  return Boolean(
    context.projectId &&
    context.userId &&
    context.credentialReference &&
    normalizeCredentialSource(context.credentialSource ?? null)
  );
}

export function extractCredentialLimitObservationsFromHeaders(
  headers: Headers,
  context: ProxyCredentialLimitContext
): CredentialLimitObservation[] {
  if (!proxyContextIsRecordable(context)) return [];
  const credentialSource = normalizeCredentialSource(context.credentialSource);
  if (!credentialSource) return [];
  const observedAt = normalizeTimestamp(context.observedAt) ?? Date.now();
  const status: CredentialLimitStatus = context.responseStatus === 429 ? 'rejected' : 'unknown';
  const base = {
    projectId: context.projectId,
    userId: context.userId,
    credentialReference: context.credentialReference,
    credentialSource,
    provider: context.provider,
    providerMode: context.providerMode,
    source: context.source,
    observedAt,
    status,
    agentType: context.agentType ?? null,
    workspaceId: context.workspaceId ?? null,
    agentSessionId: context.agentSessionId ?? null,
    chatSessionId: context.chatSessionId ?? null,
    freshnessMs: 0,
  } satisfies Omit<CredentialLimitObservation, 'windowType'>;

  const observations =
    context.provider === 'anthropic'
      ? extractAnthropicObservations(headers, base)
      : extractOpenAIObservations(headers, base);

  if (observations.length === 0 && context.responseStatus === 429) {
    const reset = parseRetryAfter(headers.get('retry-after'), observedAt);
    observations.push({
      ...base,
      status: 'rejected',
      windowType: `${context.provider}.requests`,
      resetsAt: reset,
    });
  }
  return observations;
}

function extractAnthropicObservations(
  headers: Headers,
  base: Omit<CredentialLimitObservation, 'windowType'>
): CredentialLimitObservation[] {
  const groups = [
    'requests',
    'tokens',
    'input-tokens',
    'output-tokens',
    'priority-input-tokens',
    'priority-output-tokens',
  ];
  return groups.flatMap((group) => {
    const limit = parseIntegerHeader(headers, `anthropic-ratelimit-${group}-limit`);
    const remaining = parseIntegerHeader(headers, `anthropic-ratelimit-${group}-remaining`);
    const resetsAt = parseAnthropicReset(headers, `anthropic-ratelimit-${group}-reset`);
    if (limit === null && remaining === null && resetsAt === null) return [];
    return [
      {
        ...base,
        windowType: `anthropic.${group}`,
        utilizationPercent: utilizationFromLimitRemaining(limit, remaining),
        limitAmount: limit,
        remainingAmount: remaining,
        resetsAt,
      },
    ];
  });
}

function extractOpenAIObservations(
  headers: Headers,
  base: Omit<CredentialLimitObservation, 'windowType'>
): CredentialLimitObservation[] {
  const groups = [
    ['requests', 'requests'],
    ['tokens', 'tokens'],
    ['project-tokens', 'project-tokens'],
  ] as const;
  return groups.flatMap(([windowName, headerName]) => {
    const limit = parseIntegerHeader(headers, `x-ratelimit-limit-${headerName}`);
    const remaining = parseIntegerHeader(headers, `x-ratelimit-remaining-${headerName}`);
    const resetsAt = parseOpenAIReset(headers, `x-ratelimit-reset-${headerName}`, base.observedAt);
    if (limit === null && remaining === null && resetsAt === null) return [];
    return [
      {
        ...base,
        windowType: `openai.${windowName}`,
        utilizationPercent: utilizationFromLimitRemaining(limit, remaining),
        limitAmount: limit,
        remainingAmount: remaining,
        resetsAt,
      },
    ];
  });
}

export async function recordProxyCredentialLimitObservationsFromHeaders(
  env: Env,
  headers: Headers,
  context: ProxyCredentialLimitContext
): Promise<void> {
  const observations = extractCredentialLimitObservationsFromHeaders(headers, context);
  await recordCredentialLimitObservationsBestEffort(env, observations, {
    projectId: context.projectId,
    source: context.source,
  });
}

export function copyCredentialLimitHeaders(source: Headers, target: Headers): void {
  for (const name of CREDENTIAL_LIMIT_PROVIDER_HEADERS) {
    const value = source.get(name);
    if (value) target.set(name, value);
  }
}
