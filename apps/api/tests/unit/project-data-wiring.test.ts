// The worker entry is the only production code that installs the ProjectData ports
// (`src/project-data-wiring.ts`). Test setup installs them too, so without this test a dropped
// install would leave every other test green while production throws on the first port read.
import { describe, expect, it, vi } from 'vitest';

// The entry pulls in the container runtime packages, which import `cloudflare:` modules Node
// cannot load; the routing tests that load the entry stub them the same way.
vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
}));

const PORTS_KEY = Symbol.for('sam.project-data.ports');
const PORT_NAMES = [
  'credentials',
  'notices',
  'notifications',
  'observability',
  'operations',
  'runtime',
  'sessions',
  'taskLiveness',
  'tasks',
];

describe('ProjectData port wiring', () => {
  it('installs every worker port when the worker entry loads', async () => {
    delete (globalThis as Record<symbol, unknown>)[PORTS_KEY];
    vi.resetModules();
    const { projectDataPorts } = await import('@simple-agent-manager/project-data/internal/do/ports');
    // Liveness: the registry really is empty before the entry loads.
    expect(() => projectDataPorts().tasks).toThrow(/port "tasks" is not configured/);

    await import('../../src/index');

    const { workerProjectDataPorts } = await import('../../src/project-data-ports/index');
    expect(Object.keys(workerProjectDataPorts).sort()).toEqual(PORT_NAMES);
    const installed = projectDataPorts();
    for (const name of PORT_NAMES) {
      expect(installed[name as keyof typeof installed], name).toBe(
        workerProjectDataPorts[name as keyof typeof workerProjectDataPorts]
      );
    }
  }, 120_000);
});
