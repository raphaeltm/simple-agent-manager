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

export const AcpSessionActivityReportSchema = v.object({
  activity: v.picklist(['prompting', 'idle', 'recovering', 'error']),
  nodeId: v.string(),
  promptStartedAt: v.optional(v.number()),
  agentType: v.optional(v.string()),
  restartCount: v.optional(v.number()),
  statusError: v.optional(v.nullable(v.string())),
  runtimeWorkState: v.optional(v.picklist(['inactive', 'active', 'settling'])),
  runtimeWorkCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  runtimeWorkSource: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(64),
      v.regex(/^[a-z0-9_-]+$/i, 'runtimeWorkSource must be a safe adapter identifier')
    )
  ),
  runtimeWorkProgressAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const AcpSessionUsageLimitObservationSchema = v.object({
  windowType: v.string(),
  provider: v.optional(v.string()),
  source: v.optional(v.string()),
  status: v.optional(v.picklist(['allowed', 'allowed_warning', 'rejected', 'unknown'])),
  utilizationPercent: v.optional(v.number()),
  limitAmount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  remainingAmount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  windowMinutes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  resetsAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  observedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  freshnessMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const AcpSessionUsageReportSchema = v.object({
  nodeId: v.string(),
  agentType: v.optional(v.string()),
  credentialReference: v.optional(v.string()),
  credentialSource: v.optional(v.picklist(['user', 'project', 'platform'])),
  observedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  source: v.optional(v.string()),
  rateLimits: v.array(AcpSessionUsageLimitObservationSchema),
});

export const AcpSessionForkSchema = v.object({
  contextSummary: v.string(),
});
