import {
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  type ProjectStandingWatch,
  type TriggerResponse,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  describeCron,
  parseCronToMode,
  parseDayList,
} from '../../../src/components/triggers/schedule-cron';
import { formatSpanWords, formatTimeFromNow } from '../../../src/lib/time-utils';
import {
  canonicalCron,
  cronError,
  nextRuns,
  shortestGapMinutes,
  toCron,
} from '../../../src/pages/automation/editor/cron';
import {
  friendlySaveError,
  scheduleCreateRequest,
  triggerCreateRequest,
  triggerUpdateRequest,
  validateStep,
  watchCreateRequest,
  watchFilter,
  watchUpdateRequest,
} from '../../../src/pages/automation/editor/requests';
import {
  DEFAULT_EMAIL_PROMPT_TEMPLATE,
  type EditorState,
  editorStateFromTrigger,
  editorStateFromWatch,
  newEditorState,
  scheduleFromCron,
  withEmailDefaults,
} from '../../../src/pages/automation/editor/state';
import { templateById } from '../../../src/pages/automation/editor/templates';
import { GIVE_UP_OPTIONS } from '../../../src/pages/automation/schedule-time';
import { instantToZonedInput, zonedInputToInstant } from '../../../src/pages/automation/time';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const CAN = { canChangeAction: true, now: NOW };

function trigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    id: 't1',
    projectId: 'p1',
    userId: 'u1',
    name: 'Morning summary',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * 1-5',
    cronTimezone: 'Europe/Paris',
    skipIfRunning: true,
    promptTemplate: 'Summarize',
    agentProfileId: null,
    skillId: 'skill-from-agent',
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function watch(overrides: Partial<ProjectStandingWatch> = {}): ProjectStandingWatch {
  return {
    id: 'w1',
    projectId: 'p1',
    creatorUserId: 'creator',
    reason: 'Failed releases',
    filter: { version: 1, source: 'sam.lifecycle', eventType: 'deployment.release.failed' },
    action: { kind: 'message_session', sessionId: 'chat-1', prompt: 'Look into it' },
    state: 'active',
    version: 7,
    idempotencyKey: 'k',
    cooldownMs: 300_000,
    maxConcurrent: 2,
    maxExecutions: 40,
    executionCount: 3,
    nextEligibleAt: 0,
    subscriptionId: 's',
    createdAt: NOW,
    updatedAt: NOW,
    lastError: null,
    ...overrides,
  };
}

const withPrompt = (state: EditorState, prompt = 'Do the thing'): EditorState => ({
  ...state,
  action: { ...state.action, prompt },
});

