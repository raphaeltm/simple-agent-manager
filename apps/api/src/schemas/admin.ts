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

export const ProjectDataStorageEmergencyPurgeSchema = v.object({
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  targetRatio: v.optional(v.pipe(v.number(), v.minValue(0.1), v.maxValue(0.99))),
  batchRows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000))),
  maxBatches: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});

export const ProjectDataStorageReliefMeasureSchema = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  cursor: v.optional(
    v.object({
      grouped: v.optional(
        v.object({
          sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
          createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
          id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        })
      ),
      toolPayload: v.optional(
        v.object({
          sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
          createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
          sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
          messageId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        })
      ),
    })
  ),
});

export const ProjectDataArchiveCanaryControlSchema = v.object({
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  dryRun: v.optional(v.boolean()),
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  wallTimeMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  chunkRows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  chunkBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const ProjectDataArchiveFreezeProjectSchema = v.object({
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

export const ProjectDataArchiveCircuitBreakerSchema = v.object({
  state: v.picklist(['closed', 'open', 'frozen']),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

export const ProjectDataArchiveRecoveryControlSchema = v.object({
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

export const AnalyticsForwardSchema = v.object({
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
});

export const CreatePlatformCredentialSchema = v.object({
  credentialType: v.picklist(['cloud-provider', 'agent-api-key']),
  provider: v.optional(
    v.picklist(['hetzner', 'scaleway', 'gcp', 'vultr', 'infomaniak', 'digitalocean', 'upcloud'])
  ),
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
      })
    ),
    google: v.optional(
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
      })
    ),
    googleInfrastructure: v.optional(
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
        remove: v.optional(v.boolean()),
      })
    ),
    gitlab: v.optional(
      v.object({
        host: v.optional(v.string()),
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
      })
    ),
    feedback: v.optional(
      v.object({
        projectId: v.optional(v.pipe(v.string(), v.maxLength(200))),
        remove: v.optional(v.boolean()),
      })
    ),
  }),
});
