/**
 * Admin setting for the advisory stalled-loop verdict on the LLM endpoint
 * (`stalled-task-classifier-endpoint.ts`). Pure, so the settings registry imports no resolution code.
 */
import type { AdminSettingDefinition } from './admin-setting-definitions';

export const STALLED_CLASSIFIER_ENDPOINT_SETTING =
  'operations.stalledTaskClassifierEndpointAdvisory' as const;
export type StalledClassifierEndpointSettingName = typeof STALLED_CLASSIFIER_ENDPOINT_SETTING;

export const STALLED_CLASSIFIER_ENDPOINT_SETTINGS: readonly AdminSettingDefinition[] = [
  {
    name: STALLED_CLASSIFIER_ENDPOINT_SETTING,
    type: 'boolean',
    defaultValue: false,
    category: 'Operations',
    description:
      'Without Cloudflare Workers AI, ask the OpenAI-compatible endpoint (llm.openAICompatible.*, diagnosis model) for the advisory verdict shown on a paused agent check-in loop. Advisory text only: it never stops or fails a task. Sends the session transcript (credentials and emails redacted) to that endpoint. Needs operations.stalledTaskClassifierEnabled too.',
    secret: false,
    risky: true,
    validate: (value) => typeof value === 'boolean',
  },
];
