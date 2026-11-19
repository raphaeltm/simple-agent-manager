import * as v from 'valibot';

import { MAX_RESOURCE_ID_LENGTH } from './_validator';

/** Empty bodies preserve default user setup; supplied fields must be valid. */
export const CreateAgentCredentialSetupSessionSchema = v.strictObject({
  agentType: v.optional(v.string()),
  projectId: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_RESOURCE_ID_LENGTH))
  ),
});
