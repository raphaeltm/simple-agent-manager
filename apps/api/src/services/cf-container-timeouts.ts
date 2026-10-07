import { getTimeoutMs } from './fetch-timeout';

// Standalone workspace creation clones synchronously, including on cold restore.
// Keep the existing configurable create budget independent of node transport.
const DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS = 120_000;

export function getCfContainerCreateWorkspaceTimeoutMs(env: {
  CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS?: string;
}): number {
  return getTimeoutMs(
    env.CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS,
    DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS
  );
}
