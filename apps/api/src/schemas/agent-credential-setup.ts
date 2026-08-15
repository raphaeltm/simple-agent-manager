import * as v from 'valibot';

/**
 * Guided credential setup session create-body schema
 * (apps/api/src/routes/agent-credential-setup-sessions.ts POST /). Every
 * field is optional because the route already tolerates a missing/invalid
 * JSON body entirely (via `parseOptionalBody`, mirroring its pre-existing
 * `.catch(() => ({}))` fallback) and falls back to the default agent type.
 */
export const CreateAgentCredentialSetupSessionSchema = v.object({
  agentType: v.optional(v.string()),
});
