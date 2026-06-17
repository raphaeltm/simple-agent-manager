// =============================================================================
// Agent Settings (per-user, per-agent configuration)
// =============================================================================

/**
 * Provider mode for Claude Code / Codex agent sessions.
 * - 'sam': Platform-managed AI proxy, paid/metered by SAM (explicit opt-in).
 * - 'user-api-key': User-owned API key, routed through passthrough proxy.
 * - 'oauth': Direct injection (Claude Code OAuth token, not proxied).
 * - null: No provider selected (agent not configured via this path).
 */
export type AgentProviderMode = 'sam' | 'user-api-key' | 'oauth';

/** Valid provider modes — single source of truth for validation. */
export const VALID_AGENT_PROVIDER_MODES: readonly AgentProviderMode[] = [
  'sam',
  'user-api-key',
  'oauth',
] as const;

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
  | 'opencode-zen'
  | 'opencode-managed'
  | 'google-vertex'
  | 'openai-compatible'
  | 'anthropic'
  | 'custom';

export const DEFAULT_OPENCODE_PROVIDER = 'opencode-zen' as const;
export const OPENCODE_MANAGED_PROVIDER_ALIAS = 'opencode-managed' as const;
export const DEFAULT_OPENCODE_ZEN_MODEL = 'opencode/claude-sonnet-4-6' as const;

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
  'opencode-zen': {
    label: 'OpenCode Zen',
    modelPlaceholder: `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`,
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyLabel: 'OpenCode Zen API Key',
    keyHelpText: 'Create an OpenCode API key for Zen at opencode.ai/auth',
  },
  'opencode-managed': {
    label: 'OpenCode Zen',
    modelPlaceholder: `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`,
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyLabel: 'OpenCode Zen API Key',
    keyHelpText: 'Create an OpenCode API key for Zen at opencode.ai/auth',
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
  'opencode-zen',
  'platform',
  'scaleway',
  'google-vertex',
  'openai-compatible',
  'anthropic',
  'custom',
];

export function resolveOpenCodeProvider(raw: unknown): OpenCodeProvider {
  if (raw === OPENCODE_MANAGED_PROVIDER_ALIAS) return DEFAULT_OPENCODE_PROVIDER;
  if (typeof raw === 'string' && Object.hasOwn(OPENCODE_PROVIDERS, raw)) {
    return raw as OpenCodeProvider;
  }
  return DEFAULT_OPENCODE_PROVIDER;
}

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
  /** Provider mode for Claude Code / Codex. null = not explicitly selected. */
  providerMode: AgentProviderMode | null;
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
  /** Provider mode for Claude Code / Codex. null = clear selection. */
  providerMode?: AgentProviderMode | null;
}

// =============================================================================
// Agent Effort
// =============================================================================

export const AGENT_EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORT_LEVELS)[number];

export const DEFAULT_AGENT_EFFORT: AgentEffort = 'auto';

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === 'string' && (AGENT_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function getSupportedEffortsForAgent(agentType: string): readonly AgentEffort[] {
  switch (agentType) {
    case 'claude-code':
      return AGENT_EFFORT_LEVELS;
    case 'openai-codex':
      return ['auto', 'low', 'medium', 'high', 'xhigh'];
    default:
      return ['auto'];
  }
}

export function isAgentEffortSupported(agentType: string, effort: AgentEffort): boolean {
  return getSupportedEffortsForAgent(agentType).includes(effort);
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
  effort: AgentEffort;
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
  /** SAM platform policy slice for GitHub CLI installation-token scoping. */
  githubCliPolicy: GitHubCliPolicy | null;
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
  effort?: AgentEffort | null;
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
  /** SAM platform policy slice for GitHub CLI installation-token scoping. */
  githubCliPolicy?: GitHubCliPolicy | null;
}

/** Request body for PUT /api/projects/:projectId/agent-profiles/:profileId */
export interface UpdateAgentProfileRequest {
  name?: string;
  description?: string | null;
  agentType?: string;
  model?: string | null;
  effort?: AgentEffort | null;
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
  /** SAM platform policy slice for GitHub CLI installation-token scoping. */
  githubCliPolicy?: GitHubCliPolicy | null;
}

/** Resolved agent profile for task execution */
export interface ResolvedAgentProfile {
  profileId: string | null;
  profileName: string | null;
  agentType: string;
  model: string | null;
  effort: AgentEffort;
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
  /** SAM platform policy slice for GitHub CLI installation-token scoping. */
  githubCliPolicy: GitHubCliPolicy | null;
}

// =============================================================================
// Skills (per-project repeatable-work definitions)
// =============================================================================

export interface AgentSkill extends Omit<AgentProfile, 'effort'> {
  /** null = inherit from the selected/default profile. */
  effort: AgentEffort | null;
  resourceRequirementsJson: string | null;
  defaultProfileId: string | null;
}

export interface CreateSkillRequest extends CreateAgentProfileRequest {
  resourceRequirementsJson?: string | null;
  defaultProfileId?: string | null;
}

export interface UpdateSkillRequest extends UpdateAgentProfileRequest {
  resourceRequirementsJson?: string | null;
  defaultProfileId?: string | null;
}

export interface ResolvedSkillProfile extends ResolvedAgentProfile {
  skillId: string | null;
  skillName: string | null;
  skillHint: string | null;
  resourceRequirementsJson: string | null;
  defaultProfileId: string | null;
}

// =============================================================================
// SAM Platform Policy — GitHub CLI
// =============================================================================

export type GitHubCliPolicyMode = 'inherit' | 'custom';
export type GitHubCliPermissionLevel = 'none' | 'read' | 'write';
export type GitHubCliContentsPermissionLevel = 'read' | 'write';

export interface GitHubCliPolicyPermissions {
  /** Required for clone/fetch/push. Kept at read/write because disabling contents breaks workspace boot. */
  contents: GitHubCliContentsPermissionLevel;
  pullRequests: GitHubCliPermissionLevel;
  issues: GitHubCliPermissionLevel;
  actions: GitHubCliPermissionLevel;
  packages: GitHubCliPermissionLevel;
}

export interface GitHubCliPolicy {
  mode: GitHubCliPolicyMode;
  repositoryScope: 'project';
  permissions: GitHubCliPolicyPermissions;
}

export const GITHUB_CLI_POLICY_PERMISSION_KEYS = [
  'contents',
  'pullRequests',
  'issues',
  'actions',
  'packages',
] as const;

export const DEFAULT_GITHUB_CLI_POLICY: GitHubCliPolicy = {
  mode: 'inherit',
  repositoryScope: 'project',
  permissions: {
    contents: 'write',
    pullRequests: 'write',
    issues: 'write',
    actions: 'none',
    packages: 'write',
  },
};
