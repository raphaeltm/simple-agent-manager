/**
 * Minimal worker entrypoint for the real-runtime integration suite.
 *
 * Keep this focused on the Durable Objects bound by vitest.workers.config.ts.
 * Importing the production entrypoint also initializes unrelated Containers and
 * Sandbox SDK modules, which are not part of these tests and crash workerd
 * before Vitest can collect files.
 */
export { AdminLogs } from '../../src/durable-objects/admin-logs';
export { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';
export { ProjectAgent } from '../../src/durable-objects/project-agent';
export { ProjectData } from '../../src/durable-objects/project-data';
export { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
export { SamSession } from '../../src/durable-objects/sam-session';
export { TaskRunner } from '../../src/durable-objects/task-runner';
export { TrialCounter } from '../../src/durable-objects/trial-counter';
export { TrialEventBus } from '../../src/durable-objects/trial-event-bus';
export { TrialOrchestrator } from '../../src/durable-objects/trial-orchestrator';

export default {
  fetch(): Response {
    return new Response('Worker test entrypoint');
  },
};
