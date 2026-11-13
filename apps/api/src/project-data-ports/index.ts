/**
 * The worker's implementation of `ProjectDataPorts`: how ProjectData reaches task
 * lifecycle, task liveness, session recovery, node agents, prompt transport,
 * notices, notifications, telemetry and operations, which other areas of the
 * worker own. One module per port, so a consumer (or a test) loads only the
 * worker modules its port needs. Installed by `project-data-wiring.ts`.
 */
import type { ProjectDataPorts } from '../durable-objects/project-data/ports';
import { credentialsPort } from './credentials';
import { noticesPort } from './notices';
import { notificationsPort } from './notifications';
import { observabilityPort } from './observability';
import { operationsPort } from './operations';
import { runtimePort } from './runtime';
import { sessionsPort } from './sessions';
import { taskLivenessPort } from './task-liveness';
import { tasksPort } from './tasks';

export const workerProjectDataPorts: ProjectDataPorts = {
  tasks: tasksPort,
  taskLiveness: taskLivenessPort,
  sessions: sessionsPort,
  runtime: runtimePort,
  credentials: credentialsPort,
  notices: noticesPort,
  notifications: notificationsPort,
  observability: observabilityPort,
  operations: operationsPort,
};
