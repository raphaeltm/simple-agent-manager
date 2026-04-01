/**
 * Unit tests for Valibot-validated DO SQLite row mappers.
 *
 * Tests verify:
 * - Valid rows parse and transform correctly (snake_case → camelCase)
 * - Missing required fields throw descriptive errors
 * - Wrong field types throw descriptive errors
 * - Nullable fields handle null correctly
 * - JSON string fields are parsed (toolMetadata, payload)
 * - Aggregate helpers extract the correct scalar value
 */
import { describe, it, expect } from 'vitest';
import {
  parseRow,
  parseRows,
  parseCountCnt,
  parseCount,
  parseMaxSeq,
  parseMinEarliest,
  parseMaxLatest,
  parseMessageCount,
  parseWorkspaceId,
  parseEnabled,
  parseCleanupAt,
  parseAcpSessionRow,
  parseAcpSessionHeartbeatCheck,
  parseAcpSessionLineage,
  parseAcpSessionStale,
  parseChatMessageRow,
  parseSearchResultRow,
  parseChatSessionListRow,
  parseSessionStop,
  parseSessionStatus,
  parseMaterializationCheck,
  parseMaterializationToken,
  parseRowid,
  parseSessionId,
  parseIdleCleanupSchedule,
  parseWorkspaceActivity,
  parseSessionIdeaLink,
  parseIdeaSessionDetail,
  parseCachedCommandRow,
  parseActivityEventRow,
  parseMigrationName,
  parseMaxVersion,
  parseMetaValue,
} from '../../../src/durable-objects/project-data/row-schemas';
import * as v from 'valibot';

// =============================================================================
// Generic helpers
// =============================================================================

