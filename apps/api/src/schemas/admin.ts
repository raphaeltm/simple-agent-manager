import * as v from 'valibot';

export const AdminUserActionSchema = v.object({
  action: v.picklist(['approve', 'suspend']),
});

export const AdminUserRoleSchema = v.object({
  role: v.picklist(['admin', 'user']),
});

export const UpdateSignupApprovalConfigSchema = v.object({
  requireApproval: v.boolean(),
});

export const AnalyticsForwardSchema = v.object({
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
});

export const CreatePlatformCredentialSchema = v.object({
  credentialType: v.picklist(['cloud-provider', 'agent-api-key']),
  provider: v.optional(v.picklist(['hetzner', 'scaleway', 'gcp', 'vultr', 'digitalocean'])),
  agentType: v.optional(v.string()),
  credentialKind: v.optional(v.picklist(['api-key', 'oauth-token'])),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  credential: v.pipe(v.string(), v.minLength(1)),
});

export const UpdatePlatformCredentialSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  isEnabled: v.optional(v.boolean()),
});

export const UpdatePlatformIntegrationConfigSchema = v.object({
  config: v.object({
    github: v.optional(
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
        appId: v.optional(v.string()),
        appPrivateKey: v.optional(v.string()),
        appSlug: v.optional(v.string()),
        webhookSecret: v.optional(v.string()),
      }),
    ),
    google: v.optional(
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
      }),
    ),
    googleInfrastructure: v.optional(
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
        remove: v.optional(v.boolean()),
      }),
    ),
    gitlab: v.optional(
      v.object({
        host: v.optional(v.string()),
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
      }),
    ),
  }),
});
