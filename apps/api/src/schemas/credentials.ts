import { AGENT_TYPE_VALUES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

const AgentTypeSchema = v.picklist(AGENT_TYPE_VALUES);
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

const VultrCredentialSchema = v.object({
  provider: v.literal('vultr'),
  token: v.string(),
});

const GcpCredentialSchema = v.object({
  provider: v.literal('gcp'),
  authType: v.optional(v.literal('workload-identity')),
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
  VultrCredentialSchema,
  GcpCredentialSchema,
]);

export const SaveGcpServiceAccountCredentialSchema = v.object({
  serviceAccountJson: v.pipe(v.string(), v.minLength(1)),
  defaultZone: v.pipe(v.string(), v.minLength(1)),
});

export const SaveAgentCredentialSchema = v.object({
  agentType: AgentTypeSchema,
  credentialKind: v.optional(CredentialKindSchema),
  credential: v.string(),
  autoActivate: v.optional(v.boolean()),
});

export const CredentialKindBodySchema = v.object({
  credentialKind: CredentialKindSchema,
});
