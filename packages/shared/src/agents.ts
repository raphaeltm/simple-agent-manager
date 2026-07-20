import type { CredentialValidationStatus } from './types/user';

// =============================================================================
// Agent Types
// =============================================================================

/** Supported agent identifiers */
export const AGENT_TYPE_VALUES = [
  'claude-code',
  'openai-codex',
  'google-gemini',
  'mistral-vibe',
  'opencode',
  'amp',
] as const;

export type AgentType = (typeof AGENT_TYPE_VALUES)[number];

/** API key provider identifiers */
export const AGENT_PROVIDER_VALUES = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'opencode',
  'amp',
] as const;

export type AgentProvider = (typeof AGENT_PROVIDER_VALUES)[number];

// =============================================================================
// Agent Definition (Configuration Registry)
// =============================================================================

/** Static agent definition — lives in code, not in the database */
export interface AgentDefinition {
  /** Unique identifier */
  id: AgentType;
  /** Display name */
  name: string;
  /** Short description for UI */
  description: string;
  /** API key provider */
  provider: AgentProvider;
  /** Environment variable name for the API key */
  envVarName: string;
  /** ACP binary command */
  acpCommand: string;
  /** Additional CLI args for ACP mode */
  acpArgs: string[];
  /** Whether this agent supports the ACP protocol */
  supportsAcp: boolean;
  /** URL where users can obtain an API key */
  credentialHelpUrl: string;
  /** Cloud provider whose credential can be used as a fallback when no dedicated agent key exists */
  fallbackCloudProvider?: string;
  /** OAuth-specific metadata */
  oauthSupport?: {
    /** Environment variable name for OAuth token */
    envVarName: string;
    /** Help text for obtaining OAuth token */
    setupInstructions: string;
    /** URL for OAuth subscription info */
    subscriptionUrl: string;
  };
}

// =============================================================================
// Agent Catalog
// =============================================================================

/** All supported agents and their configuration */
export const AGENT_CATALOG: readonly AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's AI coding agent",
    provider: 'anthropic',
    envVarName: 'ANTHROPIC_API_KEY',
    acpCommand: 'claude-agent-acp',
    acpArgs: [],
    supportsAcp: true,
    credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
    oauthSupport: {
      envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
      setupInstructions:
        'Generate a token using "claude setup-token" or "claude login" in your terminal',
      subscriptionUrl: 'https://claude.ai/settings/plan',
    },
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: "OpenAI's AI coding agent",
    provider: 'openai',
    envVarName: 'OPENAI_API_KEY',
    acpCommand: 'codex-acp',
    acpArgs: [],
    supportsAcp: true,
    credentialHelpUrl: 'https://platform.openai.com/api-keys',
    oauthSupport: {
      envVarName: 'CODEX_AUTH_JSON',
      setupInstructions:
        'Run "codex login" on your local machine and sign in with your ChatGPT account, then paste the contents of ~/.codex/auth.json',
      subscriptionUrl: 'https://openai.com/chatgpt/pricing/',
    },
  },
  {
    id: 'google-gemini',
    name: 'Gemini CLI',
    description: "Google's AI coding agent",
    provider: 'google',
    envVarName: 'GEMINI_API_KEY',
    acpCommand: 'gemini',
    acpArgs: ['--acp'],
    supportsAcp: true,
    credentialHelpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral AI's coding agent",
    provider: 'mistral',
    envVarName: 'MISTRAL_API_KEY',
    acpCommand: 'vibe-acp',
    acpArgs: [],
    supportsAcp: true,
    credentialHelpUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source AI coding agent by SST. Uses OpenCode managed inference.',
    provider: 'opencode',
    envVarName: 'OPENCODE_API_KEY',
    acpCommand: 'opencode',
    acpArgs: ['acp'],
    supportsAcp: true,
    credentialHelpUrl: 'https://opencode.ai/auth',
  },
  {
    id: 'amp',
    name: 'Amp',
    description: "Sourcegraph's managed AI coding agent",
    provider: 'amp',
    envVarName: 'AMP_API_KEY',
    acpCommand: 'acp-amp',
    acpArgs: ['run'],
    supportsAcp: true,
    credentialHelpUrl: 'https://ampcode.com/settings',
  },
] as const;

/** Look up an agent definition by ID */
export function getAgentDefinition(agentType: AgentType): AgentDefinition | undefined {
  return AGENT_CATALOG.find((a) => a.id === agentType);
}

/** Validate that a string is a valid agent type */
export function isValidAgentType(value: string): value is AgentType {
  return AGENT_CATALOG.some((a) => a.id === value);
}

// =============================================================================
// Agent API Response Types (for API contracts)
// =============================================================================

/** Agent info returned by GET /api/agents */
export interface AgentInfo {
  id: AgentType;
  name: string;
  description: string;
  supportsAcp: boolean;
  configured: boolean;
  credentialHelpUrl: string;
  /** When configured through a fallback path rather than a dedicated agent key */
  fallbackCredentialSource: 'platform-sam' | null;
}

/** Credential kinds supported by agents */
export type CredentialKind = 'api-key' | 'oauth-token';

/** Agent credential info returned by GET /api/credentials/agent */
export interface AgentCredentialInfo {
  agentType: AgentType;
  provider: AgentProvider;
  credentialKind: CredentialKind;
  isActive: boolean;
  maskedKey: string;
  validation?: CredentialValidationStatus;
  label?: string; // e.g., "Pro/Max Subscription" for OAuth
  createdAt: string;
  updatedAt: string;
  /**
   * Credential scope:
   * - "user" — applies to all of this user's workspaces (default, legacy behavior)
   * - "project" — scoped to a specific project, overrides the user credential for that project
   */
  scope?: 'user' | 'project';
  /** Project ID when scope === 'project'. Undefined for user-scoped credentials. */
  projectId?: string;
}

/** Request body for PUT /api/credentials/agent */
export interface SaveAgentCredentialRequest {
  agentType: AgentType;
  credentialKind: CredentialKind;
  credential: string; // Can be API key or OAuth token
  autoActivate?: boolean; // Default true
}

/** Response from /api/workspaces/:id/agent-key endpoint */
export interface AgentKeyResponse {
  apiKey: string; // Decrypted credential (API key or OAuth token)
  credentialKind: CredentialKind; // Type for proper env var injection
}
