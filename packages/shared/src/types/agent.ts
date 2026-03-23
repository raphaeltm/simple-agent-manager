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
}
