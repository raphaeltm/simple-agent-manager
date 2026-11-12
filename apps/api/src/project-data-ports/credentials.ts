import type { CredentialsPort } from '../durable-objects/project-data/ports';
import { credentialLimitReferenceKey } from '../services/credential-limit-events/values';

/** Credential reference keys as provider-limit events store them. */
export const credentialsPort: CredentialsPort = {
  limitReferenceKey: credentialLimitReferenceKey,
};
