/**
 * Install the worker's ProjectData ports for every unit/integration test file.
 *
 * Imported lazily in `beforeAll`, which runs after the test file's hoisted
 * `vi.mock()` calls have registered, so the ports delegate to whatever worker
 * modules the test mocked — exactly as when ProjectData imported them directly.
 */
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const [{ configureProjectDataPorts }, { workerProjectDataPorts }] = await Promise.all([
    import('../../src/durable-objects/project-data/ports'),
    import('../../src/project-data-ports'),
  ]);
  configureProjectDataPorts(workerProjectDataPorts);
});
