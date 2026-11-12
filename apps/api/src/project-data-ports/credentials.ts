import type { CredentialsPort } from '../durable-objects/project-data/ports';
import { credentialLimitReferenceKey } from '../services/credential-limit-events/values';
import { parseProviderLimitWait } from '../services/provider-limit-policy';

/** Credential reference keys and provider usage-limit holds. */
export const credentialsPort: CredentialsPort = {
  limitReferenceKey: credentialLimitReferenceKey,
  parseProviderLimitWait,
};
