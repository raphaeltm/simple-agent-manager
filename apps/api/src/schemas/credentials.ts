import * as v from 'valibot';

const AgentTypeSchema = v.picklist(['claude-code', 'openai-codex', 'google-gemini', 'mistral-vibe']);
const CredentialKindSchema = v.picklist(['api-key', 'oauth-token']);

// Discriminated union for CreateCredentialRequest
const HetznerCredentialSchema = v.object({
  provider: v.literal('hetzner'),
  token: v.string(),
});

const ScalewayCredentialSchema = v.object({
  provider: v.literal('scaleway'),
  secretKey: v.string(),
  projectId: v.string(),
});

const GcpCredentialSchema = v.object({
  provider: v.literal('gcp'),
  gcpProjectId: v.string(),
  gcpProjectNumber: v.string(),
  serviceAccountEmail: v.string(),
  wifPoolId: v.string(),
  wifProviderId: v.string(),
  defaultZone: v.string(),
});

export const CreateCredentialSchema = v.variant('provider', [
  HetznerCredentialSchema,
  ScalewayCredentialSchema,
  GcpCredentialSchema,
]);

export const SaveAgentCredentialSchema = v.object({
  agentType: AgentTypeSchema,
  credentialKind: v.optional(CredentialKindSchema),
  credential: v.string(),
  autoActivate: v.optional(v.boolean()),
});

export const CredentialKindBodySchema = v.object({
  credentialKind: CredentialKindSchema,
});
