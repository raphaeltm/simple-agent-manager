// Cross-language contract tests pin these to the resolved VM heartbeat and callback defaults.
export const DEFAULT_DEPLOY_PUBLISH_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_DEPLOY_PUBLISH_CALLBACK_GRACE_MS = 30_000;
export const MIN_DEPLOY_PUBLISH_JOB_STALL_MS =
  2 * DEFAULT_DEPLOY_PUBLISH_HEARTBEAT_INTERVAL_MS + DEFAULT_DEPLOY_PUBLISH_CALLBACK_GRACE_MS;
export const DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS = 5 * 60_000;
// The VM permits 20 minutes after its later start; allow admission and callback grace.
export const DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS = 30 * 60_000;
export const DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MARGIN_MS = 5 * 60_000;
export const DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT = 25;
export const DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS = 5_000;
