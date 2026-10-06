export type { DeploymentReservationDefaults, DeploymentReservationManifest } from './resources';
export {
  DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
  DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
  DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
  resolveDeploymentManifestReservation,
} from './resources';
export type {
  DeploymentManifest,
  EnvValue,
  HealthCheck,
  Hooks,
  Image,
  PreFlightHook,
  ResourceLimits,
  Route,
  SecretRef,
  Service,
  ServiceVolumeMount,
  VolumeDeclaration,
} from './schema';
export {
  DeploymentManifestSchema,
  EnvValueSchema,
  HealthCheckSchema,
  HooksSchema,
  ImageSchema,
  PreFlightHookSchema,
  ResourceLimitsSchema,
  RouteSchema,
  SecretRefSchema,
  ServiceSchema,
  ServiceVolumeMountSchema,
  VolumeDeclarationSchema,
} from './schema';
export type { ManifestError, ManifestValidationResult } from './validate';
export { validateManifest } from './validate';
