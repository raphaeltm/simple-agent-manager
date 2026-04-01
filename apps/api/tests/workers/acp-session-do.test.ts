/**
 * Integration tests for ACP Session Lifecycle (Spec 027).
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 *
 * BLOCKED: These tests cannot run due to a pre-existing Mastra/workerd
 * incompatibility ("No such module" for @mastra/core/dist/fs/promises).
 * Same issue blocks existing project-data-do.test.ts.
 *
 * DOCUMENTED COVERAGE GAPS (to add when workerd issue is resolved):
 * - alarm() / checkHeartbeatTimeouts: stale session → interrupted transition
 * - listAcpSessionsByNode: reconciliation filtering by node + statuses
 * - forkAcpSession: max depth rejection, fork from failed session
 * - updateHeartbeat: silent ignore for terminal sessions
 * - transitionAcpSession: nonexistent session error
 * - listAcpSessions: chatSessionId filter, pagination, total count
 */
import { env } from 'cloudflare:test';
import { describe, expect,it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

/** Helper: create a chat session + ACP session in one step */
async function createSessionPair(
  stub: DurableObjectStub<ProjectData>,
  opts?: { agentType?: string; initialPrompt?: string }
) {
  const chatSessionId = await stub.createSession(null, 'Test topic');
  const acpSession = await stub.createAcpSession({
    chatSessionId,
    initialPrompt: opts?.initialPrompt ?? 'Do the thing',
    agentType: opts?.agentType ?? 'claude-code',
  });
  return { chatSessionId, acpSession };
}

describe('ACP Session Lifecycle (Spec 027)', () => {
  // =========================================================================
  // Creation
  // =========================================================================

  describe('createAcpSession', () => {
    it('creates a session in pending state', async () => {
      const stub = getStub('acp-create-test');
      const { acpSession, chatSessionId } = await createSessionPair(stub);

      expect(acpSession.id).toBeTruthy();
      expect(acpSession.chatSessionId).toBe(chatSessionId);
      expect(acpSession.status).toBe('pending');
      expect(acpSession.agentType).toBe('claude-code');
      expect(acpSession.initialPrompt).toBe('Do the thing');
      expect(acpSession.forkDepth).toBe(0);
      expect(acpSession.parentSessionId).toBeNull();
      expect(acpSession.workspaceId).toBeNull();
      expect(acpSession.nodeId).toBeNull();
    });

    it('rejects creation with invalid chat session ID', async () => {
      const stub = getStub('acp-create-invalid');
      await expect(
        stub.createAcpSession({
          chatSessionId: 'nonexistent',
          initialPrompt: 'test',
          agentType: null,
        })
      ).rejects.toThrow('Chat session nonexistent not found');
    });
  });

  // =========================================================================
  // State Machine Transitions
  // =========================================================================

  describe('transitionAcpSession — valid transitions', () => {
    it('pending → assigned', async () => {
      const stub = getStub('acp-trans-assign');
      const { acpSession } = await createSessionPair(stub);

      const assigned = await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-1',
        nodeId: 'node-1',
      });

      expect(assigned.status).toBe('assigned');
      expect(assigned.workspaceId).toBe('ws-1');
      expect(assigned.nodeId).toBe('node-1');
      expect(assigned.assignedAt).toBeTruthy();
      expect(assigned.lastHeartbeatAt).toBeTruthy();
    });

    it('assigned → running', async () => {
      const stub = getStub('acp-trans-running');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-2',
        nodeId: 'node-2',
      });

      const running = await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        actorId: 'node-2',
        acpSdkSessionId: 'acp-sdk-123',
      });

      expect(running.status).toBe('running');
      expect(running.acpSdkSessionId).toBe('acp-sdk-123');
      expect(running.startedAt).toBeTruthy();
    });

    it('running → completed', async () => {
      const stub = getStub('acp-trans-completed');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-3',
        nodeId: 'node-3',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'acp-sdk-456',
      });

      const completed = await stub.transitionAcpSession(acpSession.id, 'completed', {
        actorType: 'vm-agent',
        actorId: 'node-3',
        reason: 'Agent finished',
      });

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeTruthy();
    });

    it('running → failed (with error message)', async () => {
      const stub = getStub('acp-trans-failed');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-4',
        nodeId: 'node-4',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'acp-sdk-789',
      });

      const failed = await stub.transitionAcpSession(acpSession.id, 'failed', {
        actorType: 'vm-agent',
        actorId: 'node-4',
        errorMessage: 'Process crashed',
      });

      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toBe('Process crashed');
      expect(failed.completedAt).toBeTruthy();
    });

    it('running → interrupted', async () => {
      const stub = getStub('acp-trans-interrupted');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-5',
        nodeId: 'node-5',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'acp-sdk-000',
      });

      const interrupted = await stub.transitionAcpSession(acpSession.id, 'interrupted', {
        actorType: 'alarm',
        reason: 'Heartbeat timeout exceeded detection window',
      });

      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.interruptedAt).toBeTruthy();
    });

    it('assigned → failed', async () => {
      const stub = getStub('acp-trans-assigned-failed');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-6',
        nodeId: 'node-6',
      });

      const failed = await stub.transitionAcpSession(acpSession.id, 'failed', {
        actorType: 'vm-agent',
        errorMessage: 'Cannot reach control plane',
      });

      expect(failed.status).toBe('failed');
    });

    it('assigned → interrupted', async () => {
      const stub = getStub('acp-trans-assigned-interrupted');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-7',
        nodeId: 'node-7',
      });

      const interrupted = await stub.transitionAcpSession(acpSession.id, 'interrupted', {
        actorType: 'alarm',
        reason: 'Node destroyed',
      });

      expect(interrupted.status).toBe('interrupted');
    });
  });

  describe('transitionAcpSession — invalid transitions', () => {
    it('rejects pending → running (must go through assigned)', async () => {
      const stub = getStub('acp-invalid-pending-running');
      const { acpSession } = await createSessionPair(stub);

      await expect(
        stub.transitionAcpSession(acpSession.id, 'running', {
          actorType: 'vm-agent',
        })
      ).rejects.toThrow('Invalid ACP session transition: pending → running');
    });

    it('rejects completed → running (terminal state)', async () => {
      const stub = getStub('acp-invalid-completed-running');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-inv',
        nodeId: 'node-inv',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-inv',
      });
      await stub.transitionAcpSession(acpSession.id, 'completed', {
        actorType: 'vm-agent',
      });

      await expect(
        stub.transitionAcpSession(acpSession.id, 'running', {
          actorType: 'vm-agent',
        })
      ).rejects.toThrow('Invalid ACP session transition: completed → running');
    });

    it('rejects running → assigned (no backward transitions)', async () => {
      const stub = getStub('acp-invalid-running-assigned');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-back',
        nodeId: 'node-back',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-back',
      });

      await expect(
        stub.transitionAcpSession(acpSession.id, 'assigned', {
          actorType: 'system',
        })
      ).rejects.toThrow('Invalid ACP session transition: running → assigned');
    });
  });

  // =========================================================================
  // Heartbeat
  // =========================================================================

  describe('updateHeartbeat', () => {
    it('updates heartbeat timestamp for assigned session', async () => {
      const stub = getStub('acp-heartbeat-test');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-hb',
        nodeId: 'node-hb',
      });

      await stub.updateHeartbeat(acpSession.id, 'node-hb');

      const updated = await stub.getAcpSession(acpSession.id);
      expect(updated).not.toBeNull();
      expect(updated!.lastHeartbeatAt).toBeTruthy();
    });

    it('rejects heartbeat from wrong node', async () => {
      const stub = getStub('acp-heartbeat-wrong-node');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-hb2',
        nodeId: 'node-hb2',
      });

      await expect(
        stub.updateHeartbeat(acpSession.id, 'wrong-node')
      ).rejects.toThrow('Node mismatch');
    });
  });

  // =========================================================================
  // Forking
  // =========================================================================

  describe('forkAcpSession', () => {
    it('forks a completed session with correct lineage', async () => {
      const stub = getStub('acp-fork-test');
      const { acpSession } = await createSessionPair(stub);

      // Move to completed
      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-fork',
        nodeId: 'node-fork',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-fork',
      });
      await stub.transitionAcpSession(acpSession.id, 'completed', {
        actorType: 'vm-agent',
      });

      const forked = await stub.forkAcpSession(acpSession.id, 'Context from previous session...');

      expect(forked.status).toBe('pending');
      expect(forked.parentSessionId).toBe(acpSession.id);
      expect(forked.forkDepth).toBe(1);
      expect(forked.initialPrompt).toBe('Context from previous session...');
      expect(forked.chatSessionId).toBe(acpSession.chatSessionId);
    });

    it('rejects forking a running session', async () => {
      const stub = getStub('acp-fork-running');
      const { acpSession } = await createSessionPair(stub);

      await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-fr',
        nodeId: 'node-fr',
      });
      await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-fr',
      });

      await expect(
        stub.forkAcpSession(acpSession.id, 'Context')
      ).rejects.toThrow('Cannot fork session in "running" state');
    });
  });

  // =========================================================================
  // Lineage
  // =========================================================================

  describe('getAcpSessionLineage', () => {
    it('returns full lineage tree', async () => {
      const stub = getStub('acp-lineage-test');
      const { acpSession: root } = await createSessionPair(stub);

      // Complete the root
      await stub.transitionAcpSession(root.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-lin',
        nodeId: 'node-lin',
      });
      await stub.transitionAcpSession(root.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-lin',
      });
      await stub.transitionAcpSession(root.id, 'completed', {
        actorType: 'vm-agent',
      });

      // Fork once
      const child = await stub.forkAcpSession(root.id, 'Fork 1 context');

      // Complete child and fork again
      await stub.transitionAcpSession(child.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-lin2',
        nodeId: 'node-lin2',
      });
      await stub.transitionAcpSession(child.id, 'running', {
        actorType: 'vm-agent',
        acpSdkSessionId: 'sdk-lin2',
      });
      await stub.transitionAcpSession(child.id, 'interrupted', {
        actorType: 'alarm',
      });

      const grandchild = await stub.forkAcpSession(child.id, 'Fork 2 context');

      // Query lineage from any node
      const lineage = await stub.getAcpSessionLineage(grandchild.id);

      expect(lineage).toHaveLength(3);
      expect(lineage[0].id).toBe(root.id);
      expect(lineage[0].forkDepth).toBe(0);
      expect(lineage[1].id).toBe(child.id);
      expect(lineage[1].forkDepth).toBe(1);
      expect(lineage[2].id).toBe(grandchild.id);
      expect(lineage[2].forkDepth).toBe(2);
    });
  });

  // =========================================================================
  // Query
  // =========================================================================

  describe('listAcpSessions', () => {
    it('lists sessions filtered by status', async () => {
      const stub = getStub('acp-list-test');
      const { acpSession: s1 } = await createSessionPair(stub);
      const { acpSession: s2 } = await createSessionPair(stub);

      await stub.transitionAcpSession(s1.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-list1',
        nodeId: 'node-list1',
      });

      const pending = await stub.listAcpSessions({ status: 'pending' });
      const assigned = await stub.listAcpSessions({ status: 'assigned' });

      expect(pending.sessions).toHaveLength(1);
      expect(pending.sessions[0].id).toBe(s2.id);
      expect(assigned.sessions).toHaveLength(1);
      expect(assigned.sessions[0].id).toBe(s1.id);
    });
  });

  // =========================================================================
  // Capability Test: Full Lifecycle
  // =========================================================================

  describe('capability: full ACP session lifecycle', () => {
    it('exercises complete happy path: create → assign → run → complete → fork', async () => {
      const stub = getStub('acp-capability-test');

      // 1. Create chat session + ACP session
      const chatSessionId = await stub.createSession(null, 'Capability test');
      const acpSession = await stub.createAcpSession({
        chatSessionId,
        initialPrompt: 'Build the feature',
        agentType: 'claude-code',
      });
      expect(acpSession.status).toBe('pending');

      // 2. Assign workspace and node
      const assigned = await stub.transitionAcpSession(acpSession.id, 'assigned', {
        actorType: 'system',
        workspaceId: 'ws-cap',
        nodeId: 'node-cap',
      });
      expect(assigned.status).toBe('assigned');
      expect(assigned.workspaceId).toBe('ws-cap');

      // 3. VM agent starts — report running
      const running = await stub.transitionAcpSession(acpSession.id, 'running', {
        actorType: 'vm-agent',
        actorId: 'node-cap',
        acpSdkSessionId: 'acp-sdk-cap',
      });
      expect(running.status).toBe('running');

      // 4. Heartbeat
      await stub.updateHeartbeat(acpSession.id, 'node-cap');
      const afterHeartbeat = await stub.getAcpSession(acpSession.id);
      expect(afterHeartbeat!.lastHeartbeatAt).toBeGreaterThan(0);

      // 5. Agent completes
      const completed = await stub.transitionAcpSession(acpSession.id, 'completed', {
        actorType: 'vm-agent',
        actorId: 'node-cap',
        reason: 'Task finished',
      });
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeTruthy();

      // 6. Fork the completed session
      const forked = await stub.forkAcpSession(
        acpSession.id,
        'Continue from where we left off'
      );
      expect(forked.status).toBe('pending');
      expect(forked.parentSessionId).toBe(acpSession.id);
      expect(forked.forkDepth).toBe(1);

      // 7. Verify lineage
      const lineage = await stub.getAcpSessionLineage(forked.id);
      expect(lineage).toHaveLength(2);
      expect(lineage[0].id).toBe(acpSession.id);
      expect(lineage[1].id).toBe(forked.id);
    });
  });
});
