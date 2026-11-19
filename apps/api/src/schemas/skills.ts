import * as v from 'valibot';

import { CreateAgentProfileSchema, UpdateAgentProfileSchema } from './agent-profiles';

/** A skill only overrides what it sets: omit or null `agentType` to use the chosen profile's agent. */
const SkillAgentTypeSchema = v.optional(v.nullable(v.string()));

export const CreateSkillSchema = v.object({
  ...CreateAgentProfileSchema.entries,
  agentType: SkillAgentTypeSchema,
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  defaultProfileId: v.optional(v.nullable(v.string())),
});

export const UpdateSkillSchema = v.object({
  ...UpdateAgentProfileSchema.entries,
  agentType: SkillAgentTypeSchema,
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  defaultProfileId: v.optional(v.nullable(v.string())),
});
