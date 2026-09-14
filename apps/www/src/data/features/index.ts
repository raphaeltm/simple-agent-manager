// Feature section content lives in one JSON file per topic (content, not code),
// validated here at module load so a typo in a group or a missing hero image
// fails the build instead of silently dropping a card. This barrel assembles the
// canonical display/navigation order — add new sections as JSON, then wire them in.
import type { FeatureGroup, FeatureSection } from './types';
import { featureGroups } from './types';

import agentContext from './agent-context.json';
import automation from './automation.json';
import chat from './chat.json';
import comments from './comments.json';
import computePools from './compute-pools.json';
import configuration from './configuration.json';
import durableSessions from './durable-sessions.json';
import events from './events.json';
import multiplayer from './multiplayer.json';
import visibility from './visibility.json';

export type { FeatureGroup, FeatureScreenshot, FeatureSection } from './types';
export { featureGroups } from './types';

const groupIds = new Set<string>(featureGroups.map((group) => group.id));

function asFeatureSection(candidate: unknown): FeatureSection {
  const section = candidate as FeatureSection;
  if (!groupIds.has(section.group)) {
    throw new Error(`Feature section "${section.slug}" has unknown group "${section.group}"`);
  }
  if (section.screenshots.length === 0 || section.details.length === 0) {
    throw new Error(`Feature section "${section.slug}" needs a hero screenshot and at least one detail row`);
  }
  return { ...section, group: section.group as FeatureGroup };
}

export const featureSections: FeatureSection[] = [
  chat,
  multiplayer,
  comments,
  computePools,
  events,
  durableSessions,
  visibility,
  agentContext,
  automation,
  configuration,
].map(asFeatureSection);
