// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  ComposeApplyRenderResult,
  ComposeRenderContext,
} from '@simple-agent-manager/app-deployment';
export {
  collectSecretNames,
  renderCompose,
  renderComposeForApply,
} from '@simple-agent-manager/app-deployment';
