/**
 * Behavioural tests for the SSE event dedup helper used by `TryDiscovery`.
 *
 * The control plane may replay buffered events after an SSE reconnect (the
 * EventSource silently re-opens on a transport error and the server replays
 * any events the client missed). Without dedup, the feed would visibly
 * duplicate every replayed event — see Phase 5 ui-ux-specialist finding.
 */
import type {
  TrialEvent,
  TrialKnowledgeEvent,
  TrialProgressEvent,
  TrialStartedEvent,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { eventDedupKey } from '../../../src/pages/TryDiscovery';

const started: TrialStartedEvent = {
  type: 'trial.started',
  trialId: 'trial-1',
  projectId: 'project-1',
  repoUrl: 'https://github.com/sindresorhus/is',
  startedAt: 1_700_000_000_000,
};

const progress: TrialProgressEvent = {
  type: 'trial.progress',
  stage: 'creating_workspace',
  progress: 0.5,
  at: 1_700_000_001_000,
};

const knowledge: TrialKnowledgeEvent = {
  type: 'trial.knowledge',
  entity: 'repo',
  observation: 'TypeScript',
  at: 1_700_000_002_000,
};

describe('eventDedupKey', () => {
  it('uses startedAt for trial.started events (no `at` field)', () => {
    expect(eventDedupKey(started)).toBe(`trial.started:${started.startedAt}`);
  });

  it('uses `at` for non-started events', () => {
    expect(eventDedupKey(progress)).toBe(`trial.progress:${progress.at}`);
    expect(eventDedupKey(knowledge)).toBe(`trial.knowledge:${knowledge.at}`);
  });

  it('produces stable keys when called repeatedly with the same event', () => {
    const a = eventDedupKey(progress);
    const b = eventDedupKey(progress);
    expect(a).toBe(b);
  });

  it('two events of the same type at different timestamps produce distinct keys', () => {
    const later: TrialProgressEvent = { ...progress, at: progress.at + 1 };
    expect(eventDedupKey(progress)).not.toBe(eventDedupKey(later));
  });

  it('two events at the same timestamp but different types produce distinct keys', () => {
    const sameTimeKnowledge: TrialKnowledgeEvent = { ...knowledge, at: progress.at };
    expect(eventDedupKey(progress)).not.toBe(eventDedupKey(sameTimeKnowledge));
  });
});

describe('SSE replay dedup behaviour', () => {
  /** Simulates the dedup branch in TryDiscovery's onEvent callback. */
  function applyDedup(events: TrialEvent[]): TrialEvent[] {
    const seen = new Set<string>();
    const out: TrialEvent[] = [];
    for (const event of events) {
      const key = eventDedupKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(event);
    }
    return out;
  }

  it('drops duplicates when the same event arrives twice (post-reconnect replay)', () => {
    const stream: TrialEvent[] = [started, progress, knowledge, progress, knowledge];
    expect(applyDedup(stream)).toHaveLength(3);
  });

  it('preserves chronological events that share a type but not a timestamp', () => {
    const second: TrialProgressEvent = { ...progress, at: progress.at + 100 };
    expect(applyDedup([progress, second])).toHaveLength(2);
  });

  it('does not collide when two events share `at` but differ in type', () => {
    const collide: TrialKnowledgeEvent = { ...knowledge, at: progress.at };
    expect(applyDedup([progress, collide])).toHaveLength(2);
  });
});
