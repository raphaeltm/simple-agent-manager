import * as v from 'valibot';

export const WORKLOAD_IDENTITY_TOKEN_ENV = 'SAM_OIDC_TOKEN';
export const DEFAULT_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS = 300;
/** Protocol safety ceiling; installation TTL may be shorter, never longer. */
export const MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS = 600;
export const WORKLOAD_IDENTITY_AUDIENCE_MAX_LENGTH = 1024;
export const WORKLOAD_IDENTITY_LABEL_MAX_LENGTH = 160;

/** All labels are descriptive, mutable metadata. Authorize using IDs, issuer and audience. */
export const WorkloadIdentityClaimsSchema = v.object({
  project_id: v.string(),
  project_name: v.optional(v.string()),
  user_id: v.string(),
  user_name: v.optional(v.string()),
  chat_session_id: v.string(),
  session_name: v.optional(v.string()),
  agent_session_id: v.string(),
  workspace_id: v.string(),
  agent_profile_id: v.optional(v.string()),
  agent_profile_name: v.optional(v.string()),
  agent_type: v.optional(v.string()),
  skill_id: v.optional(v.string()),
  task_id: v.optional(v.string()),
  task_name: v.optional(v.string()),
  parent_task_id: v.optional(v.string()),
  triggered_by: v.optional(v.string()),
  trigger_id: v.optional(v.string()),
  trigger_name: v.optional(v.string()),
  trigger_execution_id: v.optional(v.string()),
  automation_type: v.optional(v.picklist(['trigger', 'schedule', 'standing_watch', 'workflow'])),
  automation_id: v.optional(v.string()),
  automation_execution_id: v.optional(v.string()),
  automation_name: v.optional(v.string()),
});
export type WorkloadIdentityClaims = v.InferOutput<typeof WorkloadIdentityClaimsSchema>;
export const WorkloadIdentityMetadataSchema = v.object({
  issuer: v.string(),
  jwks_uri: v.string(),
  subject: v.string(),
  ttl_seconds: v.number(),
  claims: WorkloadIdentityClaimsSchema,
});
export type WorkloadIdentityMetadata = v.InferOutput<typeof WorkloadIdentityMetadataSchema>;
