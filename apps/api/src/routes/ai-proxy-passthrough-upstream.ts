/**
 * Which upstream and credential the AI proxy passthrough forwards a request to,
 * resolved through the same profile context as the agent-key callback
 * (`resolveSessionProfileCredentialContext`), so the proxy uses the account the
 * session was given.
 */
import {
  type AgentCredentialScope,
  type CCResolutionSource,
  type Dialect,
  HARNESS_CAPABILITIES,
  type HarnessCapability,
  PROVIDER_PRESETS,
  resolveHarnessDialect,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { credentialScopeFromSource } from '../services/agent-key-resolution';
import type { AiProviderUsageAttribution } from '../services/ai-token-budget';
import { resolveSessionProfileCredentialContext } from '../services/composable-credentials/profile-context';
import { resolveForConsumer } from '../services/composable-credentials/resolve';

export interface ResolvedProxyUpstream {
  agentType: string;
  dialect: Dialect;
  capability: HarnessCapability;
  apiKey: string;
  baseUrl: string;
  provider: AiProviderUsageAttribution;
  credentialReference: string;
  credentialSource: 'user' | 'project' | 'platform';
  credentialScope: AgentCredentialScope;
  credentialProvider: string;
  providerMode: 'proxy-passthrough';
}

type ResolvedCredentialSecret = NonNullable<
  NonNullable<Awaited<ReturnType<typeof resolveForConsumer>>>['credential']
>['secret'];

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function stringSetting(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function candidateCapabilities(
  agentType: string | null | undefined,
  dialect: Dialect
): HarnessCapability[] {
  if (agentType) {
    const capability = resolveHarnessDialect(agentType, dialect);
    return capability?.proxyRouteSegment ? [capability] : [];
  }
  return HARNESS_CAPABILITIES.filter(
    (capability) => capability.proxyRouteSegment && capability.dialects.includes(dialect)
  );
}

function resolvedBaseUrl(
  secret: ResolvedCredentialSecret,
  settings: Record<string, unknown>
): string | null {
  return (
    stringSetting(settings.baseUrl) ??
    (secret.kind === 'openai-compatible' ? stringSetting(secret.baseUrl) : null)
  );
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  parsed.search = '';
  return trimTrailingSlashes(parsed.toString());
}

function slugFromHost(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  const host = hostname.startsWith('api.') ? hostname.slice(4) : hostname;
  let slug = '';
  let pendingSeparator = false;

  for (let index = 0; index < host.length; index++) {
    const code = host.charCodeAt(index);
    const isAlphaNumeric = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlphaNumeric) {
      if (pendingSeparator && slug.length > 0) slug += '-';
      slug += host.charAt(index);
      pendingSeparator = false;
    } else if (slug.length > 0) {
      pendingSeparator = true;
    }
  }

  return slug || 'custom-provider';
}

function labelFromProviderId(providerId: string): string {
  return (
    providerId
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Custom Provider'
  );
}

function resolveProviderAttribution(input: {
  baseUrl: string;
  dialect: Dialect;
  settings: Record<string, unknown>;
}): AiProviderUsageAttribution {
  const explicitProviderId = stringSetting(input.settings.providerId);
  const explicitProviderName = stringSetting(input.settings.providerName);
  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
  const preset = PROVIDER_PRESETS.find(
    (candidate) =>
      candidate.dialect === input.dialect &&
      normalizeBaseUrl(candidate.baseUrl) === normalizedBaseUrl
  );
  const providerId = explicitProviderId ?? preset?.id ?? slugFromHost(input.baseUrl);
  return {
    providerId,
    providerName: explicitProviderName ?? preset?.label ?? labelFromProviderId(providerId),
    dialect: input.dialect,
  };
}

function credentialApiKey(secret: ResolvedCredentialSecret): string | null {
  switch (secret.kind) {
    case 'api-key':
      return secret.apiKey;
    case 'openai-compatible':
      return secret.apiKey;
    default:
      return null;
  }
}

function credentialSupportsDialect(
  secret: ResolvedCredentialSecret,
  settings: Record<string, unknown>,
  dialect: Dialect
): boolean {
  const configuredDialect = stringSetting(settings.dialect);
  if (configuredDialect) return configuredDialect === dialect;
  return secret.kind === 'openai-compatible' && dialect === 'openai-compatible';
}

/**
 * Who owns the credential. A profile pin is the user's own account. Exhaustive
 * over the resolver's sources so a new source cannot silently become 'platform'.
 */
function credentialSourceFromResolution(
  source: CCResolutionSource
): 'user' | 'project' | 'platform' {
  switch (source) {
    case 'project-attachment':
      return 'project';
    case 'profile-attachment':
    case 'user-attachment':
      return 'user';
    case 'platform':
    case 'platform-proxy':
      return 'platform';
  }
}

export async function resolveProxyUpstream(input: {
  env: Env;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  agentType?: string | null;
  agentSessionId?: string | null;
  dialect: Dialect;
}): Promise<ResolvedProxyUpstream | null> {
  const db = drizzle(input.env.DATABASE, { schema });
  const encryptionKey = getCredentialEncryptionKey(input.env);
  // Same profile context as the agent-key callback that gave this session its key.
  const profile = await resolveSessionProfileCredentialContext(db, {
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
  });
  for (const capability of candidateCapabilities(input.agentType, input.dialect)) {
    const resolved = await resolveForConsumer(
      db,
      input.userId,
      encryptionKey,
      { kind: 'agent', agentType: capability.agentType },
      input.projectId,
      profile
    );
    if (!resolved?.credential || resolved.source === 'platform-proxy') continue;
    const secret = resolved.credential.secret;
    const settings = resolved.configuration?.settings ?? {};
    if (!credentialSupportsDialect(secret, settings, input.dialect)) continue;
    const apiKey = credentialApiKey(secret);
    const baseUrl = resolvedBaseUrl(secret, settings);
    if (!apiKey || !baseUrl || !isHttpsUrl(baseUrl)) continue;
    return {
      agentType: capability.agentType,
      dialect: input.dialect,
      capability,
      apiKey,
      baseUrl,
      provider: resolveProviderAttribution({ baseUrl, dialect: input.dialect, settings }),
      credentialReference: `cc_credentials:${resolved.credential.id}`,
      credentialSource: credentialSourceFromResolution(resolved.source),
      credentialScope: credentialScopeFromSource(resolved.source),
      credentialProvider: input.dialect,
      providerMode: 'proxy-passthrough',
    };
  }
  return null;
}