describe('parseRow', () => {
  const TestSchema = v.object({ name: v.string(), age: v.number() });

  it('parses valid row', () => {
    expect(parseRow(TestSchema, { name: 'Alice', age: 30 }, 'test')).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('throws descriptive error for missing field', () => {
    expect(() => parseRow(TestSchema, { name: 'Alice' }, 'test')).toThrow(
      /Row validation failed \(test\)/
    );
  });

  it('throws descriptive error for wrong type', () => {
    expect(() => parseRow(TestSchema, { name: 123, age: 30 }, 'test')).toThrow(
      /Row validation failed \(test\)/
    );
  });

  it('includes context in error message', () => {
    expect(() => parseRow(TestSchema, {}, 'my_context')).toThrow('my_context');
  });

  it('includes field path in error message', () => {
    expect(() => parseRow(TestSchema, { name: 'Alice' }, 'ctx')).toThrow(/age/);
  });

  it('handles null row input', () => {
    expect(() => parseRow(TestSchema, null, 'ctx')).toThrow(/Row validation failed \(ctx\)/);
  });

  it('handles non-object row input', () => {
    expect(() => parseRow(TestSchema, 'not-an-object', 'ctx')).toThrow(/Row validation failed \(ctx\)/);
  });
});

describe('parseRows', () => {
  const TestSchema = v.object({ id: v.string() });

  it('parses array of valid rows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(parseRows(TestSchema, rows, 'test')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('includes index in error context', () => {
    expect(() => parseRows(TestSchema, [{ id: 'a' }, { id: 123 }], 'test')).toThrow(
      /test\[1\]/
    );
  });
});

// =============================================================================
// Aggregate / utility parsers
// =============================================================================

describe('aggregate parsers', () => {
  it('parseCountCnt extracts cnt', () => {
    expect(parseCountCnt({ cnt: 42 }, 'test')).toBe(42);
  });

  it('parseCountCnt rejects missing cnt', () => {
    expect(() => parseCountCnt({}, 'test')).toThrow(/Row validation failed/);
  });

  it('parseCount extracts count', () => {
    expect(parseCount({ count: 7 }, 'test')).toBe(7);
  });

  it('parseMaxSeq extracts max_seq', () => {
    expect(parseMaxSeq({ max_seq: 99 }, 'test')).toBe(99);
  });

  it('parseMinEarliest returns number', () => {
    expect(parseMinEarliest({ earliest: 1000 }, 'test')).toBe(1000);
  });

  it('parseMinEarliest returns null', () => {
    expect(parseMinEarliest({ earliest: null }, 'test')).toBeNull();
  });

  it('parseMaxLatest returns number', () => {
    expect(parseMaxLatest({ latest: 2000 }, 'test')).toBe(2000);
  });

  it('parseMaxLatest returns null', () => {
    expect(parseMaxLatest({ latest: null }, 'test')).toBeNull();
  });

  it('parseMessageCount extracts message_count', () => {
    expect(parseMessageCount({ message_count: 5 }, 'test')).toBe(5);
  });

  it('parseWorkspaceId extracts string', () => {
    expect(parseWorkspaceId({ workspace_id: 'ws-1' }, 'test')).toBe('ws-1');
  });

  it('parseWorkspaceId returns null', () => {
    expect(parseWorkspaceId({ workspace_id: null }, 'test')).toBeNull();
  });

  it('parseEnabled returns true for 1', () => {
    expect(parseEnabled({ enabled: 1 }, 'test')).toBe(true);
  });

  it('parseEnabled returns false for 0', () => {
    expect(parseEnabled({ enabled: 0 }, 'test')).toBe(false);
  });

  it('parseCleanupAt extracts cleanup_at', () => {
    expect(parseCleanupAt({ cleanup_at: 12345 }, 'test')).toBe(12345);
  });
});

// =============================================================================
// ACP Session parsers
// =============================================================================

describe('parseAcpSessionRow', () => {
  const validRow = {
    id: 'acp-1',
    chat_session_id: 'cs-1',
    workspace_id: 'ws-1',
    node_id: 'node-1',
    status: 'running',
    agent_type: 'claude',
    initial_prompt: 'hello',
    parent_session_id: null,
    fork_depth: 0,
    acp_sdk_session_id: 'sdk-1',
    error_message: null,
    last_heartbeat_at: 1000,
    assigned_at: 900,
    started_at: 950,
    completed_at: null,
    interrupted_at: null,
    created_at: 800,
    updated_at: 1000,
  };

  it('parses valid full ACP session row', () => {
    const result = parseAcpSessionRow(validRow);
    expect(result.id).toBe('acp-1');
    expect(result.chatSessionId).toBe('cs-1');
    expect(result.workspaceId).toBe('ws-1');
    expect(result.nodeId).toBe('node-1');
    expect(result.status).toBe('running');
    expect(result.agentType).toBe('claude');
    expect(result.forkDepth).toBe(0);
    expect(result.completedAt).toBeNull();
  });

  it('rejects invalid status value', () => {
    expect(() => parseAcpSessionRow({ ...validRow, status: 'invalid_status' })).toThrow(
      /Row validation failed/
    );
  });

  it('handles all nullable fields as null', () => {
    const nullRow = {
      ...validRow,
      workspace_id: null,
      node_id: null,
      agent_type: null,
      initial_prompt: null,
      acp_sdk_session_id: null,
      error_message: null,
      last_heartbeat_at: null,
      assigned_at: null,
      started_at: null,
      completed_at: null,
      interrupted_at: null,
    };
    const result = parseAcpSessionRow(nullRow);
    expect(result.workspaceId).toBeNull();
    expect(result.nodeId).toBeNull();
    expect(result.lastHeartbeatAt).toBeNull();
  });
});

describe('parseAcpSessionHeartbeatCheck', () => {
  it('maps snake_case to camelCase', () => {
    const result = parseAcpSessionHeartbeatCheck({ id: 'a', node_id: 'n1', status: 'running' });
    expect(result).toEqual({ id: 'a', nodeId: 'n1', status: 'running' });
  });

  it('handles null node_id', () => {
    const result = parseAcpSessionHeartbeatCheck({ id: 'a', node_id: null, status: 'pending' });
    expect(result.nodeId).toBeNull();
  });
});

describe('parseAcpSessionLineage', () => {
  it('parses lineage row', () => {
    expect(parseAcpSessionLineage({ id: 'a', parent_session_id: 'p1' })).toEqual({
      id: 'a',
      parentSessionId: 'p1',
    });
  });

  it('handles null parent', () => {
    expect(parseAcpSessionLineage({ id: 'a', parent_session_id: null }).parentSessionId).toBeNull();
  });
});

describe('parseAcpSessionStale', () => {
  it('maps all fields correctly', () => {
    const result = parseAcpSessionStale({
      id: 's1',
      chat_session_id: 'cs1',
      workspace_id: 'ws1',
      node_id: 'n1',
      last_heartbeat_at: 5000,
    });
    expect(result).toEqual({
      id: 's1',
      chatSessionId: 'cs1',
      workspaceId: 'ws1',
      nodeId: 'n1',
      lastHeartbeatAt: 5000,
    });
  });
});

// =============================================================================
// Chat message parsers
// =============================================================================

describe('parseChatMessageRow', () => {
  it('parses valid message and parses JSON toolMetadata', () => {
    const result = parseChatMessageRow({
      id: 'm1',
      session_id: 's1',
      role: 'assistant',
      content: 'hello',
      tool_metadata: '{"tool":"search"}',
      created_at: 1000,
      sequence: 5,
    });
    expect(result.id).toBe('m1');
    expect(result.sessionId).toBe('s1');
    expect(result.toolMetadata).toEqual({ tool: 'search' });
    expect(result.sequence).toBe(5);
  });

  it('handles null tool_metadata', () => {
    const result = parseChatMessageRow({
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: 'hi',
      tool_metadata: null,
      created_at: 1000,
      sequence: null,
    });
    expect(result.toolMetadata).toBeNull();
    expect(result.sequence).toBeNull();
  });

  it('throws on invalid JSON in tool_metadata', () => {
    expect(() =>
      parseChatMessageRow({
        id: 'm1',
        session_id: 's1',
        role: 'user',
        content: 'hi',
        tool_metadata: 'not-json',
        created_at: 1000,
        sequence: null,
      })
    ).toThrow();
  });
});

describe('parseSearchResultRow', () => {
  it('maps search result fields', () => {
    const result = parseSearchResultRow({
      id: 'r1',
      session_id: 's1',
      role: 'assistant',
      content: 'found it',
      created_at: 2000,
      session_topic: 'test topic',
      session_task_id: 't1',
    });
    expect(result.sessionId).toBe('s1');
    expect(result.sessionTopic).toBe('test topic');
    expect(result.sessionTaskId).toBe('t1');
  });
});

// =============================================================================
// Chat session parsers
// =============================================================================

describe('parseChatSessionListRow', () => {
  const baseRow = {
    id: 'cs1',
    workspace_id: 'ws1',
    task_id: 't1',
    topic: 'My topic',
    status: 'active',
    message_count: 10,
    started_at: 1000,
    ended_at: null,
    created_at: 900,
    updated_at: 1100,
    agent_completed_at: null,
  };

  it('transforms to camelCase with computed fields', () => {
    const result = parseChatSessionListRow(baseRow);
    expect(result.id).toBe('cs1');
    expect(result.workspaceId).toBe('ws1');
    expect(result.isIdle).toBe(false);
    expect(result.isTerminated).toBe(false);
    expect(result.workspaceUrl).toBeNull();
    expect(result.cleanupAt).toBeNull();
  });

  it('marks idle when active + agent completed', () => {
    const result = parseChatSessionListRow({ ...baseRow, agent_completed_at: 1050 });
    expect(result.isIdle).toBe(true);
  });

  it('marks terminated when stopped', () => {
    const result = parseChatSessionListRow({ ...baseRow, status: 'stopped' });
    expect(result.isTerminated).toBe(true);
  });

  it('handles optional cleanup_at from LEFT JOIN', () => {
    const result = parseChatSessionListRow({ ...baseRow, cleanup_at: 5000 });
    expect(result.cleanupAt).toBe(5000);
  });

  it('handles missing cleanup_at (no LEFT JOIN match)', () => {
    // When there's no match in idle_cleanup_schedule, cleanup_at is absent
    const result = parseChatSessionListRow(baseRow);
    expect(result.cleanupAt).toBeNull();
  });

  it('is not idle when status is stopped even with agent_completed_at', () => {
    const result = parseChatSessionListRow({ ...baseRow, status: 'stopped', agent_completed_at: 1050 });
    expect(result.isIdle).toBe(false);
  });
});

describe('parseSessionStop', () => {
  it('extracts workspace_id and message_count', () => {
    expect(parseSessionStop({ workspace_id: 'ws1', message_count: 15 })).toEqual({
      workspaceId: 'ws1',
      messageCount: 15,
    });
  });

  it('handles null workspace_id', () => {
    expect(parseSessionStop({ workspace_id: null, message_count: 0 }).workspaceId).toBeNull();
  });
});

describe('parseSessionStatus', () => {
  it('returns id and status', () => {
    expect(parseSessionStatus({ id: 's1', status: 'active' })).toEqual({
      id: 's1',
      status: 'active',
    });
  });
});

// =============================================================================
// Materialization parsers
// =============================================================================

describe('parseMaterializationCheck', () => {
  it('parses with materialized_at value', () => {
    const result = parseMaterializationCheck({ materialized_at: 5000, status: 'stopped' });
    expect(result).toEqual({ materializedAt: 5000, status: 'stopped' });
  });

  it('handles null materialized_at', () => {
    expect(parseMaterializationCheck({ materialized_at: null, status: 'active' }).materializedAt).toBeNull();
  });
});

describe('parseMaterializationToken', () => {
  it('maps token row', () => {
    const result = parseMaterializationToken({
      id: 'tok1',
      role: 'assistant',
      content: 'chunk',
      created_at: 3000,
    });
    expect(result).toEqual({ id: 'tok1', role: 'assistant', content: 'chunk', createdAt: 3000 });
  });
});

describe('parseRowid', () => {
  it('extracts rowid', () => {
    expect(parseRowid({ rowid: 42 }, 'test')).toBe(42);
  });
});

describe('parseSessionId', () => {
  it('extracts id', () => {
    expect(parseSessionId({ id: 's1' }, 'test')).toBe('s1');
  });
});

// =============================================================================
// Idle cleanup parsers
// =============================================================================

describe('parseIdleCleanupSchedule', () => {
  it('maps cleanup schedule row', () => {
    const result = parseIdleCleanupSchedule({
      session_id: 's1',
      workspace_id: 'ws1',
      task_id: 't1',
      retry_count: 2,
    });
    expect(result).toEqual({
      sessionId: 's1',
      workspaceId: 'ws1',
      taskId: 't1',
      retryCount: 2,
    });
  });

  it('handles null task_id', () => {
    const result = parseIdleCleanupSchedule({
      session_id: 's1',
      workspace_id: 'ws1',
      task_id: null,
      retry_count: 0,
    });
    expect(result.taskId).toBeNull();
  });
});

describe('parseWorkspaceActivity', () => {
  it('maps workspace activity with defaults for nulls', () => {
    const result = parseWorkspaceActivity({
      workspace_id: 'ws1',
      session_id: null,
      last_terminal_activity_at: null,
      last_message_at: null,
      session_updated_at: null,
    });
    expect(result.workspaceId).toBe('ws1');
    expect(result.lastTerminalActivityAt).toBe(0);
    expect(result.lastMessageAt).toBe(0);
    expect(result.sessionUpdatedAt).toBe(0);
  });

  it('preserves actual values when non-null', () => {
    const result = parseWorkspaceActivity({
      workspace_id: 'ws1',
      session_id: 's1',
      last_terminal_activity_at: 1000,
      last_message_at: 2000,
      session_updated_at: 3000,
    });
    expect(result.lastTerminalActivityAt).toBe(1000);
    expect(result.lastMessageAt).toBe(2000);
    expect(result.sessionUpdatedAt).toBe(3000);
  });
});

// =============================================================================
// Session–Idea link parsers
// =============================================================================

describe('parseSessionIdeaLink', () => {
  it('maps idea link row', () => {
    const result = parseSessionIdeaLink({ task_id: 't1', context: 'related to', created_at: 1000 });
    expect(result).toEqual({ taskId: 't1', context: 'related to', createdAt: 1000 });
  });
});

describe('parseIdeaSessionDetail', () => {
  it('maps idea session detail', () => {
    const result = parseIdeaSessionDetail({
      session_id: 's1',
      topic: 'topic',
      status: 'active',
      context: 'ctx',
      created_at: 1000,
    });
    expect(result).toEqual({
      sessionId: 's1',
      topic: 'topic',
      status: 'active',
      context: 'ctx',
      linkedAt: 1000,
    });
  });
});

// =============================================================================
// Cached command parsers
// =============================================================================

describe('parseCachedCommandRow', () => {
  it('maps cached command row', () => {
    const result = parseCachedCommandRow({
      agent_type: 'claude',
      name: '/help',
      description: 'Get help',
      updated_at: 5000,
    });
    expect(result).toEqual({
      agentType: 'claude',
      name: '/help',
      description: 'Get help',
      updatedAt: 5000,
    });
  });
});

// =============================================================================
// Activity event parsers
// =============================================================================

describe('parseActivityEventRow', () => {
  it('maps activity event and parses JSON payload', () => {
    const result = parseActivityEventRow({
      id: 'ae1',
      event_type: 'task_started',
      actor_type: 'user',
      actor_id: 'u1',
      workspace_id: 'ws1',
      session_id: 's1',
      task_id: 't1',
      payload: '{"key":"value"}',
      created_at: 1000,
    });
    expect(result.eventType).toBe('task_started');
    expect(result.payload).toEqual({ key: 'value' });
  });

  it('handles null payload', () => {
    const result = parseActivityEventRow({
      id: 'ae1',
      event_type: 'task_started',
      actor_type: 'system',
      actor_id: null,
      workspace_id: null,
      session_id: null,
      task_id: null,
      payload: null,
      created_at: 1000,
    });
    expect(result.payload).toBeNull();
    expect(result.actorId).toBeNull();
  });

  it('throws on invalid JSON in payload', () => {
    expect(() =>
      parseActivityEventRow({
        id: 'ae1',
        event_type: 'task_started',
        actor_type: 'system',
        actor_id: null,
        workspace_id: null,
        session_id: null,
        task_id: null,
        payload: 'not-json',
        created_at: 1000,
      })
    ).toThrow();
  });
});

// =============================================================================
// Migration / meta parsers
// =============================================================================

describe('parseMigrationName', () => {
  it('extracts migration name', () => {
    expect(parseMigrationName({ name: '001-initial-schema' })).toBe('001-initial-schema');
  });

  it('rejects non-string name', () => {
    expect(() => parseMigrationName({ name: 123 })).toThrow(/Row validation failed/);
  });
});

describe('parseMaxVersion', () => {
  it('extracts max_version number', () => {
    expect(parseMaxVersion({ max_version: 5 })).toBe(5);
  });

  it('returns 0 for null', () => {
    expect(parseMaxVersion({ max_version: null })).toBe(0);
  });
});

describe('parseMetaValue', () => {
  it('extracts value string', () => {
    expect(parseMetaValue({ value: 'project-123' }, 'test')).toBe('project-123');
  });
});
