import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../src');

function read(relPath: string): string {
  return readFileSync(join(apiRoot, relPath), 'utf8');
}

describe('cf-container runtime spike contracts', () => {
  it('adds a non-null node runtime discriminator without changing workspace node_id', () => {
    const migration = read('db/migrations/0088_node_runtime.sql');
    const schema = read('db/schema.ts');

    expect(migration).toContain("ALTER TABLE nodes ADD COLUMN runtime TEXT NOT NULL DEFAULT 'vm'");
    expect(schema).toContain("runtime: text('runtime').notNull().default('vm')");
    expect(schema).toContain("nodeId: text('node_id').references(() => nodes.id");
  });

  it('routes cf-container workspace hostnames through the Sandbox binding behind the kill switch', () => {
    const index = read('index.ts');

    expect(index).toContain("nodeRuntime === 'cf-container'");
    expect(index).toContain("c.env.SANDBOX_ENABLED !== 'true'");
    expect(index).toContain('getSandbox(c.env.SANDBOX, sandboxId');
    expect(index).toContain('sandbox.containerFetch(');
    expect(index).toContain("metric: 'ws_proxy_route'");
  });

  it('routes Worker-to-vm-agent service calls through Sandbox for cf-container nodes only', () => {
    const nodeAgent = read('services/node-agent.ts');

    expect(nodeAgent).toContain("node?.runtime !== 'cf-container'");
    expect(nodeAgent).toContain("env.SANDBOX_ENABLED !== 'true'");
    expect(nodeAgent).toContain('getSandbox(env.SANDBOX, nodeId.toLowerCase()');
    expect(nodeAgent).toContain('sandbox.containerFetch(');
  });

  it('keeps the admin launcher superadmin-only and on the existing Sandbox substrate', () => {
    const route = read('routes/admin-sandbox.ts');

    expect(route).toContain("adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin())");
    expect(route).toContain("adminSandboxRoutes.post('/cf-vm-agent/start'");
    expect(route).toContain("NODE_ROLE: 'standalone'");
    expect(route).toContain("runtime: 'cf-container'");
  });
});