describe('creating triggers', () => {
  it('sends every field the flow collects for a recurring schedule', () => {
    const base = newEditorState({ start: 'schedule' }, NOW);
    const state: EditorState = {
      ...withPrompt(base, 'Summarize open PRs'),
      name: '  Morning summary  ',
      description: 'For the team',
      schedule: {
        ...base.schedule,
        preset: 'weekly',
        weeklyDays: [3, 1],
        time: '07:30',
        zone: 'Asia/Tokyo',
      },
      action: {
        ...base.action,
        prompt: 'Summarize open PRs',
        agentProfileId: 'prof',
        skillId: 'skill',
      },
      trigger: {
        ...base.trigger,
        skipIfRunning: false,
        maxConcurrent: 3,
        taskMode: 'conversation',
      },
    };
    expect(triggerCreateRequest(state)).toEqual({
      name: 'Morning summary',
      description: 'For the team',
      sourceType: 'cron',
      cronExpression: '30 7 * * 1,3',
      cronTimezone: 'Asia/Tokyo',
      promptTemplate: 'Summarize open PRs',
      agentProfileId: 'prof',
      skillId: 'skill',
      skipIfRunning: false,
      maxConcurrent: 3,
      taskMode: 'conversation',
      resourceRequirementsJson: null,
    });
  });

  it('builds GitHub and webhook configuration', () => {
    const github = withPrompt({
      ...newEditorState({ start: 'github' }, NOW),
      name: 'Triage',
      github: {
        ...newEditorState().github,
        eventType: 'issues',
        actions: 'opened, labeled',
        labels: 'bug',
        commandPrefix: '',
      },
    });
    expect(triggerCreateRequest(github).githubConfig).toEqual({
      eventType: 'issues',
      subjectAffinity: false,
      queueMaxPending: 50,
      queueTtlSeconds: 86400,
      filters: {
        actions: ['opened', 'labeled'],
        labels: ['bug'],
        ignoreActors: ['dependabot[bot]'],
      },
    });
    const webhook = withPrompt({
      ...newEditorState({ start: 'webhook' }, NOW),
      name: 'Alerts',
      webhook: {
        sourceLabel: ' PagerDuty ',
        includedHeaders: 'x-request-id, x-event',
        filterMode: 'any',
        filters: [{ path: 'event.severity', operator: 'equals', value: 'critical' }],
      },
    });
    expect(triggerCreateRequest(webhook).webhookConfig).toEqual({
      sourceLabel: 'PagerDuty',
      includedHeaders: ['x-request-id', 'x-event'],
      filterMode: 'any',
      filters: [{ path: 'event.severity', operator: 'equals', value: 'critical' }],
    });
  });

  it('refuses to build a trigger for one-time or event starts', () => {
    expect(() => triggerCreateRequest(newEditorState({ start: 'once' }, NOW))).toThrow();
  });

  it('sends sourceType, emailConfig.allowedSenders and the agent profile for an email automation', () => {
    const email = withPrompt(
      {
        ...newEditorState({ start: 'email' }, NOW),
        name: 'Support inbox',
        email: { allowedSenders: 'a@example.com\nB@EXAMPLE.com, c@example.com' },
        action: {
          ...newEditorState().action,
          agentProfileId: 'prof-support',
        },
      },
      'Reply to the sender.'
    );
    expect(triggerCreateRequest(email)).toMatchObject({
      sourceType: 'email',
      agentProfileId: 'prof-support',
      promptTemplate: 'Reply to the sender.',
      emailConfig: { allowedSenders: ['a@example.com', 'B@EXAMPLE.com', 'c@example.com'] },
    });
    // One per line or comma-separated both split into the same list — the field accepts either.
    expect(
      triggerCreateRequest({
        ...email,
        email: { allowedSenders: 'a@example.com, b@example.com' },
      }).emailConfig
    ).toEqual({ allowedSenders: ['a@example.com', 'b@example.com'] });
  });

  it('omits allowedSenders when empty, letting the API default to the creator', () => {
    const email = withPrompt({
      ...newEditorState({ start: 'email' }, NOW),
      name: 'Support inbox',
      email: { allowedSenders: '   ' },
      action: { ...newEditorState().action, agentProfileId: 'prof-support' },
    });
    expect(triggerCreateRequest(email).emailConfig).toEqual({});
  });
});

