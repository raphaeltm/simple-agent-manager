import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('agent sessions source contract', () => {
  const workspacesFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const nodeAgentFile = readFileSync(resolve(process.cwd(), 'src/services/node-agent.ts'), 'utf8');
  const agentWsFile = readFileSync(resolve(process.cwd(), '../../packages/vm-agent/internal/server/agent_ws.go'), 'utf8');

  it('defines session list/create/stop endpoints in control plane', () => {
    expect(workspacesFile).toContain("workspacesRoutes.get('/:id/agent-sessions'");
    expect(workspacesFile).toContain("workspacesRoutes.post('/:id/agent-sessions'");
    expect(workspacesFile).toContain("workspacesRoutes.post('/:id/agent-sessions/:sessionId/stop'");
  });

  it('passes idempotency key through to node agent create call', () => {
    expect(workspacesFile).toContain("c.req.header('Idempotency-Key')");
    expect(nodeAgentFile).toContain('idempotencyKey');
    expect(nodeAgentFile).toContain("headers.set('Idempotency-Key', options.idempotencyKey)");
  });

  it('supports session lifecycle operations on node agent client', () => {
    expect(nodeAgentFile).toContain('createAgentSessionOnNode');
    expect(nodeAgentFile).toContain('stopAgentSessionOnNode');
  });

  it('contains idempotency and concurrency guards for create-session retries', () => {
    expect(workspacesFile).toContain('existingSessionId');
    expect(workspacesFile).toContain('existingRunning.length >= limits.maxAgentSessionsPerWorkspace');
    expect(workspacesFile).toContain("c.req.header('Idempotency-Key')");
  });

  it('includes attach-stop race handling hooks in ACP websocket layer', () => {
    expect(agentWsFile).toContain('session_not_running');
    expect(agentWsFile).toContain('session_already_attached');
    expect(agentWsFile).toContain('attach/stop race handling');
  });
});
