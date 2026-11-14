// Canonical implementation lives in the app-deployment package.
export type {
  BuildContextDescriptor,
  BuildContextOwner,
} from '@simple-agent-manager/app-deployment';
export {
  buildContextKey,
  completeBuildContext,
  reserveBuildContext,
} from '@simple-agent-manager/app-deployment';