describe('editing triggers', () => {
  it('leaves fields agents set alone unless the person changed them', () => {
    const original = trigger({ description: 'Set by an agent' });
    const state = editorStateFromTrigger(original);
    const request = triggerUpdateRequest({ ...state, name: 'Renamed' }, original);
    expect(request.name).toBe('Renamed');
    expect(request).not.toHaveProperty('skillId');
    expect(request).not.toHaveProperty('description');
    // An untouched `1-5` schedule is not rewritten as `1,2,3,4,5`.
    expect(request).not.toHaveProperty('cronExpression');
    expect(request).not.toHaveProperty('cronTimezone');
  });

  it('sends what changed, including clearing a skill and a legacy machine size', () => {
    const original = trigger({ vmSizeOverride: 'large' });
    const state = editorStateFromTrigger(original);
    expect(state.trigger.legacyVmSize).toBe('large');
    const request = triggerUpdateRequest(
      {
        ...state,
        description: 'Now documented',
        action: { ...state.action, skillId: '' },
        schedule: { ...state.schedule, preset: 'daily', zone: 'UTC' },
        scheduleTouched: true,
        trigger: { ...state.trigger, legacyVmSize: '' },
      },
      original
    );
    expect(request).toMatchObject({
      description: 'Now documented',
      skillId: null,
      cronExpression: '0 9 * * *',
      cronTimezone: 'UTC',
      vmSizeOverride: null,
    });
  });

  it('loads queue controls and changes them without losing stored filters', () => {
    const original = trigger({
      sourceType: 'github',
      cronExpression: null,
      githubConfig: {
        eventType: 'issues',
        filters: { labels: ['bug'] },
        subjectAffinity: true,
        queueMaxPending: 7,
        queueTtlSeconds: 120,
      },
    });
    const state = editorStateFromTrigger(original);
    expect(state.github).toMatchObject({
      subjectAffinity: true,
      queueMaxPending: '7',
      queueTtlHours: String(120 / 3600),
    });
    expect(
      triggerUpdateRequest(
        { ...state, github: { ...state.github, queueTtlHours: '0.5' } },
        original
      ).githubConfig?.queueTtlSeconds
    ).toBe(1800);
    expect(triggerUpdateRequest({ ...state, name: 'Renamed' }, original)).not.toHaveProperty(
      'githubConfig'
    );
    expect(
      triggerUpdateRequest(
        { ...state, github: { ...state.github, queueMaxPending: '9' } },
        original
      ).githubConfig
    ).toEqual({ ...original.githubConfig, queueMaxPending: 9 });
    expect(
      validateStep({ ...state, github: { ...state.github, queueTtlHours: '0' } }, 'review', CAN)
        .queueTtlHours
    ).toMatch(/one second/);
  });
  it('sends no GitHub config on an edit that did not touch it', () => {
    const original = trigger({
      sourceType: 'github',
      cronExpression: null,
      githubConfig: {
        eventType: 'issue_comment',
        filters: { actions: ['created'], commandPrefix: '/sam' },
      },
    });
    const request = triggerUpdateRequest(
      { ...editorStateFromTrigger(original), name: 'x' },
      original
    );
    expect(request).not.toHaveProperty('githubConfig');
  });

  it('opens incident triggers for editing without a schedule', () => {
    const state = editorStateFromTrigger(trigger({ sourceType: 'incident', cronExpression: null }));
    expect(state.start).toBe('incident');
  });

  it('opens an email trigger with its stored senders, one per line, and saves changes to them', () => {
    const original = trigger({
      sourceType: 'email',
      cronExpression: null,
      agentProfileId: 'prof-support',
      emailConfig: {
        address: 'agent+abc123@agents.example.com',
        allowedSenders: ['a@x.test', 'b@x.test'],
      },
    });
    const state = editorStateFromTrigger(original);
    expect(state.start).toBe('email');
    expect(state.email.allowedSenders).toBe('a@x.test\nb@x.test');
    const request = triggerUpdateRequest(
      { ...state, email: { allowedSenders: 'a@x.test\nc@x.test' } },
      original
    );
    expect(request.emailConfig).toEqual({ allowedSenders: ['a@x.test', 'c@x.test'] });
  });
});

