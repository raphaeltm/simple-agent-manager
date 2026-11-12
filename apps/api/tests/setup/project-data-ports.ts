/**
 * Install the worker's ProjectData ports for every unit/integration test file.
 *
 * Imported lazily in `beforeAll`, which runs after the test file's hoisted
 * `vi.mock()` calls have registered, so the ports delegate to whatever worker
 * modules the test mocked, as when ProjectData imported them directly. Each port
 * loads on its own: a test whose partial mocks break one port's module graph (say,
 * a logger mock without `createModuleLogger`) still gets every other port, and it
 * only fails if it actually reaches the port it broke.
 */
import { beforeAll } from 'vitest';

const PORT_MODULES = {
  tasks: () => import('../../src/project-data-ports/tasks').then((m) => m.tasksPort),
  taskLiveness: () =>
    import('../../src/project-data-ports/task-liveness').then((m) => m.taskLivenessPort),
  sessions: () => import('../../src/project-data-ports/sessions').then((m) => m.sessionsPort),
  runtime: () => import('../../src/project-data-ports/runtime').then((m) => m.runtimePort),
  credentials: () =>
    import('../../src/project-data-ports/credentials').then((m) => m.credentialsPort),
  notices: () => import('../../src/project-data-ports/notices').then((m) => m.noticesPort),
  notifications: () =>
    import('../../src/project-data-ports/notifications').then((m) => m.notificationsPort),
  observability: () =>
    import('../../src/project-data-ports/observability').then((m) => m.observabilityPort),
  operations: () => import('../../src/project-data-ports/operations').then((m) => m.operationsPort),
} as const;

beforeAll(async () => {
  const { configureProjectDataPorts } =
    await import('../../src/durable-objects/project-data/ports');
  await Promise.all(
    Object.entries(PORT_MODULES).map(async ([name, load]) => {
      try {
        configureProjectDataPorts({ [name]: await load() });
      } catch {
        // This test file's mocks cannot load this port's worker modules; it never
        // reaches the port, or it fails naming the unconfigured port.
      }
    })
  );
});
