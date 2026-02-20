import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('agent sessions source contract', () => {
  const workspacesFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces.ts'), 'utf8');
  const nodeAgentFile = readFileSync(resolve(process.cwd(), 'src/services/node-agent.ts'), 'utf8');
  const agentWsFile = readFileSync(resolve(process.cwd(), '../../packages/vm-agent/internal/server/agent_ws.go'), 'utf8');

  it('defines session list/create/stop/resume endpoints in control plane', () => {
    expect(workspacesFile).toContain("workspacesRoutes.get('/:id/agent-sessions'");
    expect(workspacesFile).toContain("workspacesRoutes.post('/:id/agent-sessions'");
    expect(workspacesFile).toContain("workspacesRoutes.post('/:id/agent-sessions/:sessionId/stop'");
    expect(workspacesFile).toContain("workspacesRoutes.post('/:id/agent-sessions/:sessionId/resume'");
  });

  it('supports session lifecycle operations on node agent client', () => {
    expect(nodeAgentFile).toContain('createAgentSessionOnNode');
    expect(nodeAgentFile).toContain('stopAgentSessionOnNode');
  });

  it('contains concurrency guards for create-session requests', () => {
    expect(workspacesFile).toContain('existingRunning.length >= limits.maxAgentSessionsPerWorkspace');
  });

  it('stop endpoint attempts VM stop for non-running sessions (orphan cleanup)', () => {
    // The stop handler should still call stopAgentSessionOnNode even when
    // session.status !== 'running', to kill orphaned processes on the VM.
    const stopBlock = workspacesFile.slice(
      workspacesFile.indexOf("agent-sessions/:sessionId/stop'"),
      workspacesFile.indexOf("agent-sessions/:sessionId/resume'")
    );
    expect(stopBlock).toContain("if (session.status !== 'running')");
    expect(stopBlock).toContain('stopAgentSessionOnNode');
  });

  it('includes race handling and multi-viewer hooks in ACP websocket layer', () => {
    expect(agentWsFile).toContain('session_not_running');
    expect(agentWsFile).toContain('Post-upgrade race check');
    expect(agentWsFile).toContain('SessionHost');
    expect(agentWsFile).toContain('DetachViewer');
  });
});
