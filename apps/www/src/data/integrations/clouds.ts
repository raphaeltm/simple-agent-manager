/**
 * Cloud providers. Copy lives in clouds.json. Source of truth: packages/providers/src (locations,
 * *_VOLUME_CAPABILITIES) and apps/web/src/components/CloudProviderConnectFlow.tsx.
 *
 * Credential precedence is project → user → installation (resolveCredentialSource() in
 * apps/api/src/services/provider-credentials.ts), so an account FAQ must not say a user always needs
 * their own cloud account.
 */
import clouds from './clouds.json';
import { asIntegration, type Integration } from './types';

export const cloudIntegrations: Integration[] = clouds.map(asIntegration);
