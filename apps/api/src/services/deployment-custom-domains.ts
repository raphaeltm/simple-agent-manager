// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  CustomDomainDesiredState,
  CustomDomainLifecycleEventInput,
  CustomDomainRoutingStatus,
} from '@simple-agent-manager/app-deployment';
export {
  buildVerifiedCustomRouteTargets,
  customDomainExpectedTargetChanged,
  findRouteTargetForDomain,
  getEnvironmentPublicRouteTargets,
  reconcileCustomDomainRoutingObservation,
  recordCustomDomainEvent,
  requestRoutingRevision,
  routeTargetOptions,
} from '@simple-agent-manager/app-deployment';
