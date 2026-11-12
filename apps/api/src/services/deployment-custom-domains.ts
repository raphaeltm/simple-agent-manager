/** Re-export: this module moved to `src/app-deployment/deployment-custom-domains.ts`. */
export type {
  CustomDomainDesiredState,
  CustomDomainLifecycleEventInput,
  CustomDomainRoutingStatus,
} from '../app-deployment';
export {
  buildVerifiedCustomRouteTargets,
  customDomainExpectedTargetChanged,
  findRouteTargetForDomain,
  getEnvironmentPublicRouteTargets,
  reconcileCustomDomainRoutingObservation,
  recordCustomDomainEvent,
  requestRoutingRevision,
  routeTargetOptions,
} from '../app-deployment';
