import * as v from 'valibot';

import { CreateAgentProfileSchema, UpdateAgentProfileSchema } from './agent-profiles';

export const CreateSkillSchema = v.intersect([
  CreateAgentProfileSchema,
  v.object({
    resourceRequirementsJson: v.optional(v.nullable(v.string())),
    defaultProfileId: v.optional(v.nullable(v.string())),
  }),
]);

export const UpdateSkillSchema = v.intersect([
  UpdateAgentProfileSchema,
  v.object({
    resourceRequirementsJson: v.optional(v.nullable(v.string())),
    defaultProfileId: v.optional(v.nullable(v.string())),
  }),
]);
