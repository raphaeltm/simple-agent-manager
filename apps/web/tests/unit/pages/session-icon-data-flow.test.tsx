/**
 * Data flow test: session icon states.
 *
 * This is a "vertical slice" test — it mocks the API boundary and asserts
 * that data flows correctly through the full transformation chain:
 *
 *   API response (session list without task data)
 *   + API response (task list with status)
 *   → taskInfoMap construction
 *   → session enrichment in SessionTreeItem
 *   → getAttentionState() inside SessionItem
 *   → correct icon rendered
 *
 * The bug this catches: the session list endpoint returns sessions with
 * `taskId` but no `task.status`. Task status lives in a separate API
 * response. If the enrichment step is missing, every terminated task
 * renders as a gray pause icon instead of a green checkmark or red X.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatSessionListItem, ChatSessionResponse } from '../../../src/lib/api';
import { SessionItem } from '../../../src/pages/project-chat/SessionItem';
import { SessionTreeItem } from '../../../src/pages/project-chat/SessionTreeItem';
import type { TaskInfo } from '../../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers — simulate the shapes returned by the API
// ---------------------------------------------------------------------------

/** Base session fields shared by list and detail shapes. */
const SESSION_DEFAULTS: ChatSessionListItem = {
  id: 'sess-1',
  workspaceId: null,
  taskId: null,
  topic: 'Test session',
  status: 'active',
  messageCount: 5,
  startedAt: Date.now() - 60_000,
  endedAt: null,
  createdAt: Date.now() - 60_000,
  lastMessageAt: Date.now(),
  isIdle: false,
  agentCompletedAt: null,
};

/** Simulate a session as returned by the list endpoint (no task embed). */
function makeListSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return { ...SESSION_DEFAULTS, ...overrides };
}

