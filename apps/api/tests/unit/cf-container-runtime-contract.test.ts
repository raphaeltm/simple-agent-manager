import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import agentInstallManifest from '../../../../packages/shared/src/agent-install-manifest.json';

const apiPackageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const apiRoot = join(apiPackageRoot, 'src');

function read(relPath: string): string {
  return readFileSync(join(apiRoot, relPath), 'utf8');
}

function readPackage(relPath: string): string {
  return readFileSync(join(apiPackageRoot, relPath), 'utf8');
}

function getPinnedAgentPackage(agentType: string): string {
  const manifest = agentInstallManifest as Array<{
    agentType: string;
    package: string;
    version: string;
  }>;
  const entry = manifest.find((candidate) => candidate.agentType === agentType);
  if (!entry) {
    throw new Error(`Missing agent install manifest entry for ${agentType}`);
  }
  return `${entry.package}@${entry.version}`;
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
    expect(index).toContain(
      'fetchVmAgentContainer(c.env, containerId, containerRequest, vmAgentPort)'
    );
    expect(containerService).toContain(
      "request.headers.get('upgrade')?.toLowerCase() === 'websocket'"
    );
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
    expect(nodeAgent).toContain(
      'new Request(containerUrl.toString(), requestInitWithoutSignal(options))'
    );
    expect(nodeAgent).toContain(
      "return fetchNodeAgent(nodeId, env, url, { method: 'GET', headers }, timeoutMs)"
    );
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
    expect(nodesRoute).toMatch(/fetchNodeAgent\(\s*nodeId,\s*c\.env,\s*vmUrl\.toString\(\)/);
  });

  it('launches instant chat sessions through the authenticated start route and raw Container substrate', () => {
    const adminRoute = read('routes/admin-sandbox.ts');
    const chatStartRoute = read('routes/chat-start.ts');
    const launcher = read('services/instant-session.ts');

    expect(adminRoute).toContain(
      "adminSandboxRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin())"
    );
    expect(chatStartRoute).toContain('chatStartRoutes.post(');
    expect(chatStartRoute).toContain('requireApproved()');
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

  it('keeps active raw container prompt work alive with a bounded renewActivityTimeout loop', () => {
    const containerDo = read('durable-objects/vm-agent-container.ts');
    const activeWork = read('durable-objects/vm-agent-container-active-work.ts');
    const containerService = read('services/vm-agent-container.ts');
    const nodeAgent = read('services/node-agent.ts');
    const activityCallback = read('routes/projects/agent-activity-callback.ts');
    const acpSessionsRoute = read('routes/projects/acp-sessions.ts');

    expect(containerDo).toContain("export const DEFAULT_CF_CONTAINER_SLEEP_AFTER = '1h'");
    expect(containerService).toContain('DEFAULT_CF_CONTAINER_SLEEP_AFTER');
    expect(containerDo).toContain('DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS');
    expect(containerDo).toContain('DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS');
    expect(containerDo).toContain('async markActiveWorkStarted');
    expect(containerDo).toContain('async markActiveWorkEnded');
    expect(containerDo).toContain('async renewActiveWorkKeepalive');
    expect(containerDo).toContain('this.renewActivityTimeout()');
    expect(containerDo).toContain(
      'await this.schedule(Math.max(1, Math.ceil(delayMs / 1000)), KEEPALIVE_CALLBACK)'
    );
    expect(activeWork).toContain("endReason: 'keepalive_deadline_exceeded'");
    expect(nodeAgent).toContain('markVmAgentContainerActiveWorkStarted(env, nodeId');
    expect(nodeAgent).toContain("reason: 'start_agent_session'");
    expect(nodeAgent).toContain("reason: 'send_prompt'");
    expect(nodeAgent).toContain(
      "markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'cancel_agent_session')"
    );
    expect(nodeAgent).toMatch(
      /markVmAgentContainerActiveWorkEndedBestEffort\(\s*env,\s*nodeId,\s*'cancel_agent_session_no_prompt'\s*\)/
    );
    expect(nodeAgent).toContain(
      "markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'stop_agent_session')"
    );
    expect(activityCallback).toContain("body.activity === 'idle' || body.activity === 'error'");
    expect(acpSessionsRoute).toContain("body.status === 'completed' || body.status === 'failed'");
  });

  it('classifies raw container idle expiration as sleeping instead of crash/error', () => {
    const containerDo = read('durable-objects/vm-agent-container.ts');
    const chatResolver = read('routes/chat-workspace-resolver.ts');

    expect(containerDo).toContain('override async onStop');
    expect(containerDo).toContain("status === 'recovering'");
    expect(containerDo).toContain('override async onError');
    expect(containerDo).toContain('override async onActivityExpired');
    expect(containerDo).toContain(
      "await this.markRuntimeSleeping('Container idle timeout expired; container is sleeping.')"
    );
    expect(containerDo).toContain(
      "await this.ctx.storage.put('lifecycleStatus', 'sleeping' satisfies LifecycleStatus)"
    );
    expect(containerDo).toContain("| 'sleeping'");
    expect(containerDo).toContain("status === 'sleeping' ? 'idle' : 'error'");
    expect(containerDo).toContain('return this.ensureAwake()');
    expect(containerDo).toContain('RUNTIME_RECOVERY_DEGRADED_MESSAGE');
    expect(containerDo).toContain(
      "await this.ctx.storage.put('lifecycleStatus', 'launching' satisfies LifecycleStatus)"
    );
    expect(containerDo).toContain(
      "await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus)"
    );
    expect(chatResolver).toContain(
      "inArray(schema.workspaces.status, ['running', 'recovery', 'sleeping'])"
    );
    expect(chatResolver).toContain(
      "['running', 'sleeping', 'recovery', 'error'].includes(workspace.nodeStatus)"
    );
    expect(chatResolver).toContain('inArray(schema.agentSessions.status, agentStatuses)');
    expect(chatResolver).not.toContain('The workspace container is asleep.');
    expect(containerDo).toContain('RUNTIME_STOPPED_MESSAGE');
    expect(containerDo).toContain("await this.ctx.storage.put('launchConfig', config)");
    expect(containerDo).toContain('nodeCallbackToken: string');
    expect(containerDo).toContain('CALLBACK_TOKEN: secrets.nodeCallbackToken');
    expect(containerDo).toContain('persistRuntimeEnded(this.env, config, status, message)');
    expect(containerDo).not.toContain(
      'Container idle timeout expired; start a new instant session.'
    );
    expect(containerDo).not.toContain("await this.markRuntimeEnded('expired'");
    expect(containerDo).not.toContain(
      'await this.startAndWaitForPorts({\\n      ports: config.vmAgentPort,\\n      startOptions: config'
    );
  });

  it('uses a raw vm-agent container image for PR workflows', () => {
    const dockerfile = readPackage('Dockerfile.vm-agent-container');
    const bootstrap = readPackage('container-entrypoints/vm-agent-bootstrap.sh');
    const codexACPWrapperPackage = getPinnedAgentPackage('openai-codex');

    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/vm-agent-bootstrap"]');
    expect(dockerfile).toContain(
      'COPY container-artifacts/vm-agent-linux-amd64 /usr/local/bin/vm-agent'
    );
    expect(dockerfile).toContain(
      'COPY container-artifacts/vm-agent-version.json /etc/sam/vm-agent-version.json'
    );
    expect(dockerfile).toContain('githubcli-archive-keyring.gpg');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends gh');
    expect(dockerfile).toContain(codexACPWrapperPackage);
    const vmGateway = readFileSync(
      join(apiPackageRoot, '../../packages/vm-agent/internal/acp/gateway.go'),
      'utf8'
    );
    expect(vmGateway).toContain(`npm install -g ${codexACPWrapperPackage}`);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('chown -R node:node /workspaces /var/lib/vm-agent');
    expect(bootstrap).toContain('agent_bin="${VM_AGENT_BIN:-/usr/local/bin/vm-agent}"');
    expect(bootstrap).toContain('vm_agent_container_bootstrap_ready');
    expect(bootstrap).toContain('baked_artifact_missing');
    expect(bootstrap).not.toContain('/api/agent/download');
    expect(bootstrap).not.toContain('curl ');
  });

  it('bakes no secrets into the container image (no ARG or secret-bearing ENV)', () => {
    const dockerfile = readPackage('Dockerfile.vm-agent-container');

    // Build args and env layers are the two Docker primitives that embed secrets
    // in image layers. The runtime-asset boundary requires neither.
    expect(dockerfile).not.toMatch(/\nARG /);
    expect(dockerfile).not.toMatch(/\nENV .*(TOKEN|KEY|SECRET|CREDENTIAL|CALLBACK|PASSWORD)/i);
    expect(dockerfile).not.toContain('--build-arg');
    // The image must not reference user/project/profile/skill runtime values.
    expect(dockerfile).not.toContain('CALLBACK_TOKEN');
  });

  it('bakes only build-metadata (version/buildDate/sha256) into vm-agent-version.json', () => {
    const makefile = readFileSync(join(apiPackageRoot, '../../packages/vm-agent/Makefile'), 'utf8');

    // The version file the bootstrap emits as telemetry must contain only
    // non-secret build metadata keys.
    expect(makefile).toContain(
      `printf '{"version":"%s","buildDate":"%s","sha256":"sha256:%s"}\\n'`
    );
    for (const secretKey of ['token', 'credential', 'secret', 'callback', 'apiKey']) {
      expect(makefile).not.toContain(`"${secretKey}"`);
    }
  });
});
