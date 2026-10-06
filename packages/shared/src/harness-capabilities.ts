/** API wire dialect a harness speaks to its model backend. */
export type Dialect = 'anthropic' | 'openai-compatible' | 'gemini' | 'native';

/** How the harness expects its credential to be presented. */
export type AuthStyle = 'api-key' | 'bearer-token' | 'auth-json';

export interface HarnessCapability {
  /** Agent type id (matches AGENT_CATALOG ids). */
  agentType: string;
  /** Dialects this harness can speak. First entry is the preferred/native one. */
  dialects: Dialect[];
  /** Env var the harness reads its model base URL from (undefined = not overridable). */
  baseUrlEnvVar?: string;
  /** Env var the harness reads its credential from. */
  authEnvVar: string;
  /** Whether the auth value is a bearer token or a raw key (affects header build). */
  authStyle: AuthStyle;
  /** Does this harness consume an opencode-style provider config JSON instead of env? */
  usesOpencodeConfig?: boolean;
  /** Proxy route segment under /ai/proxy/{wstoken}/ for this dialect. */
  proxyRouteSegment: string;
  /** inferenceConfig.provider tag the VM agent switches on. */
  proxyProviderTag: string;
}

export const DIALECT_VALUES = ['anthropic', 'openai-compatible', 'gemini', 'native'] as const;

export const AUTH_STYLE_VALUES = ['api-key', 'bearer-token', 'auth-json'] as const;

/**
 * Harness capability registry derived from the current assembler, runtime proxy,
 * and vm-agent env-injection behavior.
 */
export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  {
    agentType: 'claude-code',
    dialects: ['anthropic'],
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    authEnvVar: 'ANTHROPIC_API_KEY',
    authStyle: 'api-key',
    proxyRouteSegment: 'anthropic',
    proxyProviderTag: 'anthropic-passthrough',
  },
  {
    agentType: 'openai-codex',
    dialects: ['openai-compatible'],
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    authEnvVar: 'OPENAI_API_KEY',
    authStyle: 'api-key',
    proxyRouteSegment: 'openai/v1',
    proxyProviderTag: 'openai-passthrough',
  },
  {
    agentType: 'google-gemini',
    dialects: ['gemini'],
    authEnvVar: 'GEMINI_API_KEY',
    authStyle: 'api-key',
    proxyRouteSegment: '',
    proxyProviderTag: '',
  },
  {
    agentType: 'mistral-vibe',
    dialects: ['native'],
    authEnvVar: 'MISTRAL_API_KEY',
    authStyle: 'api-key',
    proxyRouteSegment: '',
    proxyProviderTag: '',
  },
  {
    agentType: 'opencode',
    dialects: ['openai-compatible'],
    authEnvVar: 'OPENCODE_API_KEY',
    authStyle: 'api-key',
    usesOpencodeConfig: true,
    proxyRouteSegment: 'openai/v1',
    proxyProviderTag: 'openai-passthrough',
  },
  {
    agentType: 'amp',
    dialects: ['native'],
    authEnvVar: 'AMP_API_KEY',
    authStyle: 'api-key',
    proxyRouteSegment: '',
    proxyProviderTag: '',
  },
] as const;

/** Given a harness + a provider preset's dialect, return the descriptor slice
 *  to use, or null if the harness cannot speak that dialect. */
export function resolveHarnessDialect(
  agentType: string,
  providerDialect: Dialect
): HarnessCapability | null {
  const capability = HARNESS_CAPABILITIES.find((entry) => entry.agentType === agentType);
  if (!capability?.dialects.includes(providerDialect)) return null;
  return capability;
}
