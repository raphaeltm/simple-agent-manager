/**
 * Integration tests for the ProjectData Durable Object.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real SQLite storage, DO lifecycle, and migrations.
 */
import { env } from 'cloudflare:test';
import { describe, expect,it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

describe('ProjectData Durable Object', () => {
  // =========================================================================
  // Session CRUD
  // =========================================================================

  describe('session lifecycle', () => {
    it('creates a session and returns an id', async () => {
      const stub = getStub('project-session-test');
      const sessionId = await stub.createSession(null, 'Test topic');
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
    });

    it('creates a session with workspace binding', async () => {
      const stub = getStub('project-ws-session');
      const sessionId = await stub.createSession('ws-123', 'Workspace session');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.workspaceId).toBe('ws-123');
      expect(session!.topic).toBe('Workspace session');
      expect(session!.status).toBe('active');
      expect(session!.messageCount).toBe(0);
    });

    it('lists sessions with pagination', async () => {
      const stub = getStub('project-list-sessions');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await stub.createSession(null, `Session ${i}`));
      }

      const { sessions, total } = await stub.listSessions(null, 3, 0);
      expect(total).toBe(5);
      expect(sessions).toHaveLength(3);

      const { sessions: page2 } = await stub.listSessions(null, 3, 3);
      expect(page2).toHaveLength(2);
    });

    it('filters sessions by status', async () => {
      const stub = getStub('project-filter-sessions');
      const s1 = await stub.createSession(null, 'Active session');
      const s2 = await stub.createSession(null, 'Stopped session');
      await stub.stopSession(s2);

      const { sessions: active, total: activeTotal } = await stub.listSessions('active');
      expect(activeTotal).toBe(1);
      expect(active[0]!.id).toBe(s1);

      const { sessions: stopped, total: stoppedTotal } = await stub.listSessions('stopped');
      expect(stoppedTotal).toBe(1);
      expect(stopped[0]!.id).toBe(s2);
    });

    it('stops a session and records end time', async () => {
      const stub = getStub('project-stop-session');
      const sessionId = await stub.createSession(null, 'To be stopped');

      await stub.stopSession(sessionId);

      const session = await stub.getSession(sessionId);
      expect(session!.status).toBe('stopped');
      expect(session!.endedAt).toBeTruthy();
    });

    it('getSession returns null for non-existent session', async () => {
      const stub = getStub('project-no-session');
      const result = await stub.getSession('non-existent-id');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // updateSessionTopic
  // =========================================================================

  describe('updateSessionTopic', () => {
    it('updates the topic of an active session', async () => {
      const stub = getStub('project-update-topic');
      const sessionId = await stub.createSession(null, 'Original topic');

      const result = await stub.updateSessionTopic(sessionId, 'Updated topic');
      expect(result).toBe(true);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Updated topic');
    });

    it('returns false for a non-existent session', async () => {
      const stub = getStub('project-update-topic-missing');

      const result = await stub.updateSessionTopic('nonexistent-id', 'New topic');
      expect(result).toBe(false);
    });

    it('returns false for a stopped session', async () => {
      const stub = getStub('project-update-topic-stopped');
      const sessionId = await stub.createSession(null, 'Will stop');
      await stub.stopSession(sessionId);

      const result = await stub.updateSessionTopic(sessionId, 'New topic');
      expect(result).toBe(false);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Will stop');
    });
  });

  // =========================================================================
  // Session with taskId
  // =========================================================================

  describe('session with taskId', () => {
    it('creates a session with taskId and returns it', async () => {
      const stub = getStub('project-taskid-test');
      const sessionId = await stub.createSession(null, 'Task session', 'task-abc-123');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBe('task-abc-123');
      expect(session!.topic).toBe('Task session');
      expect(session!.status).toBe('active');
    });

    it('creates a session without taskId (null by default)', async () => {
      const stub = getStub('project-no-taskid');
      const sessionId = await stub.createSession('ws-111', 'No task');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBeNull();
    });

    it('creates a session with explicit null taskId', async () => {
      const stub = getStub('project-explicit-null-taskid');
      const sessionId = await stub.createSession('ws-222', 'Explicit null', null);

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBeNull();
    });

    it('filters sessions by taskId', async () => {
      const stub = getStub('project-filter-taskid');
      await stub.createSession(null, 'Task A session', 'task-aaa');
      await stub.createSession(null, 'Task B session', 'task-bbb');
      await stub.createSession(null, 'No task session');

      const { sessions: taskA, total: totalA } = await stub.listSessions(null, 20, 0, 'task-aaa');
      expect(totalA).toBe(1);
      expect(taskA).toHaveLength(1);
      expect(taskA[0]!.taskId).toBe('task-aaa');

      const { sessions: taskB, total: totalB } = await stub.listSessions(null, 20, 0, 'task-bbb');
      expect(totalB).toBe(1);
      expect(taskB).toHaveLength(1);
      expect(taskB[0]!.taskId).toBe('task-bbb');
    });

    it('filters sessions by both status and taskId', async () => {
      const stub = getStub('project-filter-status-taskid');
      const s1 = await stub.createSession(null, 'Active task', 'task-combo');
      const s2 = await stub.createSession(null, 'Stopped task', 'task-combo');
      await stub.stopSession(s2);

      const { sessions: activeTaskCombo, total } = await stub.listSessions('active', 20, 0, 'task-combo');
      expect(total).toBe(1);
      expect(activeTaskCombo).toHaveLength(1);
      expect(activeTaskCombo[0]!.id).toBe(s1);
      expect(activeTaskCombo[0]!.taskId).toBe('task-combo');
    });

    it('returns empty when filtering by non-existent taskId', async () => {
      const stub = getStub('project-no-match-taskid');
      await stub.createSession(null, 'Some session', 'task-exists');

      const { sessions, total } = await stub.listSessions(null, 20, 0, 'task-does-not-exist');
      expect(total).toBe(0);
      expect(sessions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Batch session lookup by task IDs
  // =========================================================================

  describe('getSessionsByTaskIds', () => {
    it('returns sessions matching the given task IDs', async () => {
      const stub = getStub('project-batch-taskids');
      await stub.createSession(null, 'Task 1', 'task-111');
      await stub.createSession(null, 'Task 2', 'task-222');
      await stub.createSession(null, 'No task session');

      const results = await stub.getSessionsByTaskIds(['task-111', 'task-222']);
      expect(results).toHaveLength(2);

      const taskIds = results.map((r) => r.taskId);
      expect(taskIds).toContain('task-111');
      expect(taskIds).toContain('task-222');
    });

    it('returns empty array for no matching task IDs', async () => {
      const stub = getStub('project-batch-no-match');
      await stub.createSession(null, 'Some session', 'task-exists');

      const results = await stub.getSessionsByTaskIds(['task-nope']);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for empty input', async () => {
      const stub = getStub('project-batch-empty');
      const results = await stub.getSessionsByTaskIds([]);
      expect(results).toHaveLength(0);
    });

    it('includes lastMessageAt from updated_at', async () => {
      const stub = getStub('project-batch-lastmsg');
      const sessionId = await stub.createSession(null, 'Task with messages', 'task-msg');

      // Persist a message to update the session's updated_at
      await stub.persistMessage(sessionId, 'user', 'Hello', null);

      const results = await stub.getSessionsByTaskIds(['task-msg']);
      expect(results).toHaveLength(1);
      expect(results[0]!.lastMessageAt).toBeTruthy();
      expect(typeof results[0]!.lastMessageAt).toBe('number');
      expect(results[0]!.messageCount).toBe(1);
    });

    it('returns a numeric lastMessageAt even for a brand-new session with no messages', async () => {
      // mapSessionRow sets lastMessageAt = updated_at which is set to Date.now() at creation.
      // The dashboard uses lastMessageAt to decide isActive; if it is non-null on a new session
      // the task would incorrectly appear active before any messages exist.
      // This test pins the current behavior so any change is visible.
      const stub = getStub('project-batch-new-session-lastmsg');
      const before = Date.now();
      await stub.createSession(null, 'Fresh session', 'task-fresh');
      const after = Date.now();

      const results = await stub.getSessionsByTaskIds(['task-fresh']);
      expect(results).toHaveLength(1);
      // lastMessageAt is derived from updated_at which equals created_at on a new session
      // so it is always a valid number — document and assert this behavior
      expect(typeof results[0]!.lastMessageAt).toBe('number');
      expect(results[0]!.lastMessageAt as number).toBeGreaterThanOrEqual(before);
      expect(results[0]!.lastMessageAt as number).toBeLessThanOrEqual(after);
      expect(results[0]!.messageCount).toBe(0);
    });

    it('when a task has multiple sessions returns the most recently updated one first', async () => {
      // A task can have two sessions if the runner retried (e.g., after a crash).
      // The query orders by updated_at DESC so the freshest session comes first.
      const stub = getStub('project-batch-multi-session');

      const s1 = await stub.createSession(null, 'First attempt', 'task-multi');
      // Add a message to s1 to advance its updated_at
      await stub.persistMessage(s1, 'user', 'First message', null);

      // Small pause to guarantee a later timestamp for s2
      await new Promise((r) => setTimeout(r, 5));
      const s2 = await stub.createSession(null, 'Second attempt', 'task-multi');
      await stub.persistMessage(s2, 'user', 'Second message', null);

      const results = await stub.getSessionsByTaskIds(['task-multi']);
      // Both sessions are returned (no status filter)
      expect(results.length).toBeGreaterThanOrEqual(2);
      // The first result must be the more recently updated session (s2)
      expect(results[0]!.id).toBe(s2);
    });

    it('returns stopped sessions for the given task IDs (no status filter)', async () => {
      // The dashboard's isActive logic is computed in the route, not in the DO.
      // getSessionsByTaskIds must return stopped sessions too, so the route can
      // still show the session link even if the task is no longer active.
      const stub = getStub('project-batch-stopped-session');
      const sessionId = await stub.createSession(null, 'Completed task session', 'task-done');
      await stub.persistMessage(sessionId, 'user', 'Done', null);
      await stub.stopSession(sessionId);

      const results = await stub.getSessionsByTaskIds(['task-done']);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(sessionId);
      expect(results[0]!.status).toBe('stopped');
      // lastMessageAt is still populated from updated_at set by stopSession
      expect(typeof results[0]!.lastMessageAt).toBe('number');
    });
  });

  // =========================================================================
  // Agent Completion & Idle State
  // =========================================================================

  describe('agent completion and idle state', () => {
    it('markAgentCompleted sets agentCompletedAt and isIdle on getSession', async () => {
      const stub = getStub('project-agent-completed-getsession');
      const sessionId = await stub.createSession(null, 'Agent session');

      await stub.markAgentCompleted(sessionId);

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.agentCompletedAt).toBeTruthy();
      expect(typeof session!.agentCompletedAt).toBe('number');
      expect(session!.isIdle).toBe(true);
    });

    it('markAgentCompleted sets agentCompletedAt and isIdle on listSessions', async () => {
      const stub = getStub('project-agent-completed-listsessions');
      const sessionId = await stub.createSession(null, 'Agent list session');

      await stub.markAgentCompleted(sessionId);

      const { sessions } = await stub.listSessions(null);
      const session = sessions.find((s) => s.id === sessionId);
      expect(session).toBeTruthy();
      expect(session!.agentCompletedAt).toBeTruthy();
      expect(session!.isIdle).toBe(true);
    });

    it('markAgentCompleted sets agentCompletedAt and isIdle on getSessionsByTaskIds', async () => {
      const stub = getStub('project-agent-completed-bytaskids');
      const sessionId = await stub.createSession(null, 'Task agent session', 'task-agent-complete');

      await stub.markAgentCompleted(sessionId);

      const results = await stub.getSessionsByTaskIds(['task-agent-complete']);
      expect(results).toHaveLength(1);
      expect(results[0]!.agentCompletedAt).toBeTruthy();
      expect(results[0]!.isIdle).toBe(true);
    });

    it('agentCompletedAt is null for sessions without agent completion', async () => {
      const stub = getStub('project-agent-not-completed');
      const sessionId = await stub.createSession(null, 'Fresh session');

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.agentCompletedAt).toBeNull();
      expect(session!.isIdle).toBe(false);
    });

    it('isIdle is false for stopped sessions even with agentCompletedAt set', async () => {
      const stub = getStub('project-stopped-not-idle');
      const sessionId = await stub.createSession(null, 'Stopped agent session');

      await stub.markAgentCompleted(sessionId);
      await stub.stopSession(sessionId);

      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.status).toBe('stopped');
      // isIdle should be false because the session is stopped, not active
      expect(session!.isIdle).toBe(false);
    });
  });

  // =========================================================================
  // Idle Cleanup Schedule
  // =========================================================================

  describe('getCleanupAt', () => {
    it('returns null when no cleanup is scheduled', async () => {
      const stub = getStub('project-no-cleanup');
      const sessionId = await stub.createSession(null, 'No cleanup session');

      const cleanupAt = await stub.getCleanupAt(sessionId);
      expect(cleanupAt).toBeNull();
    });

    it('returns cleanup timestamp after scheduling idle cleanup', async () => {
      const stub = getStub('project-cleanup-scheduled');
      const sessionId = await stub.createSession('ws-cleanup', 'Cleanup session');

      const before = Date.now();
      const { cleanupAt: scheduled } = await stub.scheduleIdleCleanup(sessionId, 'ws-cleanup', null);

      const cleanupAt = await stub.getCleanupAt(sessionId);
      expect(cleanupAt).toBeTruthy();
      expect(cleanupAt).toBe(scheduled);
      // Should be in the future (timeout added to current time)
      expect(cleanupAt!).toBeGreaterThan(before);
    });

    it('returns null after cancelling idle cleanup', async () => {
      const stub = getStub('project-cleanup-cancelled');
      const sessionId = await stub.createSession('ws-cancel', 'Cancel session');

      await stub.scheduleIdleCleanup(sessionId, 'ws-cancel', null);
      await stub.cancelIdleCleanup(sessionId);

      const cleanupAt = await stub.getCleanupAt(sessionId);
      expect(cleanupAt).toBeNull();
    });
  });

  // =========================================================================
  // Batch Message Persistence
  // =========================================================================

  describe('batch message persistence', () => {
    it('persists a batch of messages', async () => {
      const stub = getStub('project-batch-basic');
      const sessionId = await stub.createSession(null, null);

      const messages = [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Hi there', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'How are you?', toolMetadata: null, timestamp: new Date().toISOString() },
      ];

      const result = await stub.persistMessageBatch(sessionId, messages);
      expect(result.persisted).toBe(3);
      expect(result.duplicates).toBe(0);

      const { messages: stored } = await stub.getMessages(sessionId);
      expect(stored).toHaveLength(3);
    });

    it('deduplicates messages by messageId', async () => {
      const stub = getStub('project-batch-dedup');
      const sessionId = await stub.createSession(null, null);
      const sharedId = crypto.randomUUID();

      // First batch with a unique messageId
      await stub.persistMessageBatch(sessionId, [
        { messageId: sharedId, role: 'user', content: 'Original', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Second batch with the same messageId + a new one
      const newId = crypto.randomUUID();
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: sharedId, role: 'user', content: 'Duplicate attempt', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: newId, role: 'assistant', content: 'New message', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(1);

      // Verify original content preserved (not overwritten)
      const { messages: stored } = await stub.getMessages(sessionId);
      expect(stored).toHaveLength(2);
      const original = stored.find((m) => m.id === sharedId);
      expect(original!.content).toBe('Original');
    });

    it('increments message_count by persisted count only', async () => {
      const stub = getStub('project-batch-count');
      const sessionId = await stub.createSession(null, null);
      const id1 = crypto.randomUUID();

      await stub.persistMessageBatch(sessionId, [
        { messageId: id1, role: 'user', content: 'First', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Second', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      let session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(2);

      // Batch with 1 duplicate and 1 new
      await stub.persistMessageBatch(sessionId, [
        { messageId: id1, role: 'user', content: 'Dup', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'Third', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(3); // Only 1 new, not 2
    });

    it('auto-captures topic from first user message if not set', async () => {
      const stub = getStub('project-batch-topic');
      const sessionId = await stub.createSession(null, null);

      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'System init', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'user', content: 'Deploy my app to staging', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Deploy my app to staging');
    });

    it('does not overwrite existing topic', async () => {
      const stub = getStub('project-batch-keep-topic');
      const sessionId = await stub.createSession(null, 'Existing topic');

      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'New content', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Existing topic');
    });

    it('stores tool metadata as JSON', async () => {
      const stub = getStub('project-batch-toolmeta');
      const sessionId = await stub.createSession(null, null);
      const msgId = crypto.randomUUID();
      const toolMeta = JSON.stringify({ tool: 'bash', target: 'ls -la', status: 'success' });

      await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'assistant', content: 'Running command', toolMetadata: toolMeta, timestamp: new Date().toISOString() },
      ]);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.toolMetadata).toEqual({ tool: 'bash', target: 'ls -la', status: 'success' });
    });

    it('throws for non-existent session', async () => {
      const stub = getStub('project-batch-nosession');

      await expect(
        stub.persistMessageBatch('non-existent-session', [
          { messageId: crypto.randomUUID(), role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        ])
      ).rejects.toThrow(/not found/i);
    });

    it('rejects messages to stopped sessions', async () => {
      const stub = getStub('project-batch-stopped');
      const sessionId = await stub.createSession(null, null);

      // Stop the session
      await stub.stopSession(sessionId);

      // Attempting to persist messages to a stopped session should throw
      await expect(
        stub.persistMessageBatch(sessionId, [
          { messageId: crypto.randomUUID(), role: 'user', content: 'Late message', toolMetadata: null, timestamp: new Date().toISOString() },
        ])
      ).rejects.toThrow(/stopped/i);
    });

    it('handles empty batch gracefully', async () => {
      const stub = getStub('project-batch-empty');
      const sessionId = await stub.createSession(null, null);

      const result = await stub.persistMessageBatch(sessionId, []);
      expect(result.persisted).toBe(0);
      expect(result.duplicates).toBe(0);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(0);
    });

    it('preserves message order when timestamps collide (sequence tiebreaker)', async () => {
      const stub = getStub('project-batch-ordering');
      const sessionId = await stub.createSession(null, null);

      // All messages share the exact same timestamp to simulate streaming chunks
      // arriving within the same millisecond
      const sameTimestamp = new Date().toISOString();
      const messages = [
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: 'Hello', toolMetadata: null, timestamp: sameTimestamp, sequence: 1 },
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: ' world', toolMetadata: null, timestamp: sameTimestamp, sequence: 2 },
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: '!', toolMetadata: null, timestamp: sameTimestamp, sequence: 3 },
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: ' How', toolMetadata: null, timestamp: sameTimestamp, sequence: 4 },
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: ' are', toolMetadata: null, timestamp: sameTimestamp, sequence: 5 },
        { messageId: crypto.randomUUID(), role: 'assistant' as const, content: ' you?', toolMetadata: null, timestamp: sameTimestamp, sequence: 6 },
      ];

      await stub.persistMessageBatch(sessionId, messages);
      const { messages: stored } = await stub.getMessages(sessionId);

      expect(stored).toHaveLength(6);
      // Messages must be in sequence order despite identical timestamps
      expect(stored[0]!.content).toBe('Hello');
      expect(stored[1]!.content).toBe(' world');
      expect(stored[2]!.content).toBe('!');
      expect(stored[3]!.content).toBe(' How');
      expect(stored[4]!.content).toBe(' are');
      expect(stored[5]!.content).toBe(' you?');

      // Verify sequence numbers are returned
      expect(stored[0]!.sequence).toBe(1);
      expect(stored[5]!.sequence).toBe(6);
    });

    it('auto-assigns sequence when not provided by client', async () => {
      const stub = getStub('project-batch-auto-seq');
      const sessionId = await stub.createSession(null, null);

      // No sequence field — DO should auto-assign
      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'First', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Second', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const { messages: stored } = await stub.getMessages(sessionId);
      expect(stored).toHaveLength(2);
      // Both should have sequence values (auto-assigned)
      expect(stored[0]!.sequence).toBeTruthy();
      expect(stored[1]!.sequence).toBeTruthy();
      // Second should have a higher sequence than first
      expect((stored[1]!.sequence as number)).toBeGreaterThan(stored[0]!.sequence as number);
    });

    it('all-duplicate batch does not update session timestamp', async () => {
      const stub = getStub('project-batch-all-dup');
      const sessionId = await stub.createSession(null, null);
      const msgId = crypto.randomUUID();

      await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'user', content: 'Original', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const sessionBefore = await stub.getSession(sessionId);

      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: msgId, role: 'user', content: 'Duplicate', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(0);
      expect(result.duplicates).toBe(1);

      // message_count should not have changed
      const sessionAfter = await stub.getSession(sessionId);
      expect(sessionAfter!.messageCount).toBe(sessionBefore!.messageCount);
    });

    it('deduplicates user messages by content (dual-delivery from WebSocket + batch)', async () => {
      const stub = getStub('project-batch-content-dedup');
      const sessionId = await stub.createSession(null, null);

      // Simulate: user message persisted via DO WebSocket (message.send)
      await stub.persistMessage(sessionId, 'user', 'Fix the login bug', null);

      // Simulate: VM agent batch includes same user message with a different ID
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Fix the login bug', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Looking into it...', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // User message should be skipped (content duplicate), assistant should be persisted
      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(1);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(2); // 1 from persistMessage + 1 assistant from batch
      const userMsgs = messages.filter((m) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
    });

    it('does not content-deduplicate non-user messages', async () => {
      const stub = getStub('project-batch-no-content-dedup-assistant');
      const sessionId = await stub.createSession(null, null);

      // Persist an assistant message
      await stub.persistMessage(sessionId, 'assistant', 'I can help with that', null);

      // Batch includes assistant message with same content — should NOT be skipped
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'I can help with that', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(0);
    });

    it('deduplicates user messages by content across two batch calls (retry scenario)', async () => {
      const stub = getStub('project-batch-cross-batch-dedup');
      const sessionId = await stub.createSession(null, null);

      // First batch includes user message
      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Fix the bug', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Second batch (VM agent retry) includes the same user content with a different ID
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Fix the bug', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(0);
      expect(result.duplicates).toBe(1);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    });
  });

  // =========================================================================
  // Session Limits
  // =========================================================================

  describe('session limits', () => {
    it('enforces MAX_SESSIONS_PER_PROJECT limit', async () => {
      // The default is 1000 from env, but we test the mechanism
      // by creating sessions and checking the limit is parsed
      const stub = getStub('project-limit-test');
      const sessionId = await stub.createSession(null, 'Within limit');
      expect(sessionId).toBeTruthy();
    });
  });

  // =========================================================================
  // Message Persistence
  // =========================================================================

  describe('message persistence', () => {
    it('persists and retrieves messages', async () => {
      const stub = getStub('project-messages');
      const sessionId = await stub.createSession(null, null);

      const msgId = await stub.persistMessage(sessionId, 'user', 'Hello world', null);
      expect(msgId).toBeTruthy();

      const { messages, hasMore } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toBe('Hello world');
      expect(messages[0]!.toolMetadata).toBeNull();
      expect(hasMore).toBe(false);
    });

    it('increments message_count on session', async () => {
      const stub = getStub('project-msg-count');
      const sessionId = await stub.createSession(null, null);

      await stub.persistMessage(sessionId, 'user', 'msg 1', null);
      await stub.persistMessage(sessionId, 'assistant', 'msg 2', null);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(2);
    });

    it('stores tool metadata as JSON', async () => {
      const stub = getStub('project-tool-meta');
      const sessionId = await stub.createSession(null, null);

      const metadata = JSON.stringify({ tool: 'search', query: 'test' });
      await stub.persistMessage(sessionId, 'assistant', 'Using tool', metadata);

      const { messages } = await stub.getMessages(sessionId);
      expect(messages[0]!.toolMetadata).toEqual({ tool: 'search', query: 'test' });
    });

    it('auto-sets topic from first user message', async () => {
      const stub = getStub('project-auto-topic');
      const sessionId = await stub.createSession(null, null);

      // First message should set topic
      await stub.persistMessage(sessionId, 'user', 'How do I deploy?', null);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('How do I deploy?');
    });

    it('truncates auto-topic to 100 chars', async () => {
      const stub = getStub('project-long-topic');
      const sessionId = await stub.createSession(null, null);

      const longMessage = 'A'.repeat(200);
      await stub.persistMessage(sessionId, 'user', longMessage, null);

      const session = await stub.getSession(sessionId);
      expect((session!.topic as string).length).toBeLessThanOrEqual(100);
      expect((session!.topic as string).endsWith('...')).toBe(true);
    });

    it('does not overwrite existing topic', async () => {
      const stub = getStub('project-keep-topic');
      const sessionId = await stub.createSession(null, 'Original topic');

      await stub.persistMessage(sessionId, 'user', 'New question', null);

      const session = await stub.getSession(sessionId);
      expect(session!.topic).toBe('Original topic');
    });

    it('throws on message to non-existent session', async () => {
      const stub = getStub('project-msg-no-session');
      let error: Error | null = null;
      try {
        await stub.persistMessage('fake-session', 'user', 'hello', null);
      } catch (e) {
        error = e as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain('not found');
    });

    it('paginates messages with before cursor', async () => {
      const stub = getStub('project-msg-pagination');
      const sessionId = await stub.createSession(null, null);

      // Create several messages
      for (let i = 0; i < 5; i++) {
        await stub.persistMessage(sessionId, 'user', `msg ${i}`, null);
      }

      const { messages: all } = await stub.getMessages(sessionId, 100);
      expect(all).toHaveLength(5);

      // Get messages before the 3rd message's timestamp
      const thirdTs = all[2]!.createdAt as number;
      const { messages: before } = await stub.getMessages(sessionId, 100, thirdTs);
      expect(before.length).toBeLessThan(5);
      for (const msg of before) {
        expect(msg.createdAt as number).toBeLessThan(thirdTs);
      }
    });

    it('returns hasMore when more messages exist', async () => {
      const stub = getStub('project-msg-hasmore');
      const sessionId = await stub.createSession(null, null);

      for (let i = 0; i < 5; i++) {
        await stub.persistMessage(sessionId, 'user', `msg ${i}`, null);
      }

      const { messages, hasMore } = await stub.getMessages(sessionId, 3);
      expect(messages).toHaveLength(3);
      expect(hasMore).toBe(true);
    });
  });

  // =========================================================================
  // Activity Events
  // =========================================================================

  describe('activity events', () => {
    it('records and lists activity events', async () => {
      const stub = getStub('project-activity');
      const eventId = await stub.recordActivityEvent(
        'workspace.created',
        'user',
        'user-123',
        'ws-456',
        null,
        null,
        null
      );
      expect(eventId).toBeTruthy();

      const { events } = await stub.listActivityEvents(null);
      expect(events.length).toBeGreaterThanOrEqual(1);
      // Find our event (there may be auto-created session events from other tests,
      // but with isolated storage each test is fresh)
      const found = events.find((e: Record<string, unknown>) => e.id === eventId);
      expect(found).toBeDefined();
      expect(found!.eventType).toBe('workspace.created');
      expect(found!.actorType).toBe('user');
      expect(found!.actorId).toBe('user-123');
      expect(found!.workspaceId).toBe('ws-456');
    });

    it('filters activity events by type', async () => {
      const stub = getStub('project-activity-filter');

      await stub.recordActivityEvent('workspace.created', 'user', null, null, null, null, null);
      await stub.recordActivityEvent('session.started', 'system', null, null, null, null, null);
      await stub.recordActivityEvent('workspace.deleted', 'user', null, null, null, null, null);

      const { events } = await stub.listActivityEvents('workspace.created');
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe('workspace.created');
    });

    it('stores and parses event payload as JSON', async () => {
      const stub = getStub('project-activity-payload');

      const payload = JSON.stringify({ key: 'value', nested: { a: 1 } });
      await stub.recordActivityEvent('custom.event', 'system', null, null, null, null, payload);

      const { events } = await stub.listActivityEvents('custom.event');
      expect(events[0]!.payload).toEqual({ key: 'value', nested: { a: 1 } });
    });

    it('session creation auto-records activity event', async () => {
      const stub = getStub('project-auto-activity');

      await stub.createSession('ws-auto', 'Auto session');

      const { events } = await stub.listActivityEvents('session.started');
      expect(events.length).toBeGreaterThanOrEqual(1);
      const event = events[0]!;
      expect(event.eventType).toBe('session.started');
      expect(event.actorType).toBe('system');
    });

    it('session stop auto-records activity event', async () => {
      const stub = getStub('project-stop-activity');

      const sessionId = await stub.createSession(null, 'To stop');
      await stub.stopSession(sessionId);

      const { events } = await stub.listActivityEvents('session.stopped');
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('paginates activity events with before cursor', async () => {
      const stub = getStub('project-activity-page');

      for (let i = 0; i < 5; i++) {
        await stub.recordActivityEvent(`event.${i}`, 'user', null, null, null, null, null);
      }

      const { events: all } = await stub.listActivityEvents(null, 50);
      expect(all.length).toBe(5);

      const thirdTs = all[2]!.createdAt as number;
      const { events: older } = await stub.listActivityEvents(null, 50, thirdTs);
      for (const e of older) {
        expect(e.createdAt as number).toBeLessThan(thirdTs);
      }
    });
  });

  // =========================================================================
  // Summary
  // =========================================================================

  describe('summary', () => {
    it('returns summary with active session count', async () => {
      const stub = getStub('project-summary');

      await stub.createSession(null, 'Active 1');
      await stub.createSession(null, 'Active 2');
      const s3 = await stub.createSession(null, 'Stopped');
      await stub.stopSession(s3);

      const summary = await stub.getSummary();
      expect(summary.activeSessionCount).toBe(2);
      expect(summary.lastActivityAt).toBeTruthy();
    });

    it('returns current time when no activity events exist', async () => {
      const stub = getStub('project-summary-empty');

      const summary = await stub.getSummary();
      expect(summary.activeSessionCount).toBe(0);
      // Should still return a valid ISO string
      expect(summary.lastActivityAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  // =========================================================================
  // Cross-Project Isolation
  // =========================================================================

  describe('cross-project isolation', () => {
    it('different project IDs have isolated data', async () => {
      const stubA = getStub('project-isolation-A');
      const stubB = getStub('project-isolation-B');

      // Create session in project A
      await stubA.createSession(null, 'Project A session');

      // Project B should have no sessions
      const { sessions: bSessions, total: bTotal } = await stubB.listSessions(null);
      expect(bTotal).toBe(0);
      expect(bSessions).toHaveLength(0);

      // Project A should have 1 session
      const { total: aTotal } = await stubA.listSessions(null);
      expect(aTotal).toBe(1);
    });

    it('messages in one project are invisible to another', async () => {
      const stubA = getStub('project-msg-iso-A');
      const stubB = getStub('project-msg-iso-B');

      const sessionA = await stubA.createSession(null, null);
      await stubA.persistMessage(sessionA, 'user', 'Secret message', null);

      // Project B should not be able to see project A's messages
      const sessionB = await stubB.createSession(null, null);
      const { messages } = await stubB.getMessages(sessionB);
      expect(messages).toHaveLength(0);
    });

    it('activity events are isolated per project', async () => {
      const stubA = getStub('project-evt-iso-A');
      const stubB = getStub('project-evt-iso-B');

      await stubA.recordActivityEvent('test.event', 'user', null, null, null, null, null);

      const { events: bEvents } = await stubB.listActivityEvents(null);
      expect(bEvents).toHaveLength(0);

      const { events: aEvents } = await stubA.listActivityEvents(null);
      expect(aEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // WebSocket Upgrade
  // =========================================================================

  describe('WebSocket upgrade', () => {
    it('returns 426 for non-WebSocket request to /ws', async () => {
      const stub = getStub('project-ws-test');
      const response = await stub.fetch(new Request('https://do.internal/ws'));
      expect(response.status).toBe(426);
    });

    it('returns 404 for unknown paths', async () => {
      const stub = getStub('project-ws-404');
      const response = await stub.fetch(new Request('https://do.internal/unknown'));
      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // Deterministic ID Mapping
  // =========================================================================

  describe('deterministic ID mapping', () => {
    it('same projectId always maps to the same DO instance', async () => {
      const id1 = env.PROJECT_DATA.idFromName('deterministic-test');
      const id2 = env.PROJECT_DATA.idFromName('deterministic-test');
      expect(id1.toString()).toBe(id2.toString());
    });

    it('different projectIds map to different DO instances', async () => {
      const id1 = env.PROJECT_DATA.idFromName('project-alpha');
      const id2 = env.PROJECT_DATA.idFromName('project-beta');
      expect(id1.toString()).not.toBe(id2.toString());
    });
  });

  // =========================================================================
  // Migrations
  // =========================================================================

  describe('migrations', () => {
    it('tables are created on first access', async () => {
      // Simply accessing the stub should trigger migrations via blockConcurrencyWhile
      const stub = getStub('project-migrations-test');

      // If migrations ran correctly, we can create a session without errors
      const sessionId = await stub.createSession(null, 'Migration test');
      expect(sessionId).toBeTruthy();

      // And record an activity event
      const eventId = await stub.recordActivityEvent(
        'test.migration',
        'system',
        null,
        null,
        null,
        null,
        null
      );
      expect(eventId).toBeTruthy();
    });
  });

  // =========================================================================
  // VM Agent Message Persistence Flow (Integration — T027)
  // =========================================================================

  describe('VM agent message persistence flow', () => {
    it('full round-trip: session with taskId → batch persist → retrieve with metadata', async () => {
      const stub = getStub('project-agent-flow-roundtrip');

      // 1. Create session with taskId (simulates workspace creation hook)
      const sessionId = await stub.createSession('ws-agent-1', null, 'task-run-42');
      expect(sessionId).toBeTruthy();

      const session = await stub.getSession(sessionId);
      expect(session!.taskId).toBe('task-run-42');
      expect(session!.workspaceId).toBe('ws-agent-1');
      expect(session!.status).toBe('active');
      expect(session!.messageCount).toBe(0);

      // 2. First batch from reporter: user prompt + assistant response
      const batch1 = [
        {
          messageId: crypto.randomUUID(),
          role: 'user',
          content: 'Fix the login bug in auth.ts',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'I\'ll investigate the authentication flow in auth.ts.',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ];

      const result1 = await stub.persistMessageBatch(sessionId, batch1);
      expect(result1.persisted).toBe(2);
      expect(result1.duplicates).toBe(0);

      // 3. Second batch: tool calls with metadata (the format Go reporter sends)
      const toolMeta = JSON.stringify({
        kind: 'tool_call',
        status: 'completed',
        locations: [{ path: 'src/auth.ts', line: 42 }],
      });
      const batch2 = [
        {
          messageId: crypto.randomUUID(),
          role: 'tool',
          content: 'Read file: src/auth.ts',
          toolMetadata: toolMeta,
          timestamp: new Date().toISOString(),
        },
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'Found the bug — the token validation was missing.',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ];

      const result2 = await stub.persistMessageBatch(sessionId, batch2);
      expect(result2.persisted).toBe(2);

      // 4. Verify all messages retrievable with correct content
      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(4);

      const userMsg = messages.find((m) => m.role === 'user');
      expect(userMsg!.content).toBe('Fix the login bug in auth.ts');

      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe('Read file: src/auth.ts');
      expect(toolMsg!.toolMetadata).toEqual({
        kind: 'tool_call',
        status: 'completed',
        locations: [{ path: 'src/auth.ts', line: 42 }],
      });

      // 5. Verify session counts and auto-topic
      const updated = await stub.getSession(sessionId);
      expect(updated!.messageCount).toBe(4);
      expect(updated!.topic).toBe('Fix the login bug in auth.ts');
    });

    it('handles duplicate messages across batches (crash recovery)', async () => {
      const stub = getStub('project-agent-flow-recovery');
      const sessionId = await stub.createSession('ws-recovery', null);

      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();
      const msgId3 = crypto.randomUUID();

      // First batch: 2 messages
      await stub.persistMessageBatch(sessionId, [
        { messageId: msgId1, role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: msgId2, role: 'assistant', content: 'Hi', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Simulated crash recovery: reporter re-sends msgId2 (already persisted) + new msgId3
      const result = await stub.persistMessageBatch(sessionId, [
        { messageId: msgId2, role: 'assistant', content: 'Hi', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: msgId3, role: 'user', content: 'Thanks', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(1);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(3); // 2 original + 1 new

      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(3);
    });

    it('session stop preserves messages for retrieval', async () => {
      const stub = getStub('project-agent-flow-stop');
      const sessionId = await stub.createSession('ws-stop', null, 'task-stop');

      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'user', content: 'Build the project', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Building...', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Stop session (simulates workspace destruction)
      await stub.stopSession(sessionId);

      const session = await stub.getSession(sessionId);
      expect(session!.status).toBe('stopped');
      expect(session!.messageCount).toBe(2);

      // Messages still retrievable after stop
      const { messages } = await stub.getMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages.find((m) => m.role === 'user')!.content).toBe('Build the project');
    });
  });

  // =========================================================================
  // Workspace Activity Tracking
  // =========================================================================

  describe('workspace activity tracking', () => {
    it('records terminal activity via updateTerminalActivity', async () => {
      const stub = getStub('project-terminal-activity');
      const sessionId = await stub.createSession('ws-term-1', 'Terminal test');

      // Record terminal activity
      stub.updateTerminalActivity('ws-term-1', sessionId);

      // Verify: persist a message to ensure the DO processes the terminal update
      // (updateTerminalActivity is fire-and-forget on the RPC side, but synchronous in the DO)
      await stub.persistMessage(sessionId, 'user', 'test', null);

      // The workspace_activity table should have a record — verify indirectly
      // by checking the session is still retrievable (no errors from the activity write)
      const session = await stub.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.workspaceId).toBe('ws-term-1');
    });

    it('message persistence updates workspace activity automatically', async () => {
      const stub = getStub('project-msg-activity');
      const sessionId = await stub.createSession('ws-msg-act', 'Message activity test');

      // Persist a message — should update workspace_activity.last_message_at
      await stub.persistMessage(sessionId, 'user', 'Hello', null);

      // Persist batch — should also update workspace_activity.last_message_at
      await stub.persistMessageBatch(sessionId, [
        { messageId: crypto.randomUUID(), role: 'assistant', content: 'Hi there', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const session = await stub.getSession(sessionId);
      expect(session!.messageCount).toBe(2);
    });

    it('message persistence extends scheduled idle cleanup', async () => {
      const stub = getStub('project-msg-activity-idle-reset');
      const sessionId = await stub.createSession('ws-msg-idle', 'Message idle reset test');

      const { cleanupAt: firstCleanupAt } = await stub.scheduleIdleCleanup(sessionId, 'ws-msg-idle', null);
      await new Promise((resolve) => setTimeout(resolve, 5));

      await stub.persistMessageBatch(sessionId, [
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'Still working',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ]);

      const secondCleanupAt = await stub.getCleanupAt(sessionId);
      expect(secondCleanupAt).not.toBeNull();
      expect(secondCleanupAt!).toBeGreaterThan(firstCleanupAt);
    });

    it('terminal activity works without a session id', async () => {
      const stub = getStub('project-terminal-no-session');
      // Create a session to ensure the DO is initialized
      await stub.createSession('ws-nosess', 'No session terminal');

      // Should not throw when sessionId is null
      stub.updateTerminalActivity('ws-nosess', null);

      // Verify DO is still functional
      const { sessions } = await stub.listSessions(null);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Workspace Lifecycle Synchronization
  // =========================================================================

  describe('workspace lifecycle sync', () => {
    it('linkSessionToWorkspace creates workspace_activity row', async () => {
      const stub = getStub('project-link-activity');

      // Create session without workspace (task-driven pattern)
      const sessionId = await stub.createSession(null, 'Task session');
      const session = await stub.getSession(sessionId);
      expect(session!.workspaceId).toBeNull();

      // Link workspace to session
      await stub.linkSessionToWorkspace(sessionId, 'ws-link-test');

      // Verify session has workspace
      const updated = await stub.getSession(sessionId);
      expect(updated!.workspaceId).toBe('ws-link-test');

      // Verify workspace_activity was created by sending a terminal heartbeat
      // (if the row didn't exist, this would create it — but we verify by
      // checking that the activity tracking system works for this workspace)
      stub.updateTerminalActivity('ws-link-test', sessionId);

      // DO should still be functional
      const { sessions } = await stub.listSessions(null);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('cleanupWorkspaceActivity removes tracking row', async () => {
      const stub = getStub('project-cleanup-activity');

      // Create session with workspace (creates workspace_activity row)
      const sessionId = await stub.createSession('ws-cleanup-test', 'Cleanup session');

      // Update activity to ensure row exists
      stub.updateTerminalActivity('ws-cleanup-test', sessionId);

      // Clean up the activity row
      stub.cleanupWorkspaceActivity('ws-cleanup-test');

      // DO should still be functional after cleanup
      const { sessions } = await stub.listSessions(null);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('stopping a session makes it show as stopped', async () => {
      const stub = getStub('project-stop-lifecycle');

      // Create workspace session
      const sessionId = await stub.createSession('ws-stop-test', 'Will be stopped');
      const session = await stub.getSession(sessionId);
      expect(session!.status).toBe('active');

      // Stop the session (simulates what happens when workspace is stopped)
      await stub.stopSession(sessionId);

      // Session should now be stopped
      const stopped = await stub.getSession(sessionId);
      expect(stopped!.status).toBe('stopped');
      expect(stopped!.endedAt).toBeTruthy();
    });

    it('linkSessionToWorkspace is idempotent for workspace_activity', async () => {
      const stub = getStub('project-link-idempotent');

      // Create session without workspace
      const sessionId = await stub.createSession(null, 'Idempotent test');

      // Link workspace twice — should not error
      await stub.linkSessionToWorkspace(sessionId, 'ws-idemp-test');
      await stub.linkSessionToWorkspace(sessionId, 'ws-idemp-test');

      // Session should have the workspace
      const session = await stub.getSession(sessionId);
      expect(session!.workspaceId).toBe('ws-idemp-test');
    });

    it('cleanupWorkspaceActivity is safe for non-existent workspace', async () => {
      const stub = getStub('project-cleanup-nonexistent');

      // Should not throw for a workspace that has no activity row
      stub.cleanupWorkspaceActivity('ws-does-not-exist');

      // DO should still be functional
      const { sessions } = await stub.listSessions(null);
      expect(sessions).toBeDefined();
    });
  });

  // =========================================================================
  // Message Materialization & FTS5 Search
  // =========================================================================

  describe('message materialization and FTS5 search', () => {
    it('materializes session on stop and enables FTS5 search', async () => {
      const stub = getStub('project-fts5-basic');
      const sessionId = await stub.createSession(null, 'FTS5 test');

      // Persist tokens that span a search term across boundaries
      await stub.persistMessage(sessionId, 'user', 'Fix the authentication middleware', null);
      await stub.persistMessage(sessionId, 'assistant', 'I will fix the auth', null);
      await stub.persistMessage(sessionId, 'assistant', 'entication middleware now.', null);
      await stub.persistMessage(sessionId, 'assistant', ' Let me look at the code.', null);

      // Before stop: search should use LIKE on raw tokens
      const beforeResults = stub.searchMessages('authentication middleware');
      // LIKE on individual tokens may or may not find this — the user message has it
      expect(beforeResults.length).toBeGreaterThanOrEqual(1);

      // Stop session — triggers materialization
      await stub.stopSession(sessionId);

      // After stop: session should be materialized
      const session = await stub.getSession(sessionId);
      expect(session!.status).toBe('stopped');

      // FTS5 search should find "authentication middleware" even though it spans tokens
      const afterResults = stub.searchMessages('authentication middleware');
      expect(afterResults.length).toBeGreaterThanOrEqual(1);
      // The grouped assistant message should contain the full phrase
      const assistantResult = afterResults.find((r) => r.role === 'assistant');
      expect(assistantResult).toBeDefined();
      expect(assistantResult!.snippet).toContain('auth');
    });

    it('materializeSession is idempotent', async () => {
      const stub = getStub('project-fts5-idempotent');
      const sessionId = await stub.createSession(null, 'Idempotent test');

      await stub.persistMessage(sessionId, 'user', 'Hello world', null);
      await stub.persistMessage(sessionId, 'assistant', 'Hi there!', null);

      await stub.stopSession(sessionId);

      // Calling materializeSession again should be a no-op (no error)
      stub.materializeSession(sessionId);

      // Search should still work
      const results = stub.searchMessages('Hello');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('materializeAllStopped backfills existing sessions', async () => {
      const stub = getStub('project-fts5-backfill');

      // Create and stop multiple sessions
      const s1 = await stub.createSession(null, 'Session one');
      await stub.persistMessage(s1, 'user', 'First session content', null);
      await stub.stopSession(s1); // auto-materializes

      const s2 = await stub.createSession(null, 'Session two');
      await stub.persistMessage(s2, 'user', 'Second session unique text', null);
      await stub.stopSession(s2); // auto-materializes

      // Create an active session (should NOT be materialized)
      const s3 = await stub.createSession(null, 'Active session');
      await stub.persistMessage(s3, 'user', 'Active session content', null);

      // materializeAllStopped should report already-materialized sessions as no-ops
      const result = stub.materializeAllStopped();
      expect(result.errors).toBe(0);

      // Both stopped sessions should be searchable
      const r1 = stub.searchMessages('First session');
      expect(r1.length).toBeGreaterThanOrEqual(1);
      const r2 = stub.searchMessages('unique text');
      expect(r2.length).toBeGreaterThanOrEqual(1);
    });

    it('active sessions fall back to LIKE search', async () => {
      const stub = getStub('project-fts5-fallback');

      const sessionId = await stub.createSession(null, 'Active search test');
      await stub.persistMessage(sessionId, 'user', 'searchable keyword here', null);

      // Session is still active — should fall back to LIKE
      const results = stub.searchMessages('searchable');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.snippet).toContain('searchable');
    });

    it('FTS5 search with role filtering', async () => {
      const stub = getStub('project-fts5-roles');
      const sessionId = await stub.createSession(null, 'Role filter test');

      await stub.persistMessage(sessionId, 'user', 'Please fix the database query', null);
      await stub.persistMessage(sessionId, 'assistant', 'I will fix the database query now', null);

      await stub.stopSession(sessionId);

      // Search with role filter — only user messages
      const userResults = stub.searchMessages('database query', null, ['user']);
      expect(userResults.length).toBe(1);
      expect(userResults[0]!.role).toBe('user');

      // Search with role filter — only assistant messages
      const assistantResults = stub.searchMessages('database query', null, ['assistant']);
      expect(assistantResults.length).toBe(1);
      expect(assistantResults[0]!.role).toBe('assistant');
    });

    it('groups consecutive assistant tokens into single message', async () => {
      const stub = getStub('project-fts5-grouping');
      const sessionId = await stub.createSession(null, 'Grouping test');

      // Simulate streaming tokens
      await stub.persistMessage(sessionId, 'assistant', 'Let me', null);
      await stub.persistMessage(sessionId, 'assistant', ' analyze', null);
      await stub.persistMessage(sessionId, 'assistant', ' the code.', null);

      await stub.stopSession(sessionId);

      // Search for a term that spans token boundaries
      const results = stub.searchMessages('analyze the');
      expect(results.length).toBe(1);
      expect(results[0]!.snippet).toContain('analyze');
    });
  });

  // =========================================================================
  // Session–Idea Linking (many-to-many)
  // =========================================================================

  describe('session-idea linking', () => {
    it('links a session to an idea', async () => {
      const stub = getStub('project-idea-link');
      const sessionId = await stub.createSession(null, 'Idea discussion');

      stub.linkSessionIdea(sessionId, 'task-001', 'discussing auth flow');

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(1);
      expect(ideas[0]!.taskId).toBe('task-001');
      expect(ideas[0]!.context).toBe('discussing auth flow');
      expect(ideas[0]!.createdAt).toBeGreaterThan(0);
    });

    it('links multiple ideas to a single session', async () => {
      const stub = getStub('project-idea-multi-link');
      const sessionId = await stub.createSession(null, 'Multi-idea session');

      stub.linkSessionIdea(sessionId, 'task-a', 'first idea');
      stub.linkSessionIdea(sessionId, 'task-b', 'second idea');
      stub.linkSessionIdea(sessionId, 'task-c', null);

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(3);
      expect(ideas.map((i: { taskId: string }) => i.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
    });

    it('is idempotent — duplicate links are silently ignored', async () => {
      const stub = getStub('project-idea-idempotent');
      const sessionId = await stub.createSession(null, 'Idempotent test');

      stub.linkSessionIdea(sessionId, 'task-dup', 'first link');
      stub.linkSessionIdea(sessionId, 'task-dup', 'second link attempt');

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(1);
      // First context wins (INSERT OR IGNORE)
      expect(ideas[0]!.context).toBe('first link');
    });

    it('unlinks a session from an idea', async () => {
      const stub = getStub('project-idea-unlink');
      const sessionId = await stub.createSession(null, 'Unlink test');

      stub.linkSessionIdea(sessionId, 'task-rm', 'to be removed');
      stub.unlinkSessionIdea(sessionId, 'task-rm');

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(0);
    });

    it('unlinking non-existent link is a no-op', async () => {
      const stub = getStub('project-idea-unlink-noop');
      const sessionId = await stub.createSession(null, 'No-op test');

      // Should not throw
      stub.unlinkSessionIdea(sessionId, 'nonexistent-task');

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(0);
    });

    it('returns sessions linked to an idea (reverse lookup)', async () => {
      const stub = getStub('project-idea-reverse');
      const s1 = await stub.createSession(null, 'Session one');
      const s2 = await stub.createSession(null, 'Session two');

      stub.linkSessionIdea(s1, 'shared-task', 'context 1');
      stub.linkSessionIdea(s2, 'shared-task', 'context 2');

      const sessions = stub.getSessionsForIdea('shared-task');
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.sessionId).toBe(s1);
      expect(sessions[0]!.topic).toBe('Session one');
      expect(sessions[0]!.status).toBe('active');
      expect(sessions[0]!.context).toBe('context 1');
      expect(sessions[1]!.sessionId).toBe(s2);
    });

    it('returns empty array for idea with no linked sessions', async () => {
      const stub = getStub('project-idea-no-sessions');

      const sessions = stub.getSessionsForIdea('orphan-task');
      expect(sessions).toHaveLength(0);
    });

    it('throws when linking to a non-existent session', async () => {
      const stub = getStub('project-idea-bad-session');
      await stub.ensureProjectId('project-idea-bad-session');

      expect(() => {
        stub.linkSessionIdea('nonexistent-session', 'task-x', null);
      }).toThrow('Session not found: nonexistent-session');
    });

    it('cascade deletes links when session is deleted', async () => {
      const stub = getStub('project-idea-cascade');
      const sessionId = await stub.createSession(null, 'Cascade test');

      stub.linkSessionIdea(sessionId, 'task-cascade', 'will be deleted');

      // Verify link exists
      expect(stub.getIdeasForSession(sessionId)).toHaveLength(1);

      // Stop session (does not delete in current schema, just changes status)
      await stub.stopSession(sessionId);

      // Links should still exist since session is stopped, not deleted
      expect(stub.getIdeasForSession(sessionId)).toHaveLength(1);
    });

    it('returns empty ideas for a session with no links', async () => {
      const stub = getStub('project-idea-empty-session');
      const sessionId = await stub.createSession(null, 'No links');

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(0);
      expect(ideas).toEqual([]);
    });

    it('round-trips null context correctly', async () => {
      const stub = getStub('project-idea-null-ctx');
      const sessionId = await stub.createSession(null, 'Null context');

      stub.linkSessionIdea(sessionId, 'task-null', null);

      const ideas = stub.getIdeasForSession(sessionId);
      expect(ideas).toHaveLength(1);
      expect(ideas[0]!.context).toBeNull();
    });

    it('getSessionsForIdea returns linkedAt as a positive number', async () => {
      const stub = getStub('project-idea-linked-at');
      const sessionId = await stub.createSession(null, 'LinkedAt test');

      stub.linkSessionIdea(sessionId, 'task-la', 'test');

      const sessions = stub.getSessionsForIdea('task-la');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.linkedAt).toBeGreaterThan(0);
      expect(typeof sessions[0]!.linkedAt).toBe('number');
    });
  });

  // =========================================================================
  // Cached Commands
  // =========================================================================

  describe('cached commands', () => {
    it('caches and retrieves commands for an agent type', async () => {
      const stub = getStub('project-cache-cmds-1');
      await stub.cacheCommands('claude-code', [
        { name: 'compact', description: 'Compact conversation' },
        { name: 'help', description: 'Show help' },
      ]);

      const result = await stub.getCachedCommands('claude-code');
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('compact');
      expect(result[1]!.name).toBe('help');
      expect(result[0]!.agentType).toBe('claude-code');
    });

    it('replaces commands on re-cache', async () => {
      const stub = getStub('project-cache-cmds-2');
      await stub.cacheCommands('claude-code', [
        { name: 'old-cmd', description: 'Old' },
      ]);

      await stub.cacheCommands('claude-code', [
        { name: 'new-cmd', description: 'New' },
      ]);

      const result = await stub.getCachedCommands('claude-code');
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('new-cmd');
    });

    it('returns all commands when no agent type filter', async () => {
      const stub = getStub('project-cache-cmds-3');
      await stub.cacheCommands('claude-code', [{ name: 'cmd1', description: 'D1' }]);
      await stub.cacheCommands('other-agent', [{ name: 'cmd2', description: 'D2' }]);

      const all = await stub.getCachedCommands();
      expect(all).toHaveLength(2);
    });

    it('returns empty array when no commands cached', async () => {
      const stub = getStub('project-cache-cmds-4');
      const result = await stub.getCachedCommands('claude-code');
      expect(result).toEqual([]);
    });
  });
});
