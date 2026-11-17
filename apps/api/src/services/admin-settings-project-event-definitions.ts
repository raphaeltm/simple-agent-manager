import { type AdminSettingDefinition, switchDefinition } from './admin-setting-definitions';

export const PROJECT_EVENT_SETTINGS: AdminSettingDefinition[] = [
  switchDefinition(
    'events.skipUnsubscribedGitHubCi',
    true,
    'Operations',
    'Skip storing unmatched GitHub check_run, check_suite and workflow_run events. The event inspector shows volatile admission counts instead of skipped event history. Disable to restore full CI history for future admissions.',
    {}
  ),
];
