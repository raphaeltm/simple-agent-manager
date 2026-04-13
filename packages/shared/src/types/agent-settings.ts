// =============================================================================
// Agent Settings (per-user, per-agent configuration)
// =============================================================================

/** Valid permission modes for agent sessions */
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

/** Valid OpenCode inference provider types */
export type OpenCodeProvider =
  | 'platform'
  | 'scaleway'
  | 'google-vertex'
  | 'openai-compatible'
  | 'anthropic'
  | 'custom';

/** Metadata for an OpenCode provider option */
export interface OpenCodeProviderMeta {
  label: string;
  modelPlaceholder: string;
  /** Whether a base URL field is required for this provider */
  requiresBaseUrl: boolean;
  /** Whether an API key is required (false for platform) */
  requiresApiKey: boolean;
  /** Label for the API key field */
  keyLabel: string;
  /** Help text for the credential form */
  keyHelpText: string;
}

/** Provider metadata registry — used by both UI and validation */
export const OPENCODE_PROVIDERS: Record<OpenCodeProvider, OpenCodeProviderMeta> = {
  platform: {
    label: 'SAM Platform (Workers AI)',
    modelPlaceholder: 'e.g. @cf/qwen/qwen3-30b-a3b-fp8',
    requiresBaseUrl: false,
    requiresApiKey: false,
    keyLabel: '',
    keyHelpText: "Using SAM's platform AI — daily limit applies",
  },
  scaleway: {
    label: 'Scaleway',
    modelPlaceholder: 'e.g. scaleway/qwen3-coder-30b-a3b-instruct',
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyLabel: 'Scaleway Secret Key',
    keyHelpText: 'Create a Scaleway API key with GenerativeApisModelAccess permission',
  },
  'google-vertex': {
    label: 'Google Vertex',
    modelPlaceholder: 'e.g. gemini-2.5-pro',
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyLabel: 'Google Cloud API Key',
    keyHelpText: 'Enter your Google Cloud API key for Vertex AI',
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    modelPlaceholder: 'e.g. your-model-name',
    requiresBaseUrl: true,
    requiresApiKey: true,
    keyLabel: 'API Key',
    keyHelpText: 'Enter your API key for the OpenAI-compatible endpoint',
  },
  anthropic: {
    label: 'Anthropic',
    modelPlaceholder: 'e.g. claude-sonnet-4-5-20250514',
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyLabel: 'Anthropic API Key',
    keyHelpText: 'Enter your Anthropic API key',
  },
  custom: {
    label: 'Custom',
    modelPlaceholder: 'e.g. your-model-name',
    requiresBaseUrl: true,
    requiresApiKey: true,
    keyLabel: 'API Key',
    keyHelpText: 'Enter your API key for the custom provider',
  },
};

/** Ordered list of OpenCode provider values for dropdown rendering */
export const OPENCODE_PROVIDER_OPTIONS: OpenCodeProvider[] = [
  'platform',
  'scaleway',
  'google-vertex',
  'openai-compatible',
  'anthropic',
  'custom',
];

/** Agent settings stored per-user, per-agent in D1 */
export interface AgentSettings {
  id: string;
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

/** API response for GET /api/agent-settings/:agentType */
export interface AgentSettingsResponse {
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  /** OpenCode inference provider. null = use default. */
  opencodeProvider: OpenCodeProvider | null;
  /** Base URL for custom/openai-compatible providers. */
  opencodeBaseUrl: string | null;
  /** Display name for custom providers. */
  opencodeProviderName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Request body for PUT /api/agent-settings/:agentType */
export interface SaveAgentSettingsRequest {
  model?: string | null;
  permissionMode?: AgentPermissionMode | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  additionalEnv?: Record<string, string> | null;
  /** OpenCode inference provider. null = use default. */
  opencodeProvider?: OpenCodeProvider | null;
  /** Base URL for custom/openai-compatible providers. */
  opencodeBaseUrl?: string | null;
  /** Display name for custom providers. */
  opencodeProviderName?: string | null;
}

// =============================================================================
// Agent Profiles (per-project role definitions)
// =============================================================================

/** Agent profile — a reusable, project-scoped agent configuration for task roles */
export interface AgentProfile {
  id: string;
  projectId: string | null;
  userId: string;
  name: string;
  description: string | null;
  agentType: string;
  model: string | null;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  maxTurns: number | null;
  timeoutMinutes: number | null;
  vmSizeOverride: string | null;
  provider: string | null;
  vmLocation: string | null;
  workspaceProfile: string | null;
  /** Devcontainer config name (subdirectory under .devcontainer/). null = auto-discover default. */
  devcontainerConfigName: string | null;
  taskMode: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /api/projects/:projectId/agent-profiles */
export interface CreateAgentProfileRequest {
  name: string;
  description?: string | null;
  agentType?: string;
  model?: string | null;
  permissionMode?: string | null;
  systemPromptAppend?: string | null;
  maxTurns?: number | null;
  timeoutMinutes?: number | null;
  vmSizeOverride?: string | null;
  provider?: string | null;
  vmLocation?: string | null;
  workspaceProfile?: string | null;
  /** Devcontainer config name (subdirectory under .devcontainer/). null = auto-discover default. */
  devcontainerConfigName?: string | null;
  taskMode?: string | null;
}

/** Request body for PUT /api/projects/:projectId/agent-profiles/:profileId */
export interface UpdateAgentProfileRequest {
  name?: string;
  description?: string | null;
  agentType?: string;
  model?: string | null;
  permissionMode?: string | null;
  systemPromptAppend?: string | null;
  maxTurns?: number | null;
  timeoutMinutes?: number | null;
  vmSizeOverride?: string | null;
  provider?: string | null;
  vmLocation?: string | null;
  workspaceProfile?: string | null;
  /** Devcontainer config name (subdirectory under .devcontainer/). null = auto-discover default. */
  devcontainerConfigName?: string | null;
  taskMode?: string | null;
}

/** Resolved agent profile for task execution */
export interface ResolvedAgentProfile {
  profileId: string | null;
  profileName: string | null;
  agentType: string;
  model: string | null;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  maxTurns: number | null;
  timeoutMinutes: number | null;
  vmSizeOverride: string | null;
  provider: string | null;
  vmLocation: string | null;
  workspaceProfile: string | null;
  /** Devcontainer config name (subdirectory under .devcontainer/). null = auto-discover default. */
  devcontainerConfigName: string | null;
  taskMode: string | null;
}
