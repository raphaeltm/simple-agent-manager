/**
 * Install the worker's repo-hosting ports for every unit/integration test file.
 *
 * Imported lazily in `beforeAll`, which runs after the test file's hoisted `vi.mock()` calls
 * have registered, so the ports delegate to whatever worker modules the test mocked (most often
 * `services/platform-config` and `auth`), as when repo hosting imported them directly. Each port
 * loads on its own, so a test whose partial mocks break one port's module graph still gets the
 * other, and fails only if it reaches the port it broke.
 */
import { beforeAll } from 'vitest';

/** Same budget as `project-data-ports.ts`: the first import of a large worker graph is slow under coverage. */
const PORT_SETUP_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  const { configureRepoHostingPort } = await import('@simple-agent-manager/repo-hosting');
  await Promise.all([
    import('../../src/repo-hosting-ports/platform-config')
      .then((m) => configureRepoHostingPort('platformConfig', m.platformConfigPort))
      .catch(() => undefined),
    import('../../src/repo-hosting-ports/auth')
      .then((m) => configureRepoHostingPort('auth', m.authPort))
      .catch(() => undefined),
  ]);
}, PORT_SETUP_TIMEOUT_MS);
