/**
 * Integration tests for attention markers in ProjectData DO.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

describe('Attention Markers', () => {
  it('creates a marker with correct fields', async () => {
    const stub = getStub('attn-create-1');
    const sessionId = await stub.createSession(null, 'Attention test');
    const expiresAt = Date.now() + 7200000;
    const result = await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Need approval',
      expiresAt,
    });

    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('lists active markers for a session', async () => {
    const stub = getStub('attn-list-1');
    const sessionId = await stub.createSession(null, 'List test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_review',
      source: 'test',
    });

    const markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(2);
    expect(markers[0].kind).toBe('needs_review'); // DESC order
    expect(markers[1].kind).toBe('needs_input');
  });

  it('resolves markers when a human message is persisted', async () => {
    const stub = getStub('attn-resolve-msg-1');
    const sessionId = await stub.createSession(null, 'Resolve test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
      reason: 'Waiting for input',
    });

    // Verify marker is active
    let markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(1);

    // Persist a human message — should resolve the marker
    await stub.persistMessage(sessionId, 'user', 'Here is my input', null);

    // Verify marker is now resolved
    markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(0);
  });

  it('does not resolve markers on assistant messages', async () => {
    const stub = getStub('attn-no-resolve-assistant-1');
    const sessionId = await stub.createSession(null, 'No resolve test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    await stub.persistMessage(sessionId, 'assistant', 'Still working...', null);

    const markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(1);
  });

  it('resolves only reconciliation check-ins on assistant messages', async () => {
    const stub = getStub('attn-resolve-reconciliation-assistant-1');
    const sessionId = await stub.createSession(null, 'Assistant resolves check-in test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Need a human decision',
    });
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      reason: 'Agent idle — SAM check-in sent',
    });

    await stub.persistMessage(sessionId, 'assistant', 'I am still working on this.', null);

    const markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('needs_input');
  });

  it('resolves markers on human message in batch', async () => {
    const stub = getStub('attn-resolve-batch-1');
    const sessionId = await stub.createSession(null, 'Batch resolve test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    await stub.persistMessageBatch(sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'Thinking...',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'Go ahead',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);

    const markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(0);
  });

  it('does not resolve markers on a SAM-injected (origin=system) user message', async () => {
    const stub = getStub('attn-resolve-system-excluded');
    const sessionId = await stub.createSession(null, 'System origin resolve test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    // A batch whose only user message is system-injected must NOT resolve the
    // marker — injected instructions are not a human reply.
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'IMPORTANT: call get_instructions first',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
        origin: 'system',
      },
    ]);
    expect(await stub.listActiveAttentionMarkers(sessionId)).toHaveLength(1);

    // A real human message DOES resolve it.
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'Go ahead',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(await stub.listActiveAttentionMarkers(sessionId)).toHaveLength(0);
  });

  it('returns attention summary for session enrichment', async () => {
    const stub = getStub('attn-summary-1');
    const sessionId = await stub.createSession(null, 'Summary test');

    let summary = await stub.getSessionAttentionSummary(sessionId);
    expect(summary).toBeNull();

    const expiresAt = Date.now() + 3600000;
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
      reason: 'Please review',
      expiresAt,
    });

    summary = await stub.getSessionAttentionSummary(sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.kind).toBe('needs_input');
    expect(summary!.reason).toBe('Please review');
    expect(summary!.expiresAt).toBe(expiresAt);
  });

  it('includes attention summary in session list', async () => {
    const stub = getStub('attn-session-list-1');
    const sessionId = await stub.createSession(null, 'Session list test');

    let { sessions } = await stub.listSessions(null, 10, 0);
    let session = sessions.find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session!.attention).toBeNull();

    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    ({ sessions } = await stub.listSessions(null, 10, 0));
    session = sessions.find((s) => s.id === sessionId);
    expect(session!.attention).not.toBeNull();
    expect((session!.attention as { kind: string }).kind).toBe('needs_input');
  });

  it('includes attention summary in getSession', async () => {
    const stub = getStub('attn-get-session-1');
    const sessionId = await stub.createSession(null, 'Get session test');

    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    const session = await stub.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.attention).not.toBeNull();
    expect((session!.attention as { kind: string }).kind).toBe('needs_input');
  });

  it('resolves markers explicitly via resolveSessionAttentionMarkers', async () => {
    const stub = getStub('attn-explicit-resolve-1');
    const sessionId = await stub.createSession(null, 'Explicit resolve test');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
    });

    const count = await stub.resolveSessionAttentionMarkers(
      sessionId,
      null,
      'system',
      'task_completed'
    );
    // SqlStorage rowsWritten can include internal bookkeeping in workerd; the
    // state assertion below proves every active marker was resolved.
    expect(count).toBeGreaterThanOrEqual(1);

    const markers = await stub.listActiveAttentionMarkers(sessionId);
    expect(markers).toHaveLength(0);
  });
});
