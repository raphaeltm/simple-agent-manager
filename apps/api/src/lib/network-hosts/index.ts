// Moved to @simple-agent-manager/worker-core (packages need the outbound guard too: GitLab in
// repo-hosting, the image resolver and R2 presign target in app-deployment). This re-export keeps
// the worker's existing importers unchanged.
export {
  assertOutboundUrl,
  classifyHost,
  DEFAULT_OUTBOUND_MAX_REDIRECTS,
  guardedFetch,
  type HostClass,
  isAcceptableOperatorEndpoint,
  isForbiddenEndpointHost,
  isPrivateNetworkHost,
  MAX_OUTBOUND_REDIRECTS,
  type OutboundPolicy,
  type OutboundRefusalReason,
  OutboundRequestRefusedError,
} from '@simple-agent-manager/worker-core';
