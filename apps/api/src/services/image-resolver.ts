// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type {
  ImageResolver,
  ImageResolverConfig,
  ImageResolverEnv,
  ImageResolverOptions,
  RegistryAuth,
} from '@simple-agent-manager/app-deployment';
export {
  createImageResolver,
  getImageResolverConfig,
  ImageResolveError,
} from '@simple-agent-manager/app-deployment';
