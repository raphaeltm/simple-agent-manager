/**
 * How a resolution source is reported. One mapping for every caller (agent-key,
 * AI proxy, compute provider), exhaustive so a new source cannot silently be read
 * as a platform credential.
 */
import type { AgentCredentialScope } from '../types/user';
import type { ResolutionSource } from './types';

/** Who owns the credential. A profile pin is one of the user's own accounts. */
export function credentialOwnerFromSource(
  source: ResolutionSource
): 'user' | 'project' | 'platform' {
  switch (source) {
    case 'project-attachment':
      return 'project';
    case 'profile-attachment':
    case 'user-attachment':
      return 'user';
    case 'platform':
    case 'platform-proxy':
      return 'platform';
  }
}

/** Which resolution tier chose the credential, for attribution. */
export function credentialScopeFromSource(source: ResolutionSource): AgentCredentialScope {
  switch (source) {
    case 'profile-attachment':
      return 'profile';
    case 'project-attachment':
      return 'project';
    case 'user-attachment':
      return 'user';
    case 'platform':
    case 'platform-proxy':
      return 'platform';
  }
}
