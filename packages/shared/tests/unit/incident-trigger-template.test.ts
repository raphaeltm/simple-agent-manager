import { describe, expect, it } from 'vitest';

import { DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE } from '../../src/constants';

// The incident trigger runs one triage at a time (`maxConcurrent: 1`, `skipIfRunning`). Runs on
// 2026-11-03/04 finished their work but never called complete_task, so they held the only slot
// for a week. The template is static text, so a string check is the right test.
describe('default incident trigger template', () => {
  it('requires the run to finish with complete_task, including incidents left claimed', () => {
    const template = DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE;
    expect(template).toContain('Always finish the run by calling complete_task');
    expect(template).toContain('{{incident.backlogSummary}}');
    expect(template.indexOf('complete_task')).toBeGreaterThan(template.indexOf('resolve_incident'));
  });
});
