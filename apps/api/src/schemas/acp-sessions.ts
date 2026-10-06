import { DEFAULT_CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT } from '@simple-agent-manager/shared';
import * as v from 'valibot';

const UsageIdentifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(160));
const UsageSourceSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(160));

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
  windowType: UsageIdentifierSchema,
  provider: v.optional(UsageIdentifierSchema),
  source: v.optional(UsageSourceSchema),
  status: v.optional(v.picklist(['allowed', 'allowed_warning', 'rejected', 'unknown'])),
  utilizationPercent: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
  limitAmount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  remainingAmount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  windowMinutes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  resetsAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  observedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  freshnessMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const AcpSessionUsageReportSchema = v.object({
  nodeId: UsageIdentifierSchema,
  agentType: v.optional(UsageIdentifierSchema),
  credentialReference: v.optional(UsageIdentifierSchema),
  credentialSource: v.optional(v.picklist(['user', 'project', 'platform'])),
  credentialGeneration: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  observedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  source: v.optional(UsageSourceSchema),
  rateLimits: v.pipe(
    v.array(AcpSessionUsageLimitObservationSchema),
    v.maxLength(DEFAULT_CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT)
  ),
});

export const AcpSessionForkSchema = v.object({
  contextSummary: v.string(),
});
