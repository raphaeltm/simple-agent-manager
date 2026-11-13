// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
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
