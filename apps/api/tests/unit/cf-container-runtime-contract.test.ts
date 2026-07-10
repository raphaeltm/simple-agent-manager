import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiPackageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const apiRoot = join(apiPackageRoot, 'src');

function read(relPath: string): string {
  return readFileSync(join(apiRoot, relPath), 'utf8');
}

function readPackage(relPath: string): string {
  return readFileSync(join(apiPackageRoot, relPath), 'utf8');
}

describe('cf-container runtime spike contracts', () => {
  it('adds a non-null node runtime discriminator without changing workspace node_id', () => {
    const migration = read('db/migrations/0088_node_runtime.sql');
    const schema = read('db/schema.ts');

    expect(migration).toContain("ALTER TABLE nodes ADD COLUMN runtime TEXT NOT NULL DEFAULT 'vm'");
    expect(schema).toContain("runtime: text('runtime').notNull().default('vm')");
    expect(schema).toContain("nodeId: text('node_id').references(() => nodes.id");
  });

  it('routes cf-container workspace hostnames through the raw Container binding behind the kill switch', () => {
    const index = read('index.ts');
    const containerService = read('services/vm-agent-container.ts');

    expect(index).toContain("nodeRuntime === 'cf-container'");
    expect(index).toContain('getVmAgentContainerConfig(c.env)');
    expect(index).toContain('!c.env.VM_AGENT_CONTAINER');
    expect(index).toContain('fetchVmAgentContainer(c.env, containerId, containerRequest, vmAgentPort)');
    expect(containerService).toContain("request.headers.get('upgrade')?.toLowerCase() === 'websocket'");
    expect(containerService).toContain('return container.fetch(request)');
    expect(containerService).toContain('return container.proxyHttp(request, port)');
    expect(index).toContain("metric: 'ws_proxy_route'");
  });

  it('routes Worker-to-vm-agent service calls through raw Container for cf-container nodes only', () => {
    const nodeAgent = read('services/node-agent.ts');
    const workspaceTools = read('routes/mcp/workspace-tools.ts');
    const libraryTools = read('routes/mcp/library-tools.ts');
    const projectFiles = read('routes/projects/files.ts');
    const localForward = read('routes/workspaces/local-forward.ts');
    const nodesRoute = read('routes/nodes.ts');

    expect(nodeAgent).toContain("node?.runtime !== 'cf-container'");
    expect(nodeAgent).toContain('getVmAgentContainerConfig(env)');
    expect(nodeAgent).toContain('!env.VM_AGENT_CONTAINER');
    expect(nodeAgent).toContain('fetchVmAgentContainer(');
    expect(nodeAgent).toContain('function requestInitWithoutSignal');
    expect(nodeAgent).toContain('new Request(containerUrl.toString(), requestInitWithoutSignal(options))');
    expect(nodeAgent).toContain("return fetchNodeAgent(nodeId, env, url, { method: 'GET', headers }, timeoutMs)");
    expect(workspaceTools).toContain("import { fetchNodeAgent } from '../../services/node-agent'");
    expect(workspaceTools).toContain('fetchNodeAgent(nodeId, env, vmUrl, fetchOpts, timeoutMs)');
    expect(libraryTools).toContain("import { fetchNodeAgent } from '../../services/node-agent'");
    expect(libraryTools).toContain('fetchNodeAgent(');
    expect(projectFiles).toContain("import { fetchNodeAgent } from '../../services/node-agent'");
    expect(projectFiles).toContain('fetchNodeAgent(');
    expect(localForward).toContain(
      "import { fetchNodeAgent, getNodeAgentRequestTimeoutMs } from '../../services/node-agent'"
    );
    expect(localForward).toContain('fetchNodeAgent(');
    expect(nodesRoute).toContain('fetchNodeAgent(nodeId, c.env, vmUrl.toString()');
  });

  it('launches instant chat sessions through the authenticated start route and raw Container substrate', () => {
    const adminRoute = read('routes/admin-sandbox.ts');
    const chatStartRoute = read('routes/chat-start.ts');
    const launcher = read('services/instant-session.ts');

    expect(adminRoute).toContain("adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin())");
    expect(chatStartRoute).toContain("chatStartRoutes.post('/start', requireAuth(), requireApproved()");
    expect(chatStartRoute).toContain('resolveWorkspaceRuntime');
    expect(chatStartRoute).toContain("runtime.runtime !== 'cf-container'");
    expect(chatStartRoute).toContain('launchInstantSession');
    const containerDo = read('durable-objects/vm-agent-container.ts');
    expect(containerDo).toContain("NODE_ROLE: 'standalone'");
    expect(launcher).toContain('CF_CONTAINER_WORKSPACE_BASE_DIR');
    expect(launcher).toContain('launchVmAgentContainer(');
    expect(launcher).toContain("runContainerPhase('launch'");
    expect(launcher).not.toContain('nohup env');
    expect(launcher).toContain("runtime: 'cf-container'");
    expect(launcher).toContain('signNodeCallbackToken');
    expect(launcher).toContain('signCallbackToken');
    expect(launcher).toContain('createWorkspaceOnNode');
    expect(launcher).toContain('startSamAwareAgentSession');
    const bootstrap = read('services/agent-session-bootstrap.ts');
    expect(bootstrap).toContain('createAcpSession');
    expect(bootstrap).toContain('createAgentSessionOnNode');
    expect(bootstrap).toContain('startAgentSessionOnNode');
  });

  it('marks raw container lifecycle exits visibly instead of silently resuming', () => {
    const containerDo = read('durable-objects/vm-agent-container.ts');

    expect(containerDo).toContain('override async onStop');
    expect(containerDo).toContain("if (status === 'expired')");
    expect(containerDo).toContain('override async onError');
    expect(containerDo).toContain('override async onActivityExpired');
    expect(containerDo).toContain("Container idle timeout expired; start a new instant session.");
    expect(containerDo).toContain("return new Response('Container is stopped; create a new instant session.', { status: 410 })");
    expect(containerDo).toContain("await this.ctx.storage.put('launchConfig', config)");
    expect(containerDo).toContain('nodeCallbackToken: string');
    expect(containerDo).toContain('CALLBACK_TOKEN: secrets.nodeCallbackToken');
    expect(containerDo).toContain("status === 'stopped' ? 'stopped' : 'error'");
    expect(containerDo).not.toContain('await this.startAndWaitForPorts({\\n      ports: config.vmAgentPort,\\n      startOptions: config');
  });

  it('uses a raw vm-agent container image for PR workflows', () => {
    const dockerfile = readPackage('Dockerfile.vm-agent-container');
    const bootstrap = readPackage('container-entrypoints/vm-agent-bootstrap.sh');

    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/vm-agent-bootstrap"]');
    expect(dockerfile).toContain('githubcli-archive-keyring.gpg');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends gh');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('chown -R node:node /workspaces /var/lib/vm-agent');
    expect(bootstrap).toContain('agent_bin_dir="/var/lib/vm-agent/bin"');
    expect(bootstrap).toContain('curl -fsSL "${CONTROL_PLANE_URL}/api/agent/download?os=linux&arch=amd64" -o "$tmp"');
    expect(bootstrap).not.toContain('/usr/local/bin/vm-agent.tmp');
  });
});