describe('one-time automations', () => {
  it('turns a wall-clock time in a chosen zone into the right instant', () => {
    const state: EditorState = {
      ...withPrompt(newEditorState({ start: 'once', sessionId: 'chat-9' }, NOW)),
      name: '',
      once: { local: '2026-10-21T09:00', zone: 'Europe/Paris', giveUpMs: 3_600_000 },
    };
    const request = scheduleCreateRequest(state, 'key-1', NOW);
    expect(request).toEqual({
      action: { kind: 'message_session', sessionId: 'chat-9', prompt: 'Do the thing' },
      dueAt: Date.parse('2026-10-21T07:00:00Z'),
      expiresAt: Date.parse('2026-10-21T08:00:00Z'),
      displayTimezone: 'Europe/Paris',
      reason: null,
      idempotencyKey: 'key-1',
    });
  });

  it('rejects past times and times beyond 30 days', () => {
    const state = newEditorState({ start: 'once' }, NOW);
    expect(
      validateStep(
        { ...state, once: { ...state.once, local: '2026-10-19T09:00', zone: 'UTC' } },
        'when',
        CAN
      ).once
    ).toBe('Choose a time in the future.');
    expect(
      validateStep(
        { ...state, once: { ...state.once, local: '2026-12-25T09:00', zone: 'UTC' } },
        'when',
        CAN
      ).once
    ).toBe('Choose a time within the next 30 days.');
  });
});

