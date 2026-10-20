import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperatorStore } from '../../../src/durable-objects/sam-session/operator/store';
import { createSqlStorage } from './sql-storage-test-utils';

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  const sql = createSqlStorage(db);
  return { db, sql, store: new OperatorStore(sql) };
}
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

describe('private SAM durable turn contracts', () => {
  it('defaults existing and new instances OFF and persists explicit opt-in across reconstruction', () => {
    const { store, sql } = fixture();
    expect(store.settings().enabled).toBe(false);
    expect(() => store.accept('a', 'hello')).toThrow('SAM_DISABLED');
    store.bindUser('alice');
    store.setEnabled(true);
    expect(new OperatorStore(sql).settings()).toMatchObject({
      enabled: true,
      userId: 'alice',
      generation: 1,
    });
    expect(() => store.bindUser('bob')).toThrow('identity mismatch');
  });

  it('deduplicates accepted messages, rejects changed payloads and competing turns', () => {
    const { store } = fixture();
    store.setEnabled(true);
    const accepted = store.accept('request-a', 'start one task');
    expect(store.accept('request-a', 'start one task')).toEqual({
      turn: accepted.turn,
      replayed: true,
    });
    expect(() => store.accept('request-a', 'start something else')).toThrow('REQUEST_KEY_CONFLICT');
    expect(() => store.accept('request-b', 'second turn')).toThrow('TURN_ACTIVE');
    store.setState(accepted.turn.id, 'completed', 'accepted');
    expect(store.accept('request-a', 'start one task').replayed).toBe(true);
    expect(store.accept('request-b', 'second turn').replayed).toBe(false);
  });

  it('disable fences the active generation and pending approvals; re-enable never revives them', () => {
    const { store } = fixture();
    store.setEnabled(true);
    const { turn } = store.accept('a', 'stop task');
    store.setState(turn.id, 'running');
    expect(store.isCurrent(turn)).toBe(true);
    store.reserveAction('stop', turn.id, 'sam_work_stop', '{}', true);
    store.reserveAction('admitted', turn.id, 'sam_chat_start', '{}', false);
    store.finishAction('admitted', 'uncertain', { taskId: 'known-task' });
    store.setEnabled(false);
    expect(store.turn(turn.id)?.state).toBe('cancelled');
    expect(store.action('stop')?.state).toBe('rejected');
    expect(store.action('admitted')?.state).toBe('uncertain');
    store.setEnabled(true);
    expect(store.isCurrent(turn)).toBe(false);
    expect(store.action('admitted')?.result_json).toContain('known-task');
  });

  it('keeps side-effect reservations through process reconstruction', () => {
    const { store, sql } = fixture();
    store.setEnabled(true);
    const { turn } = store.accept('a', 'dispatch');
    store.reserveAction('action', turn.id, 'sam_chat_start', '{"projectId":"project-a"}', false);
    store.finishAction('action', 'uncertain', { message: 'lost response' });
    const restored = new OperatorStore(sql);
    expect(restored.reserveAction('action', turn.id, 'sam_chat_start', '{}', false).state).toBe(
      'uncertain'
    );
    restored.finishAction('action', 'completed', { taskId: 'one-task' });
    expect(new OperatorStore(sql).action('action')?.result_json).toBe('{"taskId":"one-task"}');
  });

  it('pages newest history without dropping turns sharing a timestamp', () => {
    const { store } = fixture();
    store.setEnabled(true);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    for (let i = 0; i < 6; i++) {
      const { turn } = store.accept(String(i), String(i));
      store.setState(turn.id, 'completed', String(i));
    }
    const latest = store.list(3);
    const oldest = latest[0]!;
    const previous = store.list(3, { createdAt: oldest.created_at, id: oldest.id });
    expect(new Set([...latest, ...previous].map((turn) => turn.id)).size).toBe(6);
  });

  it('cannot disclose another user’s turns through a separate per-user store', () => {
    const alice = fixture().store;
    const bob = fixture().store;
    alice.bindUser('alice');
    alice.setEnabled(true);
    alice.accept('same-key', 'PRIVATE_ALICE_CANARY');
    bob.bindUser('bob');
    bob.setEnabled(true);
    bob.accept('same-key', 'bob message');
    expect(JSON.stringify(bob.list(100))).not.toContain('PRIVATE_ALICE_CANARY');
  });
});

describe('canonical private conversation history', () => {
  it('retains one primary backing identity, indexes new transcript, and forks privately without action replay', () => {
    const { store, sql } = fixture();
    store.bindUser('alice');
    store.setEnabled(true);
    const primary = store.conversation();
    const { turn } = store.accept('original', 'Remember the private lavender constraint');
    store.setState(turn.id, 'completed', 'The lavender constraint is recorded.');
    store.reserveAction('dispatch', turn.id, 'sam_chat_start', '{}', false);
    store.finishAction('dispatch', 'uncertain', { message: 'No acknowledgement' });
    expect(store.searchHistory('lavender', 10)).toHaveLength(2);
    expect(new OperatorStore(sql).conversation()).toEqual(primary);
    const fork = store.fork('branch-a');
    expect(fork.backingTaskId).not.toBe(primary.backingTaskId);
    expect(store.fork('branch-a').replayed).toBe(true);
    expect(store.contextMessages(10)).toEqual([
      { role: 'user', content: 'Remember the private lavender constraint' },
      { role: 'assistant', content: 'The lavender constraint is recorded.' },
    ]);
    expect(store.list(10)).toEqual([]);
    expect(store.action('dispatch')?.state).toBe('uncertain');
    expect(
      sql
        .exec(
          'SELECT parent_task_id FROM operator_conversation_tasks WHERE id=?',
          fork.backingTaskId
        )
        .toArray()[0]?.parent_task_id
    ).toBe(primary.backingTaskId);
  });

  it('bounds private branches and rejects a branch while a turn is active', () => {
    const { store } = fixture();
    store.setEnabled(true);
    const { turn } = store.accept('a', 'hello');
    expect(() => store.fork('busy')).toThrow('TURN_ACTIVE');
    store.setState(turn.id, 'completed', 'Hi');
    store.fork('one', { conversations: 2, messages: 1 });
    expect(store.contextMessages(10)).toHaveLength(1);
    expect(() => store.fork('two', { conversations: 2, messages: 1 })).toThrow(
      'CONVERSATION_LIMIT'
    );
  });

  it('retries accepted keys without consuming the bounded admission budget again', () => {
    const { store } = fixture();
    store.setEnabled(true);
    const budget = { limit: 1, windowMs: 60_000 };
    const { turn } = store.accept('a', 'hello', budget);
    store.setState(turn.id, 'completed');
    expect(store.accept('a', 'hello', budget).replayed).toBe(true);
    expect(() => store.accept('b', 'hello', budget)).toThrow('RATE_LIMITED');
  });
});
