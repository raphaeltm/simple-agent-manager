import { AGENT_MODEL_SELECTION_MAX, isAgentModelId } from '@simple-agent-manager/shared';
import * as v from 'valibot';

/** A stored model selection: null = inherit the layer below; [] = no models. */
export const AgentModelSelectionSchema = v.nullable(
  v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.check(
          (value) => isAgentModelId(value),
          'Each model must be a Cloudflare Workers AI id like @cf/cloudflare/clef-flash'
        )
      )
    ),
    v.maxLength(AGENT_MODEL_SELECTION_MAX, `At most ${AGENT_MODEL_SELECTION_MAX} models`)
  )
);

/** Body of PUT /api/projects/:projectId/agent-models. The admin maximum is checked by the route. */
export const UpdateProjectAgentModelsSchema = v.object({
  models: v.optional(AgentModelSelectionSchema),
  monthlyBudgetUsd: v.optional(
    v.nullable(
      v.pipe(v.number(), v.finite(), v.minValue(0, 'The monthly budget cannot be negative'))
    )
  ),
});