describe('duration wording', () => {
  it('words lengths of time from the shared limits instead of fixed text', () => {
    expect(formatSpanWords(15 * 60_000)).toBe('15 minutes');
    expect(formatSpanWords(60 * 60_000)).toBe('1 hour');
    expect(formatSpanWords(24 * 60 * 60_000)).toBe('24 hours');
    expect(formatSpanWords(30 * 24 * 60 * 60_000)).toBe('30 days');
    // Rounds before picking the unit: just under an hour or a day reads as the larger unit.
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(formatTimeFromNow(now - 59.6 * 60_000, now)).toBe('1 h ago');
    expect(formatTimeFromNow(now + 23.7 * 3_600_000, now)).toBe('in 1 day');
    expect(formatTimeFromNow(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(formatTimeFromNow(now + 20_000, now)).toBe('just now');
    expect(GIVE_UP_OPTIONS.map((option) => option.label)).toEqual([
      '15 minutes',
      '1 hour',
      '6 hours',
      '24 hours',
    ]);
  });
});

describe('standing watches', () => {
  it('builds preset, channel and custom filters', () => {
    const base = newEditorState({ start: 'event' }, NOW);
    expect(watchFilter({ ...base, watch: { ...base.watch, preset: 'task-failed' } })).toEqual({
      version: 1,
      source: 'sam.lifecycle',
      eventType: 'task.failed',
    });
    expect(
      watchFilter({
        ...base,
        watch: { ...base.watch, preset: 'channel-post', channel: '#release-train' },
      })
    ).toEqual({
      version: 1,
      source: 'sam.agent_channel',
      eventType: 'agent.channel.published',
      subjectType: 'agent_channel',
      subjectId: 'release-train',
    });
    expect(
      watchFilter({
        ...base,
        watch: {
          ...base.watch,
          preset: 'custom',
          source: 'github',
          eventType: 'issues.opened, issues.reopened',
          severity: 'warning,error',
        },
      })
    ).toEqual({
      version: 1,
      source: 'github',
      eventType: ['issues.opened', 'issues.reopened'],
      severity: ['warning', 'error'],
    });
  });

  it('sends limits and the action on create', () => {
    const base = withPrompt(newEditorState({ start: 'event' }, NOW));
    const request = watchCreateRequest(
      {
        ...base,
        name: 'Watch',
        watch: { ...base.watch, cooldownMinutes: 5, maxConcurrent: 2, maxExecutions: 30 },
      },
      'key'
    );
    expect(request).toMatchObject({
      reason: 'Watch',
      cooldownMs: 300_000,
      maxConcurrent: 2,
      maxExecutions: 30,
      idempotencyKey: 'key',
      action: {
        kind: 'start_session',
        prompt: 'Do the thing',
        agentProfileId: null,
        skillId: null,
      },
    });
  });

  it('leaves the action out of an edit by someone other than the creator', () => {
    const original = watch();
    const state = editorStateFromWatch(original);
    expect(state.watch.preset).toBe('release-failed');
    expect(state.action).toMatchObject({ kind: 'message', sessionId: 'chat-1' });
    const asOther = watchUpdateRequest({ ...state, name: 'Renamed' }, original, false);
    expect(asOther).not.toHaveProperty('action');
    expect(asOther).toMatchObject({ expectedVersion: 7, reason: 'Renamed', maxExecutions: 40 });
    expect(watchUpdateRequest(state, original, true)).toHaveProperty('action', original.action);
  });

  it('reads stored filters back as the preset they were made with', () => {
    expect(
      editorStateFromWatch(
        watch({
          filter: {
            version: 1,
            source: 'sam.agent_channel',
            eventType: 'agent.channel.published',
            subjectType: 'agent_channel',
            subjectId: 'ops',
          },
        })
      ).watch
    ).toMatchObject({ preset: 'channel-post', channel: 'ops' });
    expect(
      editorStateFromWatch(
        watch({
          filter: {
            version: 1,
            source: 'github',
            eventType: 'issues.opened',
            severity: ['warning', 'error'],
          },
        })
      ).watch
    ).toMatchObject({ preset: 'custom', severity: 'warning, error' });
  });
});

describe('validation', () => {
  it('asks for the things each step needs', () => {
    const webhook = newEditorState({ start: 'webhook' }, NOW);
    expect(validateStep(webhook, 'what', CAN)).toMatchObject({
      prompt: 'Say what the agent should do.',
      agentProfileId: 'Webhook automations need an agent profile.',
    });
    expect(
      validateStep(
        {
          ...webhook,
          webhook: { ...webhook.webhook, filters: [{ path: ' ', operator: 'exists' }] },
        },
        'when',
        CAN
      ).webhook
    ).toMatch(/needs a path/);
    expect(validateStep(newEditorState({}, NOW), 'start', CAN).start).toBe('Pick what starts it.');
    expect(
      validateStep(withPrompt(newEditorState({ start: 'schedule' }, NOW)), 'review', CAN).name
    ).toBe('Give it a name.');
  });

  it('requires at least one plausible allowed sender and an agent profile for email', () => {
    const email = newEditorState({ start: 'email' }, NOW);
    expect(validateStep({ ...email, email: { allowedSenders: '' } }, 'when', CAN).email).toBe(
      'Add at least one allowed sender.'
    );
    expect(
      validateStep({ ...email, email: { allowedSenders: 'not-an-email' } }, 'when', CAN).email
    ).toMatch(/look like an email/);
    expect(
      validateStep({ ...email, email: { allowedSenders: 'a@x.test' } }, 'when', CAN).email
    ).toBeUndefined();
    expect(validateStep(withPrompt(email), 'what', CAN)).toMatchObject({
      agentProfileId: 'Email automations need an agent profile.',
    });
    // Email is a trigger-stored prompt, so it is checked against the character limit, not bytes.
    expect(
      validateStep(withPrompt(email, 'x'.repeat(DEFAULT_CRON_TEMPLATE_MAX_LENGTH + 1)), 'what', CAN)
        .prompt
    ).toBe(`Keep it under ${DEFAULT_CRON_TEMPLATE_MAX_LENGTH} characters.`);
  });

  it('rejects GitHub actions that do not exist for the event', () => {
    const state = newEditorState({ start: 'github' }, NOW);
    expect(
      validateStep(
        { ...state, github: { ...state.github, eventType: 'issues', actions: 'opened, merged' } },
        'when',
        CAN
      ).github
    ).toMatch(/do not exist/);
  });

  it('skips prompt checks when the action is locked', () => {
    const state = newEditorState({ start: 'event' }, NOW);
    expect(validateStep(state, 'what', { canChangeAction: false })).toEqual({});
  });

  it('rejects a severity the API does not know', () => {
    const base = newEditorState({ start: 'event' }, NOW);
    const custom = {
      ...base,
      watch: { ...base.watch, preset: 'custom' as const, source: 'github', severity: 'urgent' },
    };
    expect(validateStep(custom, 'when', CAN).watch).toBe('Unknown severity: urgent.');
    expect(
      validateStep({ ...custom, watch: { ...custom.watch, severity: 'error' } }, 'when', CAN).watch
    ).toBeUndefined();
  });

  it('keeps watch limits inside what the API accepts', () => {
    const state = newEditorState({ start: 'event' }, NOW);
    expect(
      validateStep({ ...state, watch: { ...state.watch, maxExecutions: 101 } }, 'when', CAN).limits
    ).toMatch(/1 to 100 runs/);
    expect(
      validateStep({ ...state, watch: { ...state.watch, preset: 'custom' } }, 'when', CAN).watch
    ).toBe('Fill in at least one field.');
  });
});

describe('schedules', () => {
  it('reads weekday ranges the way onboarding writes them', () => {
    expect(parseDayList('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDayList('6,7')).toEqual([0, 6]);
    expect(parseDayList('MON')).toBeNull();
    expect(parseCronToMode('0 9 * * 1-5')).toMatchObject({
      mode: 'daily',
      dailyVariant: 'weekday',
    });
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM');
    expect(canonicalCron('0 9 * * 1-5')).toBe(canonicalCron('0 9 * * 1,2,3,4,5'));
  });

  it('opens a stored schedule in its preset only when that rebuilds the same schedule', () => {
    expect(scheduleFromCron('0 9 * * 1-5', 'UTC').preset).toBe('weekdays');
    expect(scheduleFromCron('15 */4 * * *', 'UTC')).toMatchObject({
      preset: 'hourly',
      everyHours: 4,
      minute: 15,
    });
    expect(scheduleFromCron('0 3 15 * *', 'UTC')).toMatchObject({
      preset: 'monthly',
      monthDay: 15,
    });
    // The old parser ignores the month and minute lists; these must not turn into "daily at 9".
    expect(scheduleFromCron('0 9 * 1 *', 'UTC')).toMatchObject({
      preset: 'custom',
      custom: '0 9 * 1 *',
    });
    expect(scheduleFromCron('0,30 9 * * *', 'UTC')).toMatchObject({ preset: 'custom' });
    expect(toCron(scheduleFromCron('0,30 9 * * *', 'UTC'))).toBe('0,30 9 * * *');
  });

  it('rejects expressions that run more often than every 15 minutes', () => {
    expect(shortestGapMinutes('*/5 * * * *')).toBe(5);
    expect(shortestGapMinutes('0 * * * *')).toBe(60);
    expect(shortestGapMinutes('0,30 9 * * *')).toBe(30);
    expect(cronError('*/10 9-17 * * 1-5')).toMatch(/every 15 minutes/);
    expect(cronError('0 9 * *')).toMatch(/five parts/);
    expect(cronError('0 9 * * 1-5')).toBeNull();
  });

  it('previews the next runs in the chosen zone', () => {
    const base = newEditorState({ start: 'schedule' }, NOW).schedule;
    const weekdays = nextRuns(
      { ...base, preset: 'weekdays', time: '09:00', zone: 'Europe/Paris' },
      NOW,
      3
    );
    expect(weekdays.map((at) => new Date(at).toISOString())).toEqual([
      '2026-10-21T07:00:00.000Z',
      '2026-10-22T07:00:00.000Z',
      '2026-10-23T07:00:00.000Z',
    ]);
    const hourly = nextRuns(
      { ...base, preset: 'hourly', everyHours: 6, minute: 15, zone: 'UTC' },
      NOW,
      2
    );
    expect(hourly.map((at) => new Date(at).toISOString())).toEqual([
      '2026-10-20T12:15:00.000Z',
      '2026-10-20T18:15:00.000Z',
    ]);
    const monthly = nextRuns(
      { ...base, preset: 'monthly', monthDay: 31, time: '08:00', zone: 'UTC' },
      NOW,
      2
    );
    expect(monthly.map((at) => new Date(at).toISOString())).toEqual([
      '2026-10-31T08:00:00.000Z',
      '2026-12-31T08:00:00.000Z',
    ]);
  });

  it('converts wall-clock times across a daylight-saving change', () => {
    // Paris leaves summer time on 2026-10-25.
    expect(zonedInputToInstant('2026-10-26T09:00', 'Europe/Paris')).toBe(
      Date.parse('2026-10-26T08:00:00Z')
    );
    expect(instantToZonedInput(Date.parse('2026-10-24T07:00:00Z'), 'Europe/Paris')).toBe(
      '2026-10-24T09:00'
    );
  });
});

describe('templates and save errors', () => {
  it('fills the flow from a template', () => {
    const state = templateById('release-failed')?.apply(newEditorState({}, NOW));
    expect(state).toMatchObject({
      start: 'event',
      name: 'Look into failed releases',
      watch: { preset: 'release-failed' },
    });
  });

  it('explains the per-project trigger limit and duplicate names', () => {
    expect(
      friendlySaveError(new Error('Maximum triggers per project (20) reached')).message
    ).toMatch(/most recurring and reacting automations it can have \(20\)/);
    expect(
      friendlySaveError(new Error('Trigger "A" already exists in this project'))
    ).toMatchObject({ field: 'name' });
  });

  it('explains a save refused because someone else changed the watch first', () => {
    expect(friendlySaveError(new Error('Standing watch version conflict')).message).toMatch(
      /Someone changed this automation while you were editing/
    );
    expect(friendlySaveError(new Error('Schedule version or state conflict')).message).toMatch(
      /Someone changed this automation/
    );
  });
});

describe('email start defaults (picked on Step 1, never from an effect)', () => {
  it('seeds the viewer’s email and the default prompt the moment Email is picked', () => {
    const base = newEditorState({ start: 'github' }, NOW);
    const picked = withEmailDefaults({ ...base, start: 'email' }, 'me@example.com');
    expect(picked.email.allowedSenders).toBe('me@example.com');
    expect(picked.action.prompt).toBe(DEFAULT_EMAIL_PROMPT_TEMPLATE);
  });

  it('does not clobber senders or a prompt the person already typed', () => {
    const base = newEditorState({ start: 'email' }, NOW);
    const edited = {
      ...base,
      email: { allowedSenders: 'already@typed.test' },
      action: { ...base.action, prompt: 'Already written.' },
    };
    const picked = withEmailDefaults(edited, 'me@example.com');
    expect(picked).toBe(edited); // no-op: identical object, not just equal values
  });

  it('does nothing when there is no viewer email, and nothing for a non-email start', () => {
    const base = newEditorState({ start: 'github' }, NOW);
    expect(withEmailDefaults({ ...base, start: 'email' }, null).email.allowedSenders).toBe('');
    const githubState = { ...base, start: 'github' as const };
    expect(withEmailDefaults(githubState, 'me@example.com')).toBe(githubState);
  });
});

describe('review filter validation before save', () => {
  it('rejects unknown association and review-state values in the details step', () => {
    const state = newEditorState({ start: 'github' }, NOW);
    const github = {
      ...state.github,
      eventType: 'pull_request_review' as const,
      actions: 'submitted',
      authorAssociation: 'ADMIN',
      reviewStates: '',
    };
    expect(validateStep({ ...state, github }, 'when', CAN).github).toContain('author association');
    expect(
      validateStep(
        { ...state, github: { ...github, authorAssociation: 'MEMBER', reviewStates: 'accepted' } },
        'when',
        CAN
      ).github
    ).toContain('review state');
    expect(
      validateStep(
        {
          ...state,
          github: { ...github, authorAssociation: 'MEMBER', reviewStates: 'changes_requested' },
        },
        'when',
        CAN
      ).github
    ).toBeUndefined();
  });
});
