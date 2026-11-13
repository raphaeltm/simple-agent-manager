/** Account usage read for monitoring apps (`account-usage.ts`). */
import * as v from 'valibot';

import { usageGet } from './account-usage';
import { authorizeProjectOperation } from './authorization';
import { defineOperation } from './types';

export const samUsageGet = defineOperation({
  name: 'sam_usage_get',
  title: 'Account usage and resets',
  description:
    'Use this when you need remaining provider usage, limits and reset times for the accounts your agent profiles run on in a project. Results are grouped by quota pool: profiles under one poolId share one quota, so never treat them as separate capacity. Each window says how fresh its sample is; usage.state "never_reported" means unknown, not full. A sam_ai_proxy pool reports your SAM AI budget instead. Optional profileId narrows to that profile’s pool. Never returns credentials.',
  kind: 'read',
  input: v.object({
    projectId: v.pipe(v.string(), v.minLength(1)),
    profileId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return usageGet(ctx, input);
  },
});

export const usageOperations = [samUsageGet] as const;
