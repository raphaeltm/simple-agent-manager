import { describe, expect, it } from 'vitest';

import { buildDebugReport } from '../../src/components/debug/debug-report';

describe('buildDebugReport', () => {
  it('includes task/session/workspace/node IDs', () => {
    const report = buildDebugReport({
      taskId: 'task-abc',
      sessionId: 'sess-xyz',
      workspaceId: 'ws-123',
      nodeId: 'node-456',
      projectId: 'proj-789',
      status: 'failed',
      executionStep: 'running',
      classificationCode: 'agent-crash',
      errorMessage: 'Process exited with code 137',
    });

    expect(report).toContain('Task: task-abc');
    expect(report).toContain('Session: sess-xyz');
    expect(report).toContain('Workspace: ws-123');
    expect(report).toContain('Node: node-456');
    expect(report).toContain('Project: proj-789');
    expect(report).toContain('Status: failed');
    expect(report).toContain('Step: running');
    expect(report).toContain('Classification: agent-crash');
    expect(report).toContain('Process exited with code 137');
  });

  it('omits null/undefined fields', () => {
    const report = buildDebugReport({
      taskId: 'task-abc',
      sessionId: null,
      workspaceId: undefined,
    });

    expect(report).toContain('Task: task-abc');
    expect(report).not.toContain('Session:');
    expect(report).not.toContain('Workspace:');
  });

  it('includes status events with timestamps', () => {
    const events = [
      {
        id: 'ev-1',
        taskId: 'task-1',
        fromStatus: null as string | null,
        toStatus: 'ready',
        actorType: 'system',
        actorId: null as string | null,
        reason: null as string | null,
        createdAt: '2026-08-07T10:00:00.000Z',
      },
      {
        id: 'ev-2',
        taskId: 'task-1',
        fromStatus: 'ready',
        toStatus: 'failed',
        actorType: 'agent',
        actorId: 'a1',
        reason: 'Server crashed',
        createdAt: '2026-08-07T10:05:00.000Z',
      },
    ];

    const report = buildDebugReport({
      taskId: 'task-1',
      events,
    });

    expect(report).toContain('### Status Events');
    expect(report).toContain('2026-08-07T10:00:00.000Z ready');
    expect(report).toContain('ready → failed [agent] — Server crashed');
  });

  it('limits events to maxEvents', () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      id: `ev-${i}`,
      taskId: 'task-1',
      fromStatus: null as string | null,
      toStatus: 'ready',
      actorType: 'system',
      actorId: null as string | null,
      reason: `Event ${i}`,
      createdAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
    }));

    const report = buildDebugReport({ taskId: 'task-1', events, maxEvents: 5 });

    const eventLines = report.split('\n').filter((l) => /Event \d+/.test(l));
    expect(eventLines.length).toBe(5);
    expect(report).toContain('Event 15');
    expect(report).toContain('Event 19');
    expect(report).not.toContain('Event 0');
  });

  it('wraps in fenced code block', () => {
    const report = buildDebugReport({ taskId: 'task-1' });
    expect(report.startsWith('```')).toBe(true);
    expect(report.endsWith('```')).toBe(true);
  });
});
