import * as v from 'valibot';

export const CreateAcpSessionSchema = v.object({
  taskId: v.optional(v.string()),
  agentType: v.optional(v.string()),
  agentProfileId: v.optional(v.string()),
  initialPrompt: v.optional(v.string()),
  parentSessionId: v.optional(v.string()),
  contextSummary: v.optional(v.string()),
  chatSessionId: v.optional(v.string()),
});

export const AcpSessionAssignSchema = v.object({
  workspaceId: v.string(),
  nodeId: v.string(),
});

export const AcpSessionStatusReportSchema = v.object({
  status: v.picklist(['running', 'completed', 'failed']),
  acpSdkSessionId: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  nodeId: v.string(),
});

export const AcpSessionHeartbeatSchema = v.object({
  nodeId: v.string(),
  acpSdkSessionId: v.optional(v.string()),
});

export const AcpSessionForkSchema = v.object({
  contextSummary: v.string(),
});
