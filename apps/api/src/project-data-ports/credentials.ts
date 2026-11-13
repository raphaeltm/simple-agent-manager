import type { CredentialsPort } from '@simple-agent-manager/project-data';

import { credentialLimitReferenceKey } from '../services/credential-limit-events/values';

/** Credential reference keys as provider-limit events store them. */
export const credentialsPort: CredentialsPort = {
  limitReferenceKey: credentialLimitReferenceKey,
};
