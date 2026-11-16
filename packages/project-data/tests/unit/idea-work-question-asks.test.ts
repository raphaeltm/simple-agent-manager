/**
 * Inbox slice G: an idea's "question" status also shows open questions held in D1 `asks`, the
 * way it showed question markers (`idea-work.ts:mergeQuestionAsks`).
 */
import { describe, expect, it } from 'vitest';

import {
  ideaQuestionSessionIds,
  type IdeaWorkSnapshot,
  mergeQuestionAsks,
} from '../../src/do/idea-work';

function snapshot(): IdeaWorkSnapshot {
  return {
    ideaId: 'idea-1',
    sessions: [
      session('strong-chat', true),
      session('weak-chat', false),
      session('marker-chat', true),
    ],
    needsInput: [{ sessionId: 'marker-chat', question: 'Marker question', askedAt: 5_000 }],
    fileIds: [],
    pullRequestUrls: [],
    updates: 0,
    truncated: { sessions: false },
  } as unknown as IdeaWorkSnapshot;
}

function session(sessionId: string, strong: boolean) {
  return {
    sessionId,
    topic: null,
    sessionStatus: 'active',
    sessionTaskId: null,
    lastActivityAt: null,
    relations: [strong ? 'works_on' : 'read'],
    strong,
    linkedAt: 1,
  };
}

describe('idea work: open questions in D1 asks', () => {
  it('asks only for the strongly linked chats', () => {
    expect(ideaQuestionSessionIds({ 'idea-1': snapshot() }).sort()).toEqual([
      'marker-chat',
      'strong-chat',
    ]);
  });

  it('adds a strong chat’s question, ignores a weak one, and keeps a newer marker question', () => {
    const snapshots = { 'idea-1': snapshot() };
    mergeQuestionAsks(
      snapshots,
      new Map([
        ['strong-chat', { reason: 'Ask question', createdAt: 6_000 }],
        ['weak-chat', { reason: 'Weak link question', createdAt: 7_000 }],
        ['marker-chat', { reason: 'Older ask', createdAt: 4_000 }],
      ])
    );
    expect(snapshots['idea-1'].needsInput).toEqual([
      { sessionId: 'strong-chat', question: 'Ask question', askedAt: 6_000 },
      { sessionId: 'marker-chat', question: 'Marker question', askedAt: 5_000 },
    ]);
  });

  it('a newer ask replaces an older marker question of the same chat', () => {
    const snapshots = { 'idea-1': snapshot() };
    mergeQuestionAsks(
      snapshots,
      new Map([['marker-chat', { reason: 'New ask', createdAt: 9_000 }]])
    );
    expect(snapshots['idea-1'].needsInput).toEqual([
      { sessionId: 'marker-chat', question: 'New ask', askedAt: 9_000 },
    ]);
  });
});
