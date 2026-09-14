// Feature section content is split by topic to stay under the repo's 500-line
// file-size guideline (.claude/rules/18-file-size-limits.md). This barrel
// assembles the canonical display/navigation order — add new sections to the
// most relevant topic file, then wire them in here.
import type { FeatureSection } from './types';

import { agentContextSection } from './agent-context';
import { automationSection } from './automation';
import { chatSection } from './chat';
import { commentsSection } from './comments';
import { computePoolsSection } from './compute-pools';
import { configurationSection } from './configuration';
import { durableSessionsSection } from './durable-sessions';
import { eventsSection } from './events';
import { multiplayerSection } from './multiplayer';
import { visibilitySection } from './visibility';

export type { FeatureGroup, FeatureScreenshot, FeatureSection } from './types';
export { featureGroups } from './types';

export const featureSections: FeatureSection[] = [
  chatSection,
  multiplayerSection,
  commentsSection,
  computePoolsSection,
  eventsSection,
  durableSessionsSection,
  visibilitySection,
  agentContextSection,
  automationSection,
  configurationSection,
];
