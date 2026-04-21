/**
 * Derived view model for the trial discovery feed.
 *
 * `deriveView()` scans a flat event list into structured buckets.
 * `buildFeed()` groups consecutive knowledge/activity events for display.
 *
 * Extracted from TryDiscovery.tsx — pure functions, no React dependencies.
 */
import type {
  TrialAgentActivityEvent,
  TrialErrorEvent,
  TrialEvent,
  TrialIdeaEvent,
  TrialKnowledgeEvent,
  TrialProgressEvent,
  TrialReadyEvent,
  TrialStartedEvent,
} from '@simple-agent-manager/shared';

import { TRIAL_KNOWLEDGE_GROUP_MS } from './trial-ui-config';

export interface DiscoveryView {
  started: TrialStartedEvent | null;
  progressLatest: TrialProgressEvent | null;
  ready: TrialReadyEvent | null;
  error: TrialErrorEvent | null;
  ideas: TrialIdeaEvent[];
  knowledge: TrialKnowledgeEvent[];
  activity: TrialAgentActivityEvent[];
}

export function deriveView(events: TrialEvent[]): DiscoveryView {
  const view: DiscoveryView = {
    started: null,
    progressLatest: null,
    ready: null,
    error: null,
    ideas: [],
    knowledge: [],
    activity: [],
  };
  for (const event of events) {
    switch (event.type) {
      case 'trial.started':
        view.started = event;
        break;
      case 'trial.progress':
        view.progressLatest = event;
        break;
      case 'trial.knowledge':
        view.knowledge.push(event);
        break;
      case 'trial.idea':
        view.ideas.push(event);
        break;
      case 'trial.ready':
        view.ready = event;
        break;
      case 'trial.agent_activity':
        view.activity.push(event);
        break;
      case 'trial.error':
        view.error = event;
        break;
    }
  }
  return view;
}

/**
 * Group consecutive `trial.knowledge` events arriving within
 * {@link TRIAL_KNOWLEDGE_GROUP_MS} into a single feed item. Other event
 * types break the group. Order is preserved.
 */
export type FeedItem =
  | { kind: 'event'; key: string; event: Exclude<TrialEvent, TrialKnowledgeEvent | TrialAgentActivityEvent | TrialErrorEvent> }
  | { kind: 'knowledge-group'; key: string; items: TrialKnowledgeEvent[] }
  | { kind: 'activity-group'; key: string; items: TrialAgentActivityEvent[] };

export function buildFeed(events: TrialEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  let knowledgeGroup: TrialKnowledgeEvent[] = [];
  let knowledgeGroupStartIdx = -1;
  let activityGroup: TrialAgentActivityEvent[] = [];
  let activityGroupStartIdx = -1;

  const flushKnowledge = () => {
    if (knowledgeGroup.length === 0) return;
    out.push({
      kind: 'knowledge-group',
      key: `knowledge-${knowledgeGroupStartIdx}-${knowledgeGroup.length}`,
      items: knowledgeGroup,
    });
    knowledgeGroup = [];
    knowledgeGroupStartIdx = -1;
  };

  const flushActivity = () => {
    if (activityGroup.length === 0) return;
    out.push({
      kind: 'activity-group',
      key: `activity-${activityGroupStartIdx}-${activityGroup.length}`,
      items: activityGroup,
    });
    activityGroup = [];
    activityGroupStartIdx = -1;
  };

  const flushAll = () => {
    flushKnowledge();
    flushActivity();
  };

  events.forEach((event, idx) => {
    if (event.type === 'trial.knowledge') {
      flushActivity();
      const last = knowledgeGroup[knowledgeGroup.length - 1];
      if (knowledgeGroup.length === 0 || (last && event.at - last.at <= TRIAL_KNOWLEDGE_GROUP_MS)) {
        if (knowledgeGroup.length === 0) knowledgeGroupStartIdx = idx;
        knowledgeGroup.push(event);
      } else {
        flushKnowledge();
        knowledgeGroup = [event];
        knowledgeGroupStartIdx = idx;
      }
      return;
    }

    if (event.type === 'trial.agent_activity') {
      flushKnowledge();
      const last = activityGroup[activityGroup.length - 1];
      // Group activity events arriving within the same window
      if (activityGroup.length === 0 || (last && event.at - last.at <= TRIAL_KNOWLEDGE_GROUP_MS)) {
        if (activityGroup.length === 0) activityGroupStartIdx = idx;
        activityGroup.push(event);
      } else {
        flushActivity();
        activityGroup = [event];
        activityGroupStartIdx = idx;
      }
      return;
    }

    flushAll();

    if (event.type === 'trial.error') {
      // Rendered as the terminal panel above, not in the feed.
      return;
    }

    // Deduplicate consecutive progress events with the same stage —
    // the orchestrator re-emits keepalive progress events while waiting
    // for the agent to boot, which creates visual spam.
    if (event.type === 'trial.progress') {
      const prev = out[out.length - 1];
      if (prev?.kind === 'event' && prev.event.type === 'trial.progress' && prev.event.stage === event.stage) {
        // Replace the previous with the latest (keeps the most recent progress %)
        out[out.length - 1] = { kind: 'event', key: `event-${idx}-${event.type}`, event };
        return;
      }
    }

    out.push({ kind: 'event', key: `event-${idx}-${event.type}`, event });
  });

  flushAll();
  return out;
}
