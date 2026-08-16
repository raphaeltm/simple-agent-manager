import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { reconcileDiagnosisRuns } from '../services/diagnosis-runner';
import { reconcileDiagnosticIncidents } from '../services/diagnostic-incident-reconciliation';
import { isOperationalLoopEnabled } from '../services/operational-kill-switch';
import { checkProvisioningTimeouts } from '../services/timeout';
import { migrateOrphanedWorkspaces } from '../services/workspace-migration';
import { runAnalyticsForwardJob } from './analytics-forward';
import { runScheduledComposeImageArtifactCleanup } from './compose-image-artifact-cleanup';
import { runComputeUsageCleanup } from './compute-usage-cleanup';
import { runCronTriggerSweep } from './cron-triggers';
import {
  runScheduledDeploymentReleaseRetention,
  runScheduledSessionSnapshotPurge,
} from './d1-retention';
import { notifyFailedSweeps } from './failed-sweep-notifications';
import { runNodeCleanupSweep } from './node-cleanup';
import { runObservabilityPurge } from './observability-purge';
import {
  isHourlyPlatformMaintenanceCron,
  scheduleHourlyPlatformMaintenance,
} from './platform-feedback-hourly';
import { runProviderOrphanReconciliation } from './provider-orphan-reconciliation';
import { runSessionSleepSweep } from './session-sleep';
import { runSessionTaskReconciliation } from './session-task-reconciliation';
import { runSetupSessionSweep } from './setup-session-sweep';
import { recoverStuckTasks } from './stuck-tasks';
import { createSweepIsolator } from './sweep-isolation';
import { runTrialExpireSweep } from './trial-expire';
import { runTrialRolloverAudit } from './trial-rollover';
import { runTrialWaitlistCleanup } from './trial-waitlist-cleanup';
import { runTriggerExecutionCleanup } from './trigger-execution-cleanup';

