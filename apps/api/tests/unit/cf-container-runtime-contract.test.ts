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
    expect(index).toContain("headers.get('upgrade')?.toLowerCase() === 'websocket'");
    expect(index).toContain('sandbox.wsConnect(containerRequest, vmAgentPort)');
    expect(index).toContain('sandbox.containerFetch(');
    expect(index).toContain("metric: 'ws_proxy_route'");
  });

  it('routes Worker-to-vm-agent service calls through Sandbox for cf-container nodes only', () => {
    const nodeAgent = read('services/node-agent.ts');

    expect(nodeAgent).toContain("node?.runtime !== 'cf-container'");
    expect(nodeAgent).toContain("env.SANDBOX_ENABLED !== 'true'");
    expect(nodeAgent).toContain('getSandbox(env.SANDBOX, nodeId.toLowerCase()');
    expect(nodeAgent).toContain('sandbox.containerFetch(');
    expect(nodeAgent).toContain('function requestInitWithoutSignal');
    expect(nodeAgent).toContain('new Request(containerUrl.toString(), requestInitWithoutSignal(options))');
  });

  it('launches instant chat sessions through the authenticated start route and Sandbox substrate', () => {
    const adminRoute = read('routes/admin-sandbox.ts');
    const chatStartRoute = read('routes/chat-start.ts');
    const launcher = read('services/instant-session.ts');

    expect(adminRoute).toContain("adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin())");
    expect(chatStartRoute).toContain("chatStartRoutes.post('/start', requireAuth(), requireApproved()");
    expect(chatStartRoute).toContain('resolveWorkspaceRuntime');
    expect(chatStartRoute).toContain("runtime.runtime !== 'cf-container'");
    expect(chatStartRoute).toContain('launchInstantSession');
    expect(launcher).toContain("NODE_ROLE: 'standalone'");
    expect(launcher).toContain('const standaloneEnv = {');
    expect(launcher).toContain("runSandboxPhase('install'");
    expect(launcher).toContain("runSandboxPhase('start'");
    expect(launcher).toContain('nohup env ${envAssignments} /usr/local/bin/vm-agent');
    expect(launcher).toContain('/tmp/vm-agent.log');
    expect(launcher).toContain("runtime: 'cf-container'");
    expect(launcher).toContain('signNodeCallbackToken');
    expect(launcher).toContain('signCallbackToken');
    expect(launcher).toContain('createWorkspaceOnNode');
    expect(launcher).toContain('createAcpSession');
    expect(launcher).toContain('createAgentSessionOnNode');
    expect(launcher).toContain('startAgentSessionOnNode');
  });
});
