/**
 * Vertical slice tests for the project-data DO proxy service.
 *
 * Exercises the service layer (apps/api/src/services/project-data.ts) which
 * wraps RPC calls to the ProjectData Durable Object. Every call goes through:
 *   service function → getStub(env, projectId) → ensureProjectId() → DO method
 *
 * Uses the real ProjectData DO running in the workerd runtime via
 * @cloudflare/vitest-pool-workers, so these tests verify the full
 * Worker → DO contract with real SQLite storage.
 *
 * See: .claude/rules/35-vertical-slice-testing.md
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_MESSAGES_PER_SESSION } from '../../src/durable-objects/project-data/messages';
import type { Env } from '../../src/env';
// Import service functions under test
import * as svc from '../../src/services/project-data';

// Cast the test env to the service's Env type.
// The miniflare env provides the same bindings (PROJECT_DATA, etc.)
const testEnv = env as unknown as Env;

async function withMessageCap<T>(cap: string, fn: () => Promise<T>): Promise<T> {
  const mutableEnv = testEnv as Env & { MAX_MESSAGES_PER_SESSION?: string };
  const previous = mutableEnv.MAX_MESSAGES_PER_SESSION;
  mutableEnv.MAX_MESSAGES_PER_SESSION = cap;
  try {
    return await fn();
  } finally {
    mutableEnv.MAX_MESSAGES_PER_SESSION = previous;
  }
}

// =========================================================================
// 1. Session Lifecycle
// =========================================================================

describe('project-data service: session lifecycle', () => {
  const PROJECT = 'svc-session-lifecycle';

  it('createSession returns a session id', async () => {
    const sessionId = await svc.createSession(testEnv, PROJECT, null, 'Test topic');
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  it('createSession with workspace and task', async () => {
    const pid = 'svc-session-ws-task';
    const sessionId = await svc.createSession(testEnv, pid, 'ws-100', 'WS topic', 'task-abc');

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session).not.toBeNull();
    expect(session!.workspaceId).toBe('ws-100');
    expect(session!.topic).toBe('WS topic');
    expect(session!.taskId).toBe('task-abc');
    expect(session!.status).toBe('active');
    expect(session!.messageCount).toBe(0);
  });

  it('linkSessionToWorkspace updates the workspace binding', async () => {
    const pid = 'svc-link-workspace';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Unlinked');

    await svc.linkSessionToWorkspace(testEnv, pid, sessionId, 'ws-linked');

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.workspaceId).toBe('ws-linked');
  });

  it('stopSession transitions to stopped with endedAt', async () => {
    const pid = 'svc-stop-session';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Will stop');

    await svc.stopSession(testEnv, pid, sessionId);

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.status).toBe('stopped');
    expect(session!.endedAt).toBeTruthy();
  });

  it('failSession transitions to failed with error message', async () => {
    const pid = 'svc-fail-session';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Will fail');

    await svc.failSession(testEnv, pid, sessionId, 'Something broke');

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.status).toBe('failed');
  });

  it('updateSessionTopic changes topic on active session', async () => {
    const pid = 'svc-update-topic';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Old topic');

    const result = await svc.updateSessionTopic(testEnv, pid, sessionId, 'New topic');
    expect(result).toBe(true);

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.topic).toBe('New topic');
  });

  it('updateSessionTopic returns false for stopped session', async () => {
    const pid = 'svc-update-topic-stopped';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Original');
    await svc.stopSession(testEnv, pid, sessionId);

    const result = await svc.updateSessionTopic(testEnv, pid, sessionId, 'Nope');
    expect(result).toBe(false);
  });

  it('listSessions returns paginated results', async () => {
    const pid = 'svc-list-sessions';
    for (let i = 0; i < 5; i++) {
      await svc.createSession(testEnv, pid, null, `Session ${i}`);
    }

    const { sessions, total } = await svc.listSessions(testEnv, pid, null, 3, 0);
    expect(total).toBe(5);
    expect(sessions).toHaveLength(3);

    const { sessions: page2 } = await svc.listSessions(testEnv, pid, null, 3, 3);
    expect(page2).toHaveLength(2);
  });

  it('listSessions filters by status', async () => {
    const pid = 'svc-list-by-status';
    const s1 = await svc.createSession(testEnv, pid, null, 'Active');
    const s2 = await svc.createSession(testEnv, pid, null, 'Stopped');
    await svc.stopSession(testEnv, pid, s2);

    const { sessions: active, total: activeTotal } = await svc.listSessions(testEnv, pid, 'active');
    expect(activeTotal).toBe(1);
    expect(active[0]!.id).toBe(s1);

    const { sessions: stopped } = await svc.listSessions(testEnv, pid, 'stopped');
    expect(stopped[0]!.id).toBe(s2);
  });

  it('listSessions filters by taskId', async () => {
    const pid = 'svc-list-by-taskid';
    await svc.createSession(testEnv, pid, null, 'A', 'task-1');
    await svc.createSession(testEnv, pid, null, 'B', 'task-2');
    await svc.createSession(testEnv, pid, null, 'C');

    const { sessions, total } = await svc.listSessions(testEnv, pid, null, 20, 0, 'task-1');
    expect(total).toBe(1);
    expect(sessions[0]!.taskId).toBe('task-1');
  });

  it('getSession returns null for non-existent session', async () => {
    const result = await svc.getSession(testEnv, 'svc-no-session', 'nonexistent');
    expect(result).toBeNull();
  });

  it('getSessionsByTaskIds returns matching sessions', async () => {
    const pid = 'svc-batch-taskids';
    await svc.createSession(testEnv, pid, null, 'T1', 'task-x');
    await svc.createSession(testEnv, pid, null, 'T2', 'task-y');
    await svc.createSession(testEnv, pid, null, 'No task');

    const results = await svc.getSessionsByTaskIds(testEnv, pid, ['task-x', 'task-y']);
    expect(results).toHaveLength(2);
    const taskIds = results.map((r) => r.taskId);
    expect(taskIds).toContain('task-x');
    expect(taskIds).toContain('task-y');
  });

  it('markAgentCompleted sets agentCompletedAt and isIdle', async () => {
    const pid = 'svc-agent-completed';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Agent session');

    await svc.markAgentCompleted(testEnv, pid, sessionId);

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.agentCompletedAt).toBeTruthy();
    expect(session!.isIdle).toBe(true);
  });
});

// =========================================================================
// 2. Message Persistence
// =========================================================================

describe('project-data service: message persistence', () => {
  it('persistMessage stores and retrieves a message', async () => {
    const pid = 'svc-persist-msg';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    const msgId = await svc.persistMessage(testEnv, pid, sessionId, 'user', 'Hello world', null);
    expect(msgId).toBeTruthy();

    const { messages, hasMore } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello world');
    expect(messages[0]!.toolMetadata).toBeNull();
    expect(hasMore).toBe(false);
  });

  it('persistMessage serializes toolMetadata to JSON', async () => {
    const pid = 'svc-persist-toolmeta';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    const toolMeta = { tool: 'bash', command: 'ls -la', exitCode: 0 };
    await svc.persistMessage(testEnv, pid, sessionId, 'assistant', 'Running...', toolMeta);

    const { messages } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages[0]!.toolMetadata).toEqual(toolMeta);
  });

  it('persistMessage can store a caller-provided message ID for reporter dedupe', async () => {
    const pid = 'svc-persist-custom-id';
    const sessionId = await svc.createSession(testEnv, pid, null, null);
    const messageId = 'pre-persisted-message-001';

    const storedId = await svc.persistMessage(
      testEnv,
      pid,
      sessionId,
      'user',
      'Please continue',
      { source: 'parent_agent', kind: 'orchestration_prompt' },
      messageId
    );

    expect(storedId).toBe(messageId);

    const result = await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId,
        role: 'user',
        content: 'Please continue',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(result.persisted).toBe(0);
    expect(result.duplicates).toBe(1);

    const { messages } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(messageId);
  });

  it('persistMessageBatch handles deduplication', async () => {
    const pid = 'svc-batch-dedup';
    const sessionId = await svc.createSession(testEnv, pid, null, null);
    const sharedId = crypto.randomUUID();

    // First batch
    await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId: sharedId,
        role: 'user',
        content: 'Original',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);

    // Second batch with duplicate + new
    const result = await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId: sharedId,
        role: 'user',
        content: 'Duplicate',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'New',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(result.persisted).toBe(1);
    expect(result.duplicates).toBe(1);

    const { messages } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages).toHaveLength(2);
    // Original content preserved
    const original = messages.find((m) => m.id === sharedId);
    expect(original!.content).toBe('Original');
  });

  it('uses 100000 as the default session message cap', () => {
    expect(DEFAULT_MAX_MESSAGES_PER_SESSION).toBe(100000);
  });

  it('persists up to remaining capacity and reports cap exhaustion', async () => {
    await withMessageCap('2', async () => {
      const pid = 'svc-batch-cap-partial';
      const sessionId = await svc.createSession(testEnv, pid, null, null);

      const result = await svc.persistMessageBatch(testEnv, pid, sessionId, [
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'one',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'two',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'three',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ]);

      expect(result.persisted).toBe(2);
      expect(result.duplicates).toBe(0);
      expect(result.limitReached).toBe(true);
      expect(result.maxMessages).toBe(2);
      expect(result.remainingCapacity).toBe(0);

      const session = await svc.getSession(testEnv, pid, sessionId);
      expect(session!.messageCount).toBe(2);
    });
  });

  it('throws SESSION_MESSAGE_LIMIT_EXCEEDED when capacity is already exhausted', async () => {
    await withMessageCap('1', async () => {
      const pid = 'svc-batch-cap-full';
      const sessionId = await svc.createSession(testEnv, pid, null, null);
      await svc.persistMessageBatch(testEnv, pid, sessionId, [
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: 'one',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ]);

      await expect(
        svc.persistMessageBatch(testEnv, pid, sessionId, [
          {
            messageId: crypto.randomUUID(),
            role: 'assistant',
            content: 'two',
            toolMetadata: null,
            timestamp: new Date().toISOString(),
          },
        ])
      ).rejects.toThrow(/message limit/i);
    });
  });

  it('persistMessageBatch preserves sequence ordering', async () => {
    const pid = 'svc-batch-ordering';
    const sessionId = await svc.createSession(testEnv, pid, null, null);
    const ts = new Date().toISOString();

    await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'A',
        toolMetadata: null,
        timestamp: ts,
        sequence: 1,
      },
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'B',
        toolMetadata: null,
        timestamp: ts,
        sequence: 2,
      },
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'C',
        toolMetadata: null,
        timestamp: ts,
        sequence: 3,
      },
    ]);

    const { messages } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe('A');
    expect(messages[1]!.content).toBe('B');
    expect(messages[2]!.content).toBe('C');
  });

  it('persistMessageBatch serializes toolMetadata objects', async () => {
    const pid = 'svc-batch-toolmeta';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    const toolMeta = { tool: 'read', file: '/app/index.ts', lines: 50 };
    await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'Reading file',
        toolMetadata: toolMeta,
        timestamp: new Date().toISOString(),
      },
    ]);

    const { messages } = await svc.getMessages(testEnv, pid, sessionId);
    expect(messages[0]!.toolMetadata).toEqual(toolMeta);
  });

  it('persistMessageBatch rejects messages to stopped sessions', async () => {
    const pid = 'svc-batch-stopped';
    const sessionId = await svc.createSession(testEnv, pid, null, null);
    await svc.stopSession(testEnv, pid, sessionId);

    await expect(
      svc.persistMessageBatch(testEnv, pid, sessionId, [
        {
          messageId: crypto.randomUUID(),
          role: 'user',
          content: 'Late',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ])
    ).rejects.toThrow(/stopped/i);
  });

  it('persistMessageBatch throws for non-existent session', async () => {
    await expect(
      svc.persistMessageBatch(testEnv, 'svc-batch-nosession', 'fake-id', [
        {
          messageId: crypto.randomUUID(),
          role: 'user',
          content: 'Hi',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ])
    ).rejects.toThrow(/not found/i);
  });

  it('persistMessageBatch auto-captures topic from first user message', async () => {
    const pid = 'svc-batch-autotopic';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    await svc.persistMessageBatch(testEnv, pid, sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'Init',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'Deploy to staging',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);

    const session = await svc.getSession(testEnv, pid, sessionId);
    expect(session!.topic).toBe('Deploy to staging');
  });

  it('getMessageCount returns accurate count', async () => {
    const pid = 'svc-msg-count';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    await svc.persistMessage(testEnv, pid, sessionId, 'user', 'Q1', null);
    await svc.persistMessage(testEnv, pid, sessionId, 'assistant', 'A1', null);
    await svc.persistMessage(testEnv, pid, sessionId, 'user', 'Q2', null);

    const total = await svc.getMessageCount(testEnv, pid, sessionId);
    expect(total).toBe(3);

    const userOnly = await svc.getMessageCount(testEnv, pid, sessionId, ['user']);
    expect(userOnly).toBe(2);
  });

  it('searchMessages finds messages by keyword', async () => {
    const pid = 'svc-search-messages';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Search test');

    await svc.persistMessage(testEnv, pid, sessionId, 'user', 'Fix the authentication bug', null);
    await svc.persistMessage(
      testEnv,
      pid,
      sessionId,
      'assistant',
      'Looking into authentication',
      null
    );
    await svc.persistMessage(testEnv, pid, sessionId, 'user', 'Deploy to production', null);

    const results = await svc.searchMessages(testEnv, pid, 'authentication');
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.snippet.toLowerCase()).toContain('authentication');
    }
  });

  it('getMessages supports compact mode', async () => {
    const pid = 'svc-compact-mode';
    const sessionId = await svc.createSession(testEnv, pid, null, null);

    const toolMeta = { tool: 'bash', output: 'some long output' };
    await svc.persistMessage(testEnv, pid, sessionId, 'assistant', 'Running', toolMeta);

    // Compact mode should still return messages
    const { messages } = await svc.getMessages(testEnv, pid, sessionId, 100, null, undefined, true);
    expect(messages).toHaveLength(1);
  });
});

// =========================================================================
// 3. Idle Cleanup Scheduling
// =========================================================================

describe('project-data service: idle cleanup scheduling', () => {
  it('scheduleIdleCleanup arms a future cleanup time', async () => {
    const pid = 'svc-idle-schedule';
    const sessionId = await svc.createSession(testEnv, pid, 'ws-idle', 'Idle test');

    const before = Date.now();
    const { cleanupAt } = await svc.scheduleIdleCleanup(testEnv, pid, sessionId, 'ws-idle', null);

    expect(cleanupAt).toBeGreaterThan(before);

    const stored = await svc.getCleanupAt(testEnv, pid, sessionId);
    expect(stored).toBe(cleanupAt);
  });

  it('cancelIdleCleanup clears the cleanup schedule', async () => {
    const pid = 'svc-idle-cancel';
    const sessionId = await svc.createSession(testEnv, pid, 'ws-cancel', 'Cancel test');

    await svc.scheduleIdleCleanup(testEnv, pid, sessionId, 'ws-cancel', null);
    await svc.cancelIdleCleanup(testEnv, pid, sessionId);

    const stored = await svc.getCleanupAt(testEnv, pid, sessionId);
    expect(stored).toBeNull();
  });

  it('resetIdleCleanup extends the cleanup timer', async () => {
    const pid = 'svc-idle-reset';
    const sessionId = await svc.createSession(testEnv, pid, 'ws-reset', 'Reset test');

    const { cleanupAt: original } = await svc.scheduleIdleCleanup(
      testEnv,
      pid,
      sessionId,
      'ws-reset',
      null
    );

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const { cleanupAt: extended } = await svc.resetIdleCleanup(testEnv, pid, sessionId);
    expect(extended).toBeGreaterThanOrEqual(original);
  });

  it('getCleanupAt returns null for unscheduled session', async () => {
    const pid = 'svc-idle-no-cleanup';
    const sessionId = await svc.createSession(testEnv, pid, null, 'No cleanup');

    const result = await svc.getCleanupAt(testEnv, pid, sessionId);
    expect(result).toBeNull();
  });
});

// =========================================================================
// 4. Session–Idea Linking (many-to-many)
// =========================================================================

describe('project-data service: session-idea linking', () => {
  it('linkSessionIdea and getIdeasForSession', async () => {
    const pid = 'svc-idea-link';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Idea session');

    await svc.linkSessionIdea(testEnv, pid, sessionId, 'idea-1', 'Context A');
    await svc.linkSessionIdea(testEnv, pid, sessionId, 'idea-2', null);

    const ideas = await svc.getIdeasForSession(testEnv, pid, sessionId);
    expect(ideas).toHaveLength(2);

    const idea1 = ideas.find((i) => i.taskId === 'idea-1');
    expect(idea1).toBeTruthy();
    expect(idea1!.context).toBe('Context A');

    const idea2 = ideas.find((i) => i.taskId === 'idea-2');
    expect(idea2).toBeTruthy();
    expect(idea2!.context).toBeNull();
  });

  it('getSessionsForIdea returns linked sessions', async () => {
    const pid = 'svc-idea-sessions';
    const s1 = await svc.createSession(testEnv, pid, null, 'Session 1');
    const s2 = await svc.createSession(testEnv, pid, null, 'Session 2');

    await svc.linkSessionIdea(testEnv, pid, s1, 'idea-shared', 'From S1');
    await svc.linkSessionIdea(testEnv, pid, s2, 'idea-shared', 'From S2');

    const sessions = await svc.getSessionsForIdea(testEnv, pid, 'idea-shared');
    expect(sessions).toHaveLength(2);
    const sessionIds = sessions.map((s) => s.sessionId);
    expect(sessionIds).toContain(s1);
    expect(sessionIds).toContain(s2);
  });

  it('unlinkSessionIdea removes the link', async () => {
    const pid = 'svc-idea-unlink';
    const sessionId = await svc.createSession(testEnv, pid, null, 'Unlink session');

    await svc.linkSessionIdea(testEnv, pid, sessionId, 'idea-unlink', 'Will remove');

    let ideas = await svc.getIdeasForSession(testEnv, pid, sessionId);
    expect(ideas).toHaveLength(1);

    await svc.unlinkSessionIdea(testEnv, pid, sessionId, 'idea-unlink');

    ideas = await svc.getIdeasForSession(testEnv, pid, sessionId);
    expect(ideas).toHaveLength(0);
  });

  it('getIdeasForSession returns empty for session with no ideas', async () => {
    const pid = 'svc-idea-empty';
    const sessionId = await svc.createSession(testEnv, pid, null, 'No ideas');

    const ideas = await svc.getIdeasForSession(testEnv, pid, sessionId);
    expect(ideas).toHaveLength(0);
  });

  it('getSessionsForIdea returns empty for unlinked idea', async () => {
    const sessions = await svc.getSessionsForIdea(testEnv, 'svc-idea-no-links', 'idea-nowhere');
    expect(sessions).toHaveLength(0);
  });
});

// =========================================================================
// 5. ACP Session Management
// =========================================================================

describe('project-data service: ACP session management', () => {
  it('createAcpSession returns a full AcpSession object', async () => {
    const pid = 'svc-acp-create';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'ACP chat');

    const acpSession = await svc.createAcpSession(
      testEnv,
      pid,
      chatSessionId,
      'Fix the bug',
      'claude-code',
      null,
      0
    );

    expect(acpSession.id).toBeTruthy();
    expect(acpSession.chatSessionId).toBe(chatSessionId);
    expect(acpSession.initialPrompt).toBe('Fix the bug');
    expect(acpSession.agentType).toBe('claude-code');
    expect(acpSession.status).toBe('pending');
    expect(acpSession.forkDepth).toBe(0);
  });

  it('getAcpSession retrieves a created session', async () => {
    const pid = 'svc-acp-get';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'ACP get');
    const created = await svc.createAcpSession(
      testEnv,
      pid,
      chatSessionId,
      'Test prompt',
      'claude-code'
    );

    const fetched = await svc.getAcpSession(testEnv, pid, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.chatSessionId).toBe(chatSessionId);
  });

  it('getAcpSession returns null for non-existent session', async () => {
    const result = await svc.getAcpSession(testEnv, 'svc-acp-missing', 'nonexistent');
    expect(result).toBeNull();
  });

  it('transitionAcpSession changes status', async () => {
    const pid = 'svc-acp-transition';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'ACP transition');
    const acpSession = await svc.createAcpSession(
      testEnv,
      pid,
      chatSessionId,
      'Test',
      'claude-code'
    );

    // pending → assigned → running
    await svc.transitionAcpSession(testEnv, pid, acpSession.id, 'assigned', {
      actorType: 'system',
      workspaceId: 'ws-acp',
      nodeId: 'node-acp',
    });
    const activated = await svc.transitionAcpSession(testEnv, pid, acpSession.id, 'running', {
      actorType: 'system',
      acpSdkSessionId: 'sdk-node-acp',
    });

    expect(activated.status).toBe('running');
    expect(activated.workspaceId).toBe('ws-acp');
    expect(activated.nodeId).toBe('node-acp');
  });

  it('updateAcpSessionHeartbeat refreshes lastHeartbeatAt', async () => {
    const pid = 'svc-acp-heartbeat';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'ACP heartbeat');
    const acpSession = await svc.createAcpSession(
      testEnv,
      pid,
      chatSessionId,
      'Test',
      'claude-code'
    );

    // Transition to running first (heartbeat requires a live state with nodeId)
    await svc.transitionAcpSession(testEnv, pid, acpSession.id, 'assigned', {
      actorType: 'system',
      workspaceId: 'ws-hb',
      nodeId: 'node-hb',
    });
    await svc.transitionAcpSession(testEnv, pid, acpSession.id, 'running', {
      actorType: 'system',
      acpSdkSessionId: 'sdk-node-hb',
    });

    await svc.updateAcpSessionHeartbeat(testEnv, pid, acpSession.id, 'node-hb');

    const updated = await svc.getAcpSession(testEnv, pid, acpSession.id);
    expect(updated!.lastHeartbeatAt).toBeTruthy();
  });

  it('listAcpSessions filters by chatSessionId', async () => {
    const pid = 'svc-acp-list';
    const chat1 = await svc.createSession(testEnv, pid, null, 'Chat 1');
    const chat2 = await svc.createSession(testEnv, pid, null, 'Chat 2');

    await svc.createAcpSession(testEnv, pid, chat1, 'P1', 'claude-code');
    await svc.createAcpSession(testEnv, pid, chat2, 'P2', 'claude-code');

    const { sessions, total } = await svc.listAcpSessions(testEnv, pid, { chatSessionId: chat1 });
    expect(total).toBe(1);
    expect(sessions[0]!.chatSessionId).toBe(chat1);
  });

  it('forkAcpSession creates a child with incremented depth', async () => {
    const pid = 'svc-acp-fork';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'ACP fork');
    const parent = await svc.createAcpSession(testEnv, pid, chatSessionId, 'Parent', 'claude-code');
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'assigned', { actorType: 'system' });
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'running', { actorType: 'system' });
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'completed', { actorType: 'system' });

    const child = await svc.forkAcpSession(testEnv, pid, parent.id, 'Forking context');

    expect(child.parentSessionId).toBe(parent.id);
    expect(child.forkDepth).toBe(1);
    expect(child.chatSessionId).toBe(chatSessionId);
  });

  it('getAcpSessionLineage returns parent chain', async () => {
    const pid = 'svc-acp-lineage';
    const chatSessionId = await svc.createSession(testEnv, pid, null, 'Lineage');
    const parent = await svc.createAcpSession(testEnv, pid, chatSessionId, 'Root', 'claude-code');
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'assigned', { actorType: 'system' });
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'running', { actorType: 'system' });
    await svc.transitionAcpSession(testEnv, pid, parent.id, 'completed', { actorType: 'system' });
    const child = await svc.forkAcpSession(testEnv, pid, parent.id, 'Fork 1');

    const lineage = await svc.getAcpSessionLineage(testEnv, pid, child.id);
    expect(lineage.length).toBeGreaterThanOrEqual(2);

    const ids = lineage.map((s) => s.id);
    expect(ids).toContain(parent.id);
    expect(ids).toContain(child.id);
  });

  it('updateNodeHeartbeats refreshes all active sessions on a node', async () => {
    const pid = 'svc-acp-node-hb';
    const chat = await svc.createSession(testEnv, pid, null, 'Node HB');
    const acp1 = await svc.createAcpSession(testEnv, pid, chat, 'S1', 'claude-code');
    const acp2 = await svc.createAcpSession(testEnv, pid, chat, 'S2', 'claude-code');

    // Transition both to running on the same node
    await svc.transitionAcpSession(testEnv, pid, acp1.id, 'assigned', {
      actorType: 'system',
      workspaceId: 'ws-1',
      nodeId: 'node-bulk',
    });
    await svc.transitionAcpSession(testEnv, pid, acp1.id, 'running', { actorType: 'system' });
    await svc.transitionAcpSession(testEnv, pid, acp2.id, 'assigned', {
      actorType: 'system',
      workspaceId: 'ws-2',
      nodeId: 'node-bulk',
    });
    await svc.transitionAcpSession(testEnv, pid, acp2.id, 'running', { actorType: 'system' });

    const updated = await svc.updateNodeHeartbeats(testEnv, pid, 'node-bulk');
    expect(updated).toBe(2);
  });
});

// =========================================================================
// 6. Activity Events
// =========================================================================

describe('project-data service: activity events', () => {
  it('recordActivityEvent returns an event id', async () => {
    const pid = 'svc-activity-record';
    const eventId = await svc.recordActivityEvent(
      testEnv,
      pid,
      'workspace.created',
      'system',
      null,
      'ws-act',
      null,
      null,
      { vmSize: 'medium' }
    );
    expect(eventId).toBeTruthy();
    expect(typeof eventId).toBe('string');
  });

  it('listActivityEvents returns events with pagination', async () => {
    const pid = 'svc-activity-list';

    // Create several events
    for (let i = 0; i < 5; i++) {
      await svc.recordActivityEvent(
        testEnv,
        pid,
        'task.completed',
        'agent',
        `agent-${i}`,
        null,
        null,
        `task-${i}`,
        null
      );
    }

    const { events, hasMore } = await svc.listActivityEvents(testEnv, pid, null, 3);
    expect(events).toHaveLength(3);
    expect(hasMore).toBe(true);

    // Each event should have full fields
    for (const event of events) {
      expect(event.id).toBeTruthy();
      expect(event.eventType).toBe('task.completed');
      expect(event.actorType).toBe('agent');
      expect(event.createdAt).toBeTruthy();
    }
  });

  it('listActivityEvents filters by event type', async () => {
    const pid = 'svc-activity-filter';

    await svc.recordActivityEvent(
      testEnv,
      pid,
      'session.started',
      'system',
      null,
      null,
      's1',
      null,
      null
    );
    await svc.recordActivityEvent(
      testEnv,
      pid,
      'workspace.created',
      'user',
      'u1',
      'ws-1',
      null,
      null,
      null
    );
    await svc.recordActivityEvent(
      testEnv,
      pid,
      'session.started',
      'system',
      null,
      null,
      's2',
      null,
      null
    );

    const { events } = await svc.listActivityEvents(testEnv, pid, 'session.started');
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.eventType).toBe('session.started');
    }
  });

  it('recordActivityEvent serializes payload to JSON', async () => {
    const pid = 'svc-activity-payload';
    const payload = { node: 'node-1', duration: 3600, exitCode: 0 };

    await svc.recordActivityEvent(
      testEnv,
      pid,
      'task.completed',
      'agent',
      'a1',
      null,
      null,
      't1',
      payload
    );

    const { events } = await svc.listActivityEvents(testEnv, pid, 'task.completed');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual(payload);
  });

  it('listActivityEvents filters by sessionId', async () => {
    const pid = 'svc-activity-session';

    await svc.recordActivityEvent(
      testEnv,
      pid,
      'task.started',
      'system',
      null,
      null,
      'sess-1',
      null,
      null
    );
    await svc.recordActivityEvent(
      testEnv,
      pid,
      'task.completed',
      'system',
      null,
      null,
      'sess-1',
      null,
      null
    );
    await svc.recordActivityEvent(
      testEnv,
      pid,
      'task.started',
      'system',
      null,
      null,
      'sess-2',
      null,
      null
    );

    const { events: sess1 } = await svc.listActivityEvents(testEnv, pid, null, 50, null, 'sess-1');
    expect(sess1).toHaveLength(2);
    for (const e of sess1) {
      expect(e.sessionId).toBe('sess-1');
    }

    const { events: sess2 } = await svc.listActivityEvents(testEnv, pid, null, 50, null, 'sess-2');
    expect(sess2).toHaveLength(1);
    expect(sess2[0]!.sessionId).toBe('sess-2');
  });

  it('listActivityEvents supports before cursor for pagination', async () => {
    const pid = 'svc-activity-cursor';

    // Create events with slight delays to ensure ordering
    await svc.recordActivityEvent(testEnv, pid, 'event.a', 'system', null, null, null, null, null);
    await new Promise((r) => setTimeout(r, 5));
    await svc.recordActivityEvent(testEnv, pid, 'event.b', 'system', null, null, null, null, null);
    await new Promise((r) => setTimeout(r, 5));
    await svc.recordActivityEvent(testEnv, pid, 'event.c', 'system', null, null, null, null, null);

    // Get all events first
    const { events: all } = await svc.listActivityEvents(testEnv, pid, null, 50);
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Get events before the most recent one
    const beforeTs = all[0]!.createdAt as number;
    const { events: older } = await svc.listActivityEvents(testEnv, pid, null, 50, beforeTs);
    // Should not include the most recent event
    expect(older.length).toBe(all.length - 1);
  });
});

// =========================================================================
// 7. Cross-cutting: ensureProjectId isolation
// =========================================================================

describe('project-data service: project isolation', () => {
  it('sessions are isolated between projects', async () => {
    const pidA = 'svc-iso-project-a';
    const pidB = 'svc-iso-project-b';

    await svc.createSession(testEnv, pidA, null, 'Project A session');
    await svc.createSession(testEnv, pidB, null, 'Project B session');

    const { total: totalA } = await svc.listSessions(testEnv, pidA);
    const { total: totalB } = await svc.listSessions(testEnv, pidB);

    expect(totalA).toBe(1);
    expect(totalB).toBe(1);
  });

  it('activity events are isolated between projects', async () => {
    const pidA = 'svc-iso-activity-a';
    const pidB = 'svc-iso-activity-b';

    await svc.recordActivityEvent(testEnv, pidA, 'test.a', 'system', null, null, null, null, null);
    await svc.recordActivityEvent(testEnv, pidB, 'test.b', 'system', null, null, null, null, null);

    const { events: eventsA } = await svc.listActivityEvents(testEnv, pidA);
    const { events: eventsB } = await svc.listActivityEvents(testEnv, pidB);

    // Should only see the event from each respective project
    // (activity events from createSession may also appear)
    const testEventsA = eventsA.filter((e) => e.eventType === 'test.a');
    const testEventsB = eventsB.filter((e) => e.eventType === 'test.b');
    expect(testEventsA).toHaveLength(1);
    expect(testEventsB).toHaveLength(1);

    // Cross-check: project A should not have test.b events
    const crossA = eventsA.filter((e) => e.eventType === 'test.b');
    expect(crossA).toHaveLength(0);
  });
});