/** Cloudflare scheduled entry point. Special cron jobs are not part of the operational sweep brake. */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const rolloverCron = env.TRIAL_CRON_ROLLOVER_CRON ?? '0 5 1 * *';
  const waitlistCleanupCron = env.TRIAL_CRON_WAITLIST_CLEANUP ?? '0 4 * * *';

  const isDailyForward = controller.cron === '0 3 * * *';
  const isMonthlyCostAggregation = isHourlyPlatformMaintenanceCron(controller.cron);
  const isTrialRollover = controller.cron === rolloverCron;
  const isTrialWaitlistCleanup = controller.cron === waitlistCleanupCron;

  const cronType = isDailyForward
    ? 'daily-forward'
    : isMonthlyCostAggregation
      ? 'monthly-cost-aggregation'
      : isTrialRollover
        ? 'trial-rollover'
        : isTrialWaitlistCleanup
          ? 'trial-waitlist-cleanup'
          : 'sweep';

  log.info('cron.started', { cron: controller.cron, type: cronType });

  if (scheduleHourlyPlatformMaintenance(controller.cron, env, ctx.waitUntil.bind(ctx))) return;

  if (isDailyForward) {
    ctx.waitUntil(
      (async () => {
        const forward = await runAnalyticsForwardJob(env);
        log.info('cron.completed', {
          cron: controller.cron,
          type: 'daily-forward',
          forwardEnabled: forward.enabled,
          forwardEventsQueried: forward.eventsQueried,
          forwardSegmentSent: forward.segment.sent,
          forwardGA4Sent: forward.ga4.sent,
          forwardCursorUpdated: forward.cursorUpdated,
        });
      })()
    );
    return;
  }

  if (isTrialRollover) {
    ctx.waitUntil(
      (async () => {
        const rollover = await runTrialRolloverAudit(env);
        log.info('cron.completed', {
          cron: controller.cron,
          type: 'trial-rollover',
          trialRolloverMonthKey: rollover.monthKey,
          trialRolloverPruned: rollover.pruned,
        });
      })()
    );
    return;
  }

  if (isTrialWaitlistCleanup) {
    ctx.waitUntil(
      (async () => {
        const waitlist = await runTrialWaitlistCleanup(env);
        log.info('cron.completed', {
          cron: controller.cron,
          type: 'trial-waitlist-cleanup',
          trialWaitlistPurged: waitlist.purged,
        });
      })()
    );
    return;
  }

  if (!(await isOperationalLoopEnabled(env, 'cron'))) {
    log.info('cron.skipped_disabled', { cron: controller.cron, type: 'sweep', switch: 'cron' });
    return;
  }

  // Every sweep is isolated so one failure cannot suppress later recovery work.
  const sweeps = createSweepIsolator(env);
  const diagnosisRecovery = await sweeps.isolate('diagnosis_reconcile', () =>
    reconcileDiagnosisRuns(env)
  );
  const incidentRecovery = await sweeps.isolate('diagnostic_incident_reconciliation', () =>
    reconcileDiagnosticIncidents(env)
  );
  const stuckTasks = await sweeps.isolate('stuck_tasks', () => recoverStuckTasks(env));
  const timedOut = await sweeps.isolate('provisioning_timeouts', () =>
    checkProvisioningTimeouts(env.DATABASE, env, env.OBSERVABILITY_DATABASE)
  );

  const db = drizzle(env.DATABASE, { schema });
  const migrated = await sweeps.isolate('orphaned_workspace_migration', () =>
    migrateOrphanedWorkspaces(db)
  );
  const nodeCleanup = await sweeps.isolate('node_cleanup', () => runNodeCleanupSweep(env));
  const providerOrphans = await sweeps.isolate('provider_orphan_reconciliation', () =>
    runProviderOrphanReconciliation(env)
  );
  const observabilityPurge = await sweeps.isolate('observability_purge', () =>
    runObservabilityPurge(env)
  );
  const cronTriggers = await sweeps.isolate('cron_triggers', () => runCronTriggerSweep(env));
  const triggerCleanup = await sweeps.isolate('trigger_execution_cleanup', () =>
    runTriggerExecutionCleanup(env)
  );
  const sessionTaskRepair = await sweeps.isolate('session_task_reconciliation', () =>
    runSessionTaskReconciliation(env)
  );
  const sessionSleep = await sweeps.isolate('session_sleep', () =>
    runSessionSleepSweep(env, new Date(), ctx)
  );
  const setupSessionSweep = await sweeps.isolate('setup_session_sweep', () =>
    runSetupSessionSweep(env, ctx)
  );
  // Retire superseded releases before compose cleanup re-derives referenced artifacts.
  const deploymentReleaseRetention = await sweeps.isolate('deployment_release_retention', () =>
    runScheduledDeploymentReleaseRetention(env)
  );
  // The D1 sweep owns exact snapshot expiry and deletes the matching R2 objects.
  const sessionSnapshotPurge = await sweeps.isolate('session_snapshot_purge', () =>
    runScheduledSessionSnapshotPurge(env)
  );
  const composeArtifactCleanup = await sweeps.isolate('compose_artifact_cleanup', () =>
    runScheduledComposeImageArtifactCleanup(env)
  );
  const computeUsageClosed = await sweeps.isolate('compute_usage_cleanup', () =>
    runComputeUsageCleanup(env)
  );
  const trialExpire = await sweeps.isolate('trial_expire', () => runTrialExpireSweep(env));

  const failedSweeps = sweeps.failedSweeps();
  const failureNotifications = await notifyFailedSweeps(env, failedSweeps).catch((err) => {
    log.error('cron.failed_sweep_notifications_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { notifiedSweeps: 0, notificationsSent: 0 };
  });
  log.info('cron.completed', {
    cron: controller.cron,
    type: 'sweep',
    failedSweeps,
    failedSweepCount: failedSweeps.length,
    failedSweepNotifications: failureNotifications.notificationsSent,
    failedSweepNamesNotified: failureNotifications.notifiedSweeps,
    diagnosisRunsRestarted: diagnosisRecovery?.restarted,
    diagnosisRunsTerminalized: diagnosisRecovery?.terminalized,
    diagnosticIncidentsChecked: incidentRecovery?.checked,
    diagnosticIncidentsRepaired: incidentRecovery?.repaired,
    diagnosticIncidentsFailed: incidentRecovery?.failed,
    diagnosticIncidentsExpired: incidentRecovery?.expired,
    diagnosticIncidentsDeleted: incidentRecovery?.deleted,
    diagnosticIncidentMetadataRepaired: incidentRecovery?.incidentMetadataRepaired,
    provisioningTimedOut: timedOut,
    workspacesMigrated: migrated,
    staleNodesDestroyed: nodeCleanup?.staleDestroyed,
    lifetimeNodesDestroyed: nodeCleanup?.lifetimeDestroyed,
    lifetimeNodesSkipped: nodeCleanup?.lifetimeSkipped,
    nodeCleanupErrors: nodeCleanup?.errors,
    orphanedWorkspacesFlagged: nodeCleanup?.orphanedWorkspacesFlagged,
    orphanedNodesDestroyed: nodeCleanup?.orphanedNodesDestroyed,
    orphanedNodesSkipped: nodeCleanup?.orphanedNodesSkipped,
    stoppedWorkspacesDeleted: nodeCleanup?.stoppedWorkspacesDeleted,
    cfContainersDestroyed: nodeCleanup?.cfContainersDestroyed,
    providerOrphansScanned: providerOrphans?.scanned,
    providerOrphansDestroyed: providerOrphans?.destroyed,
    providerOrphansSkippedUnlabeled: providerOrphans?.skippedUnlabeled,
    providerOrphansSkippedForeignManaged: providerOrphans?.skippedForeignManaged,
    providerOrphansSkippedForeignEnvironment: providerOrphans?.skippedForeignEnv,
    providerOrphansSkippedForeignInstallation: providerOrphans?.skippedForeignInstallation,
    providerOrphansSkippedUnattributedInstallation:
      providerOrphans?.skippedUnattributedInstallation,
    providerOrphansSkippedAmbiguousOwnership: providerOrphans?.skippedAmbiguousOwnership,
    providerOrphansSkippedYoung: providerOrphans?.skippedYoung,
    providerOrphansSkippedClaimed: providerOrphans?.skippedClaimed,
    providerOrphansSkippedAmbiguousClaim: providerOrphans?.skippedAmbiguousClaim,
    providerOrphanSkipReason: providerOrphans?.skipReason,
    providerOrphanErrors: providerOrphans?.errors,
    stuckTasksFailedQueued: stuckTasks?.failedQueued,
    stuckTasksFailedDelegated: stuckTasks?.failedDelegated,
    stuckTasksFailedInProgress: stuckTasks?.failedInProgress,
    stuckTasksHeartbeatSkipped: stuckTasks?.heartbeatSkipped,
    stuckTaskErrors: stuckTasks?.errors,
    stuckTaskDoHealthChecked: stuckTasks?.doHealthChecked,
    observabilityPurgedByAge: observabilityPurge?.deletedByAge,
    observabilityPurgedByCount: observabilityPurge?.deletedByCount,
    cronTriggersChecked: cronTriggers?.checked,
    cronTriggersFired: cronTriggers?.fired,
    cronTriggersSkipped: cronTriggers?.skipped,
    cronTriggersFailed: cronTriggers?.failed,
    triggerExecStaleRecovered: triggerCleanup?.staleRecovered,
    triggerExecStaleQueuedRecovered: triggerCleanup?.staleQueuedRecovered,
    triggerExecRetentionPurged: triggerCleanup?.retentionPurged,
    webhookDeliveriesPurged: triggerCleanup?.webhookDeliveriesPurged,
    triggerExecCleanupErrors: triggerCleanup?.errors,
    sessionTaskRepairScanned: sessionTaskRepair?.scanned,
    sessionTaskRepairRepaired: sessionTaskRepair?.repaired,
    sessionTaskRepairReused: sessionTaskRepair?.reused,
    sessionTaskRepairErrors: sessionTaskRepair?.errors,
    sessionTaskRepairResidual: sessionTaskRepair?.residual,
    sessionSleepSelected: sessionSleep?.selected,
    sessionSleepReconciled: sessionSleep?.reconciled,
    sessionSleepClaimed: sessionSleep?.claimed,
    sessionSleepDispatched: sessionSleep?.dispatched,
    sessionSleepCompleted: sessionSleep?.slept,
    sessionSleepDeferred: sessionSleep?.deferred,
    sessionSleepFailed: sessionSleep?.failed,
    sessionSleepExhausted: sessionSleep?.exhausted,
    sessionSleepBudgetExhausted: sessionSleep?.budgetExhausted,
    deploymentReleaseRetentionSkipped: deploymentReleaseRetention?.skipped,
    deploymentReleaseRetentionSkipReason: deploymentReleaseRetention?.skipReason,
    deploymentReleaseRetentionDeleted: deploymentReleaseRetention?.deletedReleases,
    sessionSnapshotPurgeSkipped: sessionSnapshotPurge?.skipped,
    sessionSnapshotPurgeSkipReason: sessionSnapshotPurge?.skipReason,
    sessionSnapshotPurgeDeleted: sessionSnapshotPurge?.deletedSnapshots,
    sessionSnapshotObjectsDeleted: sessionSnapshotPurge?.deletedObjects,
    sessionSnapshotPurgeErrors: sessionSnapshotPurge?.errors,
    composeArtifactCleanupSkipped: composeArtifactCleanup?.skipped,
    composeArtifactCleanupSkipReason: composeArtifactCleanup?.skipReason,
    composeArtifactCleanupScanned: composeArtifactCleanup?.scannedObjects,
    composeArtifactCleanupReferencedKeys: composeArtifactCleanup?.referencedKeys,
    composeArtifactCleanupRetainedReferenced: composeArtifactCleanup?.retainedReferenced,
    composeArtifactCleanupRetainedYoung: composeArtifactCleanup?.retainedYoung,
    composeArtifactCleanupDeleted: composeArtifactCleanup?.deletedObjects,
    composeArtifactCleanupDeletedBytes: composeArtifactCleanup?.deletedBytes,
    composeArtifactCleanupErrors: composeArtifactCleanup?.errors,
    computeUsageOrphansClosed: computeUsageClosed,
    trialExpired: trialExpire?.expired,
    trialProjectsLinked: trialExpire?.projectsLinked,
    trialWorkspacesDeleted: trialExpire?.workspacesDeleted,
    trialNodesDeleted: trialExpire?.nodesDeleted,
    trialCleanupErrors: trialExpire?.cleanupErrors,
    setupSessionsSwept: setupSessionSweep?.toreDown,
    setupSessionOrphansForced: setupSessionSweep?.orphansForced,
    setupSessionSweepErrors: setupSessionSweep?.errors,
  });
}
