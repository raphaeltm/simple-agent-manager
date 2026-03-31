import * as v from 'valibot';

// Terminal
export const TerminalRequestSchema = v.object({
  workspaceId: v.string(),
});

// Smoke test tokens
export const SmokeTestCreateSchema = v.object({
  name: v.optional(v.string()),
});

export const SmokeTestRedeemSchema = v.object({
  token: v.optional(v.string()),
});

// Cached commands
const CachedCommandSchema = v.object({
  name: v.string(),
  description: v.string(),
});

export const SaveCachedCommandsSchema = v.object({
  agentType: v.string(),
  commands: v.array(CachedCommandSchema),
});

// TTS
export const TtsRequestSchema = v.object({
  text: v.optional(v.string()),
  storageId: v.optional(v.string()),
  mode: v.optional(v.picklist(['full', 'summary'])),
});

// Chat
export const CreateChatSessionSchema = v.object({
  workspaceId: v.optional(v.string()),
  topic: v.optional(v.string()),
});

export const SendChatMessageSchema = v.object({
  content: v.optional(v.string()),
});

export const LinkTaskToChatSchema = v.object({
  taskId: v.optional(v.string()),
  context: v.optional(v.string()),
});

// GCP
export const GcpOAuthHandleSchema = v.object({
  oauthHandle: v.string(),
});

export const GcpSetupSchema = v.object({
  oauthHandle: v.string(),
  gcpProjectId: v.string(),
  defaultZone: v.string(),
});

// Project deployment
export const ProjectDeploymentSetupSchema = v.object({
  oauthHandle: v.string(),
  gcpProjectId: v.string(),
});

// Client errors
const ClientErrorEntrySchema = v.object({
  message: v.string(),
  stack: v.optional(v.string()),
  source: v.optional(v.string()),
  componentStack: v.optional(v.string()),
  url: v.optional(v.string()),
  userAgent: v.optional(v.string()),
  timestamp: v.optional(v.string()),
});

export const ClientErrorBatchSchema = v.object({
  errors: v.array(ClientErrorEntrySchema),
});

// Node heartbeat
const NodeMetricsSchema = v.object({
  cpuLoadAvg1: v.optional(v.number()),
  memoryPercent: v.optional(v.number()),
  diskPercent: v.optional(v.number()),
});

export const NodeHeartbeatSchema = v.object({
  activeWorkspaces: v.optional(v.number()),
  nodeId: v.optional(v.string()),
  metrics: v.optional(NodeMetricsSchema),
});

// Node error report
const NodeErrorEntrySchema = v.object({
  message: v.string(),
  severity: v.optional(v.string()),
  source: v.optional(v.string()),
  stack: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
});

export const NodeErrorBatchSchema = v.object({
  errors: v.array(NodeErrorEntrySchema),
});

// Admin analytics forward
export const AdminAnalyticsQuerySchema = v.object({
  timeRange: v.object({
    start: v.string(),
    end: v.string(),
  }),
  dataset: v.optional(v.string()),
  sql: v.optional(v.string()),
  limit: v.optional(v.number()),
});

// UI Governance schemas (replacing manual validators)
export const UIStandardUpsertSchema = v.object({
  status: v.picklist(['draft', 'review', 'active', 'deprecated']),
  name: v.string(),
  visualDirection: v.string(),
  mobileFirstRulesRef: v.string(),
  accessibilityRulesRef: v.string(),
  ownerRole: v.string(),
});

const ComponentCategorySchema = v.picklist(['input', 'navigation', 'feedback', 'layout', 'display', 'overlay']);
const ComponentStatusSchema = v.picklist(['draft', 'ready', 'deprecated']);

export const ComponentDefinitionCreateSchema = v.object({
  standardId: v.string(),
  name: v.string(),
  category: ComponentCategorySchema,
  supportedSurfaces: v.array(v.string()),
  requiredStates: v.array(v.string()),
  usageGuidance: v.string(),
  accessibilityNotes: v.string(),
  mobileBehavior: v.string(),
  desktopBehavior: v.string(),
  status: ComponentStatusSchema,
});

export const ComponentDefinitionUpdateSchema = v.object({
  supportedSurfaces: v.optional(v.array(v.string())),
  requiredStates: v.optional(v.array(v.string())),
  usageGuidance: v.optional(v.string()),
  accessibilityNotes: v.optional(v.string()),
  mobileBehavior: v.optional(v.string()),
  desktopBehavior: v.optional(v.string()),
  status: v.optional(ComponentStatusSchema),
});

export const ComplianceRunCreateSchema = v.object({
  standardId: v.string(),
  checklistVersion: v.string(),
  authorType: v.picklist(['human', 'agent']),
  changeRef: v.string(),
});

export const ExceptionRequestCreateSchema = v.object({
  standardId: v.string(),
  requestedBy: v.string(),
  rationale: v.string(),
  scope: v.string(),
  expirationDate: v.string(),
});

const MigrationWorkItemStatusSchema = v.picklist(['backlog', 'planned', 'in-progress', 'completed', 'verified']);

export const MigrationWorkItemCreateSchema = v.object({
  standardId: v.string(),
  surface: v.picklist(['control-plane', 'agent-ui']),
  targetRef: v.string(),
  priority: v.picklist(['high', 'medium', 'low']),
  status: MigrationWorkItemStatusSchema,
  owner: v.string(),
  dueMilestone: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export const MigrationWorkItemPatchSchema = v.object({
  status: MigrationWorkItemStatusSchema,
  owner: v.optional(v.string()),
  notes: v.optional(v.string()),
});
