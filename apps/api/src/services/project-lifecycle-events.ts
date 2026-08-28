import type {
  AdmitProjectEventInput,
  ProjectEventAdmissionResult,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import * as projectDataService from './project-data';
import {
  buildDeploymentEnvironmentLifecycleEventInput,
  buildDeploymentPublishJobLifecycleEventInput,
  buildDeploymentReleaseLifecycleEventInput,
  buildSessionLifecycleEventInput,
  buildTaskLifecycleEventInput,
  type DeploymentEnvironmentLifecycleEventInput,
  type DeploymentPublishJobLifecycleEventInput,
  type DeploymentReleaseLifecycleEventInput,
  isLifecycleTaskStatus,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
  type SessionLifecycleEventInput,
  type TaskLifecycleEventInput,
  taskLifecycleEventType,
} from './project-lifecycle-event-inputs';

const log = createModuleLogger('project_lifecycle_events');

type ProjectLifecycleEventWithoutProjectId = Omit<AdmitProjectEventInput, 'projectId'>;

async function admitProjectLifecycleEvent(
  env: Env,
  event: AdmitProjectEventInput
): Promise<ProjectEventAdmissionResult> {
  const { projectId, ...withoutProjectId } = event;
  return projectDataService.admitProjectEvent(
    env,
    projectId,
    withoutProjectId as ProjectLifecycleEventWithoutProjectId
  );
}

async function recordBestEffort(
  env: Env,
  eventPromise: Promise<AdmitProjectEventInput>,
  context: { projectId: string; eventType: string; subjectId: string }
): Promise<void> {
  try {
    await admitProjectLifecycleEvent(env, await eventPromise);
  } catch (err) {
    log.warn('project_lifecycle_event.admission_failed', {
      projectId: context.projectId,
      eventType: context.eventType,
      subjectId: context.subjectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordTaskLifecycleEvent(
  env: Env,
  input: TaskLifecycleEventInput
): Promise<ProjectEventAdmissionResult> {
  return admitProjectLifecycleEvent(env, await buildTaskLifecycleEventInput(input));
}

export function recordTaskLifecycleEventBestEffort(
  env: Env,
  input: TaskLifecycleEventInput
): Promise<void> {
  return recordBestEffort(env, buildTaskLifecycleEventInput(input), {
    projectId: input.projectId,
    eventType: taskLifecycleEventType(input.status),
    subjectId: input.taskId,
  });
}

export async function recordSessionLifecycleEvent(
  env: Env,
  input: SessionLifecycleEventInput
): Promise<ProjectEventAdmissionResult> {
  return admitProjectLifecycleEvent(env, await buildSessionLifecycleEventInput(input));
}

export async function recordDeploymentReleaseLifecycleEvent(
  env: Env,
  input: DeploymentReleaseLifecycleEventInput
): Promise<ProjectEventAdmissionResult> {
  return admitProjectLifecycleEvent(env, await buildDeploymentReleaseLifecycleEventInput(input));
}

export function recordDeploymentReleaseLifecycleEventBestEffort(
  env: Env,
  input: DeploymentReleaseLifecycleEventInput
): Promise<void> {
  return recordBestEffort(env, buildDeploymentReleaseLifecycleEventInput(input), {
    projectId: input.projectId,
    eventType: `deployment.release.${input.status}`,
    subjectId: input.releaseId,
  });
}

export async function recordDeploymentEnvironmentLifecycleEvent(
  env: Env,
  input: DeploymentEnvironmentLifecycleEventInput
): Promise<ProjectEventAdmissionResult> {
  return admitProjectLifecycleEvent(
    env,
    await buildDeploymentEnvironmentLifecycleEventInput(input)
  );
}

export function recordDeploymentEnvironmentLifecycleEventBestEffort(
  env: Env,
  input: DeploymentEnvironmentLifecycleEventInput
): Promise<void> {
  return recordBestEffort(env, buildDeploymentEnvironmentLifecycleEventInput(input), {
    projectId: input.projectId,
    eventType: `deployment.environment.${input.lifecycle}`,
    subjectId: input.environmentId,
  });
}

export async function recordDeploymentPublishJobLifecycleEvent(
  env: Env,
  input: DeploymentPublishJobLifecycleEventInput
): Promise<ProjectEventAdmissionResult> {
  return admitProjectLifecycleEvent(env, await buildDeploymentPublishJobLifecycleEventInput(input));
}

export function recordDeploymentPublishJobLifecycleEventBestEffort(
  env: Env,
  input: DeploymentPublishJobLifecycleEventInput
): Promise<void> {
  const status = input.status.toLowerCase();
  return recordBestEffort(env, buildDeploymentPublishJobLifecycleEventInput(input), {
    projectId: input.projectId,
    eventType: `deployment.publish_job.${status}`,
    subjectId: input.publishJobId,
  });
}

export {
  type DeploymentEnvironmentLifecycleEventInput,
  type DeploymentPublishJobLifecycleEventInput,
  type DeploymentReleaseLifecycleEventInput,
  isLifecycleTaskStatus,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
  type SessionLifecycleEventInput,
  type TaskLifecycleEventInput,
};
