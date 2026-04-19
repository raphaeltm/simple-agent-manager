/**
 * Boundary tests for `buildFeed` — the consecutive `trial.knowledge` event
 * grouper used by `TryDiscovery`.
 *
 * The grouping window is `TRIAL_KNOWLEDGE_GROUP_MS` (1500ms by default).
 * The boundary check is `event.at - last.at <= TRIAL_KNOWLEDGE_GROUP_MS`,
 * so equality merges; one millisecond past the window splits.
 */
import type {
  TrialErrorEvent,
  TrialIdeaEvent,
  TrialKnowledgeEvent,
  TrialProgressEvent,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { TRIAL_KNOWLEDGE_GROUP_MS } from '../../../src/lib/trial-ui-config';
import { buildFeed } from '../../../src/pages/TryDiscovery';

const k = (at: number, entity = 'repo'): TrialKnowledgeEvent => ({
  type: 'trial.knowledge',
  entity,
  observation: `obs at ${at}`,
  at,
});

const progress = (at: number): TrialProgressEvent => ({
  type: 'trial.progress',
  stage: 'creating_workspace',
  progress: 0.5,
  at,
});

const idea = (at: number): TrialIdeaEvent => ({
  type: 'trial.idea',
  ideaId: `idea-${at}`,
  title: 'idea',
  summary: 'summary',
  at,
});

const error = (at: number): TrialErrorEvent => ({
  type: 'trial.error',
  error: 'repo_too_large',
  message: 'too big',
  at,
});

describe('buildFeed grouping boundary', () => {
  it('merges two knowledge events arriving within the window', () => {
    const items = buildFeed([k(1000), k(1000 + TRIAL_KNOWLEDGE_GROUP_MS - 1)]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('knowledge-group');
    if (items[0]?.kind === 'knowledge-group') {
      expect(items[0].items).toHaveLength(2);
    }
  });

  it('merges two events arriving EXACTLY at the boundary (`<=` not `<`)', () => {
    const items = buildFeed([k(1000), k(1000 + TRIAL_KNOWLEDGE_GROUP_MS)]);
    expect(items).toHaveLength(1);
    if (items[0]?.kind === 'knowledge-group') {
      expect(items[0].items).toHaveLength(2);
    }
  });

  it('splits two events one millisecond past the boundary', () => {
    const items = buildFeed([k(1000), k(1000 + TRIAL_KNOWLEDGE_GROUP_MS + 1)]);
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('knowledge-group');
    expect(items[1]?.kind).toBe('knowledge-group');
  });

  it('a non-knowledge event between two knowledge events breaks the group', () => {
    // All within the window — only the interleaved progress event splits them.
    const items = buildFeed([k(1000), progress(1100), k(1200)]);
    expect(items.map((i) => i.kind)).toEqual(['knowledge-group', 'event', 'knowledge-group']);
  });

  it('an idea event breaks knowledge grouping', () => {
    const items = buildFeed([k(1000), idea(1100), k(1200)]);
    expect(items.map((i) => i.kind)).toEqual(['knowledge-group', 'event', 'knowledge-group']);
  });

  it('excludes trial.error events from the feed entirely (rendered as terminal panel)', () => {
    const items = buildFeed([progress(1000), error(2000), idea(3000)]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'event')).toBe(true);
  });

  it('returns an empty array for an empty event list', () => {
    expect(buildFeed([])).toEqual([]);
  });

  it('three knowledge events at the boundary collapse into a single group of three', () => {
    const items = buildFeed([
      k(1000),
      k(1000 + TRIAL_KNOWLEDGE_GROUP_MS, 'lang'),
      k(1000 + 2 * TRIAL_KNOWLEDGE_GROUP_MS, 'readme'),
    ]);
    expect(items).toHaveLength(1);
    if (items[0]?.kind === 'knowledge-group') {
      expect(items[0].items).toHaveLength(3);
    }
  });
});
