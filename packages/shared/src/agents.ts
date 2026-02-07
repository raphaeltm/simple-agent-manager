// =============================================================================
// Agent Types
// =============================================================================

/** Supported agent identifiers */
export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini';

/** API key provider identifiers */
export type AgentProvider = 'anthropic' | 'openai' | 'google';

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
    acpCommand: 'claude-code-acp',
    acpArgs: [],
    supportsAcp: true,
    credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
    installCommand: 'npm install -g @zed-industries/claude-code-acp',
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
}

/** Agent credential info returned by GET /api/credentials/agent */
export interface AgentCredentialInfo {
  agentType: AgentType;
  provider: AgentProvider;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body for PUT /api/credentials/agent */
export interface SaveAgentCredentialRequest {
  agentType: AgentType;
  apiKey: string;
}
