/**
 * Provider Interface Contract
 *
 * This file re-exports the canonical types from packages/providers/src/types.ts.
 * It exists as a reference entry point for the spec — the actual definitions live
 * in the provider package.
 */

export type {
  VMConfig,
  VMInstance,
  VMStatus,
  SizeConfig,
  Provider,
  ProviderConfig,
  HetznerProviderConfig,
  UpCloudProviderConfig,
} from '../../../packages/providers/src/types';

export { ProviderError } from '../../../packages/providers/src/types';

export { createProvider } from '../../../packages/providers/src/index';
