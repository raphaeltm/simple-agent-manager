import { integerDefinition } from './admin-setting-definitions';
import {
  DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
} from './deployment-publish-job-defaults';

export const DEPLOYMENT_PUBLISH_SETTINGS = [
  integerDefinition(
    'deployments.publishJobStallMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
    'Operations',
    'Maximum silence between publish-job events before failing the job as stalled.',
    { min: 10_000, max: 86_400_000 }
  ),
  integerDefinition(
    'deployments.publishJobDeadlineMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
    'Operations',
    'Overall publish-job deadline from creation, even while events keep arriving.',
    { min: 10_000, max: 86_400_000 }
  ),
  integerDefinition(
    'deployments.publishJobSweepLimit',
    DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
    'Operations',
    'Maximum expired publish jobs failed per scheduled tick. Each uses one conditional write and one lifecycle delivery.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'deployments.publishJobCancelTimeoutMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
    'Operations',
    'Best-effort VM cancellation request timeout after durable cancellation.',
    { min: 100, max: 30_000 }
  ),
];
