import type { TriggerResponse } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  formatDateFull,
  formatDuration,
  formatNextRun,
  formatTriggerSource,
  statusBadgeKey,
} from '../../../src/components/triggers/trigger-presentation';

/**
 * This module exists to stop formatter drift — the same trigger used to describe
 * itself differently on the card, the detail header and the configuration panel.
 * A shared formatter with no tests just centralises the drift, so these pin the
 * exact strings, including the ones that must NOT have changed when three
 * implementations were collapsed into one.
 */

function makeTrigger(overrides: Partial<TriggerResponse>): TriggerResponse {
  return {
    id: 't1',
    projectId: 'p1',
    userId: 'u1',
    name: 'Trigger',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    cronHumanReadable: 'Daily at 9:00 AM',
    skipIfRunning: true,
    promptTemplate: 'x',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    nextFireAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as TriggerResponse;
}

describe('formatDuration', () => {
  // These four cases pin the output of the two implementations this replaced.
  it('reports sub-second runs as "<1s", not raw milliseconds', () => {
    expect(formatDuration('2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.500Z')).toBe('<1s');
  });

  it('omits the seconds component on an exact minute', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:02:00Z')).toBe('2m');
  });

  it('includes seconds when there is a remainder', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:02:05Z')).toBe('2m 5s');
  });

  it('reports sub-minute runs in seconds', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:00:42Z')).toBe('42s');
  });

  it.each([
    ['missing start', null, '2026-05-01T00:00:00Z'],
    ['missing end', '2026-05-01T00:00:00Z', null],
    ['unparseable', 'not-a-date', '2026-05-01T00:00:00Z'],
    ['negative', '2026-05-01T00:01:00Z', '2026-05-01T00:00:00Z'],
  ])('renders an em dash for %s rather than NaN', (_label, a, b) => {
    expect(formatDuration(a, b)).toBe('—');
  });
});

describe('formatDateFull', () => {
  it('keeps the timezone — a run time without a zone is ambiguous', () => {
    const out = formatDateFull('2026-05-01T09:30:00Z');
    // Zone abbreviation varies by host locale, so assert presence rather than value.
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan('May 1, 09:30'.length);
    expect(/\d/.test(out)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['unparseable', 'not-a-date'],
  ])('renders an em dash for %s', (_label, value) => {
    expect(formatDateFull(value)).toBe('—');
  });
});

describe('formatNextRun', () => {
  it.each([
    ['minutes', 5 * 60_000, 'in 5m'],
    ['hours', 3 * 3_600_000, 'in 3h'],
    ['days', 6 * 86_400_000, 'in 6d'],
  ])('formats %s', (_label, offsetMs, expected) => {
    // +2s of slack: the helper floors the remaining time, so the milliseconds
    // that elapse between building this date and reading it would otherwise
    // tip "in 5m" to "in 4m" intermittently.
    const at = new Date(Date.now() + (offsetMs as number) + 2_000).toISOString();
    expect(formatNextRun(at)).toBe(expected);
  });

  it('reports a past fire time as overdue', () => {
    expect(formatNextRun(new Date(Date.now() - 60_000).toISOString())).toBe('overdue');
  });

  it('does not render NaN for an unparseable date', () => {
    expect(formatNextRun('not-a-date')).toBe('unknown');
  });
});

describe('formatTriggerSource', () => {
  it('uses the human-readable schedule for cron triggers', () => {
    expect(formatTriggerSource(makeTrigger({}))).toBe('Daily at 9:00 AM');
  });

  it('falls back to the raw expression when there is no readable form', () => {
    expect(formatTriggerSource(makeTrigger({ cronHumanReadable: undefined }))).toBe('0 9 * * *');
  });

  it('names the GitHub event, with the command prefix when set', () => {
    const base = { sourceType: 'github' as const };
    expect(
      formatTriggerSource(
        makeTrigger({ ...base, githubConfig: { eventType: 'issue_comment', filters: {} } })
      )
    ).toBe('GitHub issue comment');
    expect(
      formatTriggerSource(
        makeTrigger({
          ...base,
          githubConfig: { eventType: 'issue_comment', filters: { commandPrefix: '/sam' } },
        })
      )
    ).toBe('GitHub issue comment: /sam');
  });

  describe('webhook', () => {
    const webhookConfig = (overrides: Record<string, unknown>) =>
      ({
        sourceLabel: null,
        filterMode: 'all',
        filters: [],
        includedHeaders: [],
        tokenLastFour: null,
        tokenCreatedAt: '2026-05-01T00:00:00Z',
        tokenRotatedAt: null,
        ...overrides,
      }) as never;

    it('shows the label with the token suffix', () => {
      expect(
        formatTriggerSource(
          makeTrigger({
            sourceType: 'webhook',
            webhookConfig: webhookConfig({ sourceLabel: 'PagerDuty', tokenLastFour: '9xYz' }),
          })
        )
      ).toBe('PagerDuty · token ••••9xYz');
    });

    it('shows the label alone when there is no token suffix', () => {
      expect(
        formatTriggerSource(
          makeTrigger({
            sourceType: 'webhook',
            webhookConfig: webhookConfig({ sourceLabel: 'PagerDuty' }),
          })
        )
      ).toBe('PagerDuty');
    });

    it('names the source TYPE when the label is blank — never a fabricated label', () => {
      // The previous "Generic webhook" read as a configured source name.
      const noLabel = formatTriggerSource(
        makeTrigger({ sourceType: 'webhook', webhookConfig: webhookConfig({}) })
      );
      expect(noLabel).toBe('Webhook');
      expect(noLabel).not.toMatch(/generic/i);

      expect(
        formatTriggerSource(
          makeTrigger({
            sourceType: 'webhook',
            webhookConfig: webhookConfig({ tokenLastFour: 'a1B2' }),
          })
        )
      ).toBe('Webhook · token ••••a1B2');
    });
  });
});

describe('statusBadgeKey', () => {
  it.each([
    ['active', 'active'],
    ['paused', 'paused'],
    ['disabled', 'disabled'],
  ])('passes %s through', (input, expected) => {
    expect(statusBadgeKey(input)).toBe(expected);
  });

  it('degrades an unknown status to a visible "disabled" rather than "Unknown"', () => {
    expect(statusBadgeKey('something-new')).toBe('disabled');
  });
});
