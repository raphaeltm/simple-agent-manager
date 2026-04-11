import * as v from 'valibot';

export const AdminUserActionSchema = v.object({
  action: v.picklist(['approve', 'suspend']),
});

export const AdminUserRoleSchema = v.object({
  role: v.picklist(['admin', 'user']),
});

export const AnalyticsForwardSchema = v.object({
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
});

export const CreatePlatformCredentialSchema = v.object({
  credentialType: v.picklist(['cloud-provider', 'agent-api-key']),
  provider: v.optional(v.picklist(['hetzner', 'scaleway', 'gcp'])),
  agentType: v.optional(v.string()),
  credentialKind: v.optional(v.picklist(['api-key', 'oauth-token'])),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  credential: v.pipe(v.string(), v.minLength(1)),
});

export const UpdatePlatformCredentialSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  isEnabled: v.optional(v.boolean()),
});