/** Simulate a session as returned by the detail endpoint (with optional task embed). */
function makeDetailSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return { ...SESSION_DEFAULTS, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Pure data flow: getAttentionState sees task status through enrichment
// ---------------------------------------------------------------------------

describe('Session icon data flow: list session + task status → correct icon', () => {
  /**
   * This group tests the SEAM that was broken: sessions from the list API
   * have `taskId` but no `task.status`. The `taskInfoMap` has the status.
   * SessionTreeItem must merge them before SessionItem calls getAttentionState.
   */

  const cases: Array<{
    label: string;
    taskStatus: string;
    sessionStatus: string;
    expectedTitle: string;
  }> = [
    {
      label: 'completed task shows checkmark',
      taskStatus: 'completed',
      sessionStatus: 'stopped',
      expectedTitle: 'Completed',
    },
    {
      label: 'failed task shows X',
      taskStatus: 'failed',
      sessionStatus: 'stopped',
      expectedTitle: 'Failed',
    },
    {
      label: 'cancelled task shows pause',
      taskStatus: 'cancelled',
      sessionStatus: 'stopped',
      expectedTitle: 'Stopped',
    },
    {
      label: 'in-progress task with active session shows spinner',
      taskStatus: 'in_progress',
      sessionStatus: 'active',
      expectedTitle: 'Running',
    },
  ];

  for (const { label, taskStatus, sessionStatus, expectedTitle } of cases) {
    it(label, () => {
      const session = makeListSession({
        taskId: 'task-1',
        status: sessionStatus,
      });

      const taskInfoMap = new Map<string, TaskInfo>([
        ['task-1', {
          id: 'task-1',
          title: 'Test task',
          parentTaskId: null,
          status: taskStatus as TaskInfo['status'],
          blocked: false,
          triggeredBy: 'user',
          dispatchDepth: 0,
          taskMode: 'task',
        }],
      ]);

      const { container } = render(
        <SessionTreeItem
          session={session}
          selectedSessionId={null}
          onSelect={() => {}}
          taskInfoMap={taskInfoMap}
        />,
      );

      const iconSpan = container.querySelector(`[title="${expectedTitle}"]`);
      expect(iconSpan, `Expected icon with title="${expectedTitle}" for ${label}`).toBeTruthy();
    });
  }

  it('session without task shows correct lifecycle icon', () => {
    const session = makeListSession({
      status: 'active',
      isIdle: true,
      agentCompletedAt: Date.now(),
    });

    const { container } = render(
      <SessionTreeItem
        session={session}
        selectedSessionId={null}
        onSelect={() => {}}
        taskInfoMap={new Map()}
      />,
    );

    const iconSpan = container.querySelector('[title="Idle"]');
    expect(iconSpan, 'Idle conversation should show Idle icon').toBeTruthy();
  });

  it('needs_input attention marker overrides task status', () => {
    const session = makeListSession({
      taskId: 'task-1',
      status: 'active',
      attention: { kind: 'needs_input', createdAt: Date.now(), expiresAt: null, reason: 'Waiting for approval' },
    });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['task-1', {
        id: 'task-1',
        title: 'Test task',
        parentTaskId: null,
        status: 'in_progress',
        blocked: false,
        triggeredBy: 'user',
        dispatchDepth: 0,
        taskMode: 'task',
      }],
    ]);

    const { container } = render(
      <SessionTreeItem
        session={session}
        selectedSessionId={null}
        onSelect={() => {}}
        taskInfoMap={taskInfoMap}
      />,
    );

    const iconSpan = container.querySelector('[title="Needs input"]');
    expect(iconSpan, 'needs_input attention should override in_progress task').toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Regression guard: session that already has task embed is preserved
// ---------------------------------------------------------------------------

describe('Session with existing task embed (detail endpoint)', () => {
  it('preserves task data from detail endpoint without overwriting', () => {
    const session = makeDetailSession({
      taskId: 'task-1',
      status: 'stopped',
      task: {
        id: 'task-1',
        status: 'completed',
        outputBranch: 'feature/foo',
        outputPrUrl: 'https://github.com/org/repo/pull/42',
      },
    });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['task-1', {
        id: 'task-1',
        title: 'Test task',
        parentTaskId: null,
        status: 'completed',
        blocked: false,
        triggeredBy: 'user',
        dispatchDepth: 0,
        taskMode: 'task',
      }],
    ]);

    const { container } = render(
      <SessionTreeItem
        session={session}
        selectedSessionId={null}
        onSelect={() => {}}
        taskInfoMap={taskInfoMap}
      />,
    );

    const iconSpan = container.querySelector('[title="Completed"]');
    expect(iconSpan, 'Session with existing task embed should show Completed').toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. Direct SessionItem test for all attention states (icon map coverage)
// ---------------------------------------------------------------------------

describe('SessionItem renders correct icon for each attention state', () => {
  const iconCases: Array<{
    label: string;
    session: Partial<ChatSessionResponse>;
    expectedTitle: string;
  }> = [
    { label: 'active', session: { status: 'active' }, expectedTitle: 'Running' },
    { label: 'idle', session: { status: 'active', isIdle: true, agentCompletedAt: Date.now() }, expectedTitle: 'Idle' },
    { label: 'completed', session: { status: 'stopped', task: { id: 't', status: 'completed' } }, expectedTitle: 'Completed' },
    { label: 'failed', session: { status: 'stopped', task: { id: 't', status: 'failed' } }, expectedTitle: 'Failed' },
    { label: 'stopped', session: { status: 'stopped' }, expectedTitle: 'Stopped' },
    { label: 'error', session: { status: 'failed' }, expectedTitle: 'Error' },
    { label: 'needs_input', session: { status: 'active', attention: { kind: 'needs_input', createdAt: Date.now(), expiresAt: null, reason: null } }, expectedTitle: 'Needs input' },
  ];

  for (const { label, session, expectedTitle } of iconCases) {
    it(`renders "${expectedTitle}" icon for ${label} state`, () => {
      const { container } = render(
        <SessionItem
          session={makeDetailSession(session)}
          isSelected={false}
          onSelect={() => {}}
        />,
      );

      const iconSpan = container.querySelector(`[title="${expectedTitle}"]`);
      expect(iconSpan, `Expected icon titled "${expectedTitle}" for ${label}`).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Session mode: conversation-mode sessions show correct mode icon
// ---------------------------------------------------------------------------

describe('Session mode enrichment: conversation vs task', () => {
  it('conversation-mode session shows MessageSquare icon, not ListTodo', () => {
    const session = makeListSession({
      taskId: 'task-conv',
      status: 'active',
    });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['task-conv', {
        id: 'task-conv',
        title: 'Conversation task',
        parentTaskId: null,
        status: 'in_progress',
        blocked: false,
        triggeredBy: 'user',
        dispatchDepth: 0,
        taskMode: 'conversation',
      }],
    ]);

    const { container } = render(
      <SessionTreeItem
        session={session}
        selectedSessionId={null}
        onSelect={() => {}}
        taskInfoMap={taskInfoMap}
      />,
    );

    const modeLabel = container.querySelector('[title="Conversation"]');
    expect(modeLabel, 'Conversation-mode session should have title="Conversation"').toBeTruthy();
  });

  it('task-mode session shows ListTodo icon', () => {
    const session = makeListSession({
      taskId: 'task-auto',
      status: 'active',
    });

    const taskInfoMap = new Map<string, TaskInfo>([
      ['task-auto', {
        id: 'task-auto',
        title: 'Autonomous task',
        parentTaskId: null,
        status: 'in_progress',
        blocked: false,
        triggeredBy: 'user',
        dispatchDepth: 0,
        taskMode: 'task',
      }],
    ]);

    const { container } = render(
      <SessionTreeItem
        session={session}
        selectedSessionId={null}
        onSelect={() => {}}
        taskInfoMap={taskInfoMap}
      />,
    );

    const modeLabel = container.querySelector('[title="Task"]');
    expect(modeLabel, 'Task-mode session should have title="Task"').toBeTruthy();
  });
});
