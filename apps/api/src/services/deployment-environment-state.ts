// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export {
  DEPLOYMENT_RELOCATION_CLAIM_FIELD,
  NO_DEPLOYMENT_RELOCATION_CLAIM_SQL,
  RECOVER_ERRORED_ENVIRONMENT_SET_SQL,
} from '@simple-agent-manager/app-deployment';
