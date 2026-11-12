/**
 * Default for `operations.provisioningAttemptsPerProviderTier`. Every attempt is a provider create
 * plus about a dozen D1 and HTTP subrequests, and a live catalog can give one source hundreds of
 * offerings (every zone of every machine type). Uncapped, one step could exceed the Worker
 * subrequest limit before reaching the next provider. At 8 per tier, a three-provider order is at
 * most 24 creates in one step.
 */
export const DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER = 8;

/**
 * Default for `operations.workspacePlacementMaxRejections`: consecutive times a task's final
 * workspace reservation may be refused by the node it selected before the task fails. A refusal
 * sends the task back through node selection, provisioning recovery and agent readiness, about
 * 6 s per cycle on staging, so 3 bounds a node that can never admit the request to about 18 s
 * (the configurable maximum of 20 to about 2 minutes). Before the cap the loop ran until the
 * 15-minute provisioning timeout. The count resets when a reservation succeeds.
 */
export const DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS = 3;

/**
 * Default for `operations.workspacePlacementBacklogConflictRetries`: how many times a task's
 * reservation may be refused only because the ranked node's startup queue grew after ranking,
 * counted since the task's last successful reservation, before the next reservation drops that
 * fairness guard (capacity guards stay). Capacity refusals neither add to nor reset this count.
 * Each conflict replans through node selection: D1 reads and no provider call. The cap bounds how
 * often one task can lose that race; it does not bound how long the replans take, which depends
 * on alarm scheduling and the other work in flight.
 */
export const DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES = 3;

/**
 * Default for `operations.workspaceBuildQueueTimeoutMinutes`: how long a workspace may wait for its
 * node's single build slot (`workspace-creating-deadline.ts`). About 20 queued builds of ~3 minutes.
 */
export const DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES = 60;
