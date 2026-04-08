// =============================================================================
// Agent Types
// =============================================================================

/** Supported agent identifiers */
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'mistral-vibe' | 'opencode';

/** API key provider identifiers */
export type AgentProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'opencode';

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
  /** npm global install command */
  installCommand: string;
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
    installCommand: 'npm install -g @zed-industries/claude-agent-acp',
    oauthSupport: {
      envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
      setupInstructions: 'Generate a token using "claude setup-token" or "claude login" in your terminal',
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
    installCommand: 'npx --yes @zed-industries/codex-acp --version',
    oauthSupport: {
      envVarName: 'CODEX_AUTH_JSON',
      setupInstructions: 'Run "codex login" on your local machine and sign in with your ChatGPT account, then paste the contents of ~/.codex/auth.json',
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
    acpArgs: ['--experimental-acp'],
    supportsAcp: true,
    credentialHelpUrl: 'https://aistudio.google.com/apikey',
    installCommand: 'npm install -g @google/gemini-cli',
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
    installCommand:
      'curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe==2.7.0 --python 3.12 --quiet',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source AI coding agent by SST. Uses Scaleway Generative APIs for inference.',
    provider: 'opencode',
    envVarName: 'SCW_SECRET_KEY',
    acpCommand: 'opencode',
    acpArgs: ['acp'],
    supportsAcp: true,
    credentialHelpUrl: 'https://console.scaleway.com/iam/api-keys',
    installCommand: 'npm install -g opencode-ai@1.4.0',
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
  /** When configured via a cloud provider credential rather than a dedicated agent key */
  fallbackCredentialSource?: 'scaleway-cloud' | null;
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
  label?: string; // e.g., "Pro/Max Subscription" for OAuth
  createdAt: string;
  updatedAt: string;
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
