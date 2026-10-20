import type {
  ProjectEventSubscriptionRecord,
  ProjectSchedule,
  ProjectStandingWatch,
  TriggerExecutionResponse,
  TriggerResponse,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { buildActivity, scheduleEntry } from '../../../src/pages/automation/activity';
import {
  describeEventFilter,
  executionText,
  githubTriggerWhen,
  isSamRelay,
} from '../../../src/pages/automation/describe';
import {
  attentionItems,
  buildAutomationItems,
  comingUp,
  failureStreak,
  fromSchedule,
  fromTrigger,
  fromWatch,
  titleFromPrompt,
  WATCH_CREATOR_ACCESS_REVOKED,
  WATCH_TARGET_NOT_OWNED,
} from '../../../src/pages/automation/model';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3_600_000;
const WINDOW = 3 * 24 * HOUR;

function trigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    id: 'trg-1',
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'Morning PR sweep',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * 1,2,3,4,5',
    cronTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    skipIfRunning: true,
    promptTemplate: 'Review open PRs',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: '2026-10-20T09:00:00Z',
    triggerCount: 4,
    nextFireAt: '2026-10-21T09:00:00Z',
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    ...overrides,
  };
}

function run(
  id: string,
  status: TriggerExecutionResponse['status'],
  completedAt: string,
  errorMessage: string | null = null
): TriggerExecutionResponse {
  return {
    id,
    triggerId: 'trg-1',
    projectId: 'proj-1',
    status,
    skipReason: status === 'skipped' ? 'still_running' : null,
    taskId: status === 'skipped' ? null : `task-${id}`,
    eventType: 'cron',
    renderedPrompt: null,
    errorMessage,
    scheduledAt: completedAt,
    startedAt: completedAt,
    completedAt,
    sequenceNumber: 1,
    createdAt: completedAt,
  };
}

function schedule(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return {
    id: 'sch-1',
    projectId: 'proj-1',
    creatorUserId: 'user-1',
    creatorChatSessionId: null,
    reason: null,
    action: { kind: 'message_session', sessionId: 'chat-1', prompt: 'Check the release\nmore' },
    state: 'pending',
    dueAt: NOW + 2 * HOUR,
    displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    expiresAt: NOW + 26 * HOUR,
    version: 1,
    idempotencyKey: 'key-1',
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    nextAttemptAt: null,
    attemptCount: 0,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
    ...overrides,
  };
}

function watch(overrides: Partial<ProjectStandingWatch> = {}): ProjectStandingWatch {
  return {
    id: 'wat-1',
    projectId: 'proj-1',
    creatorUserId: 'user-2',
    reason: null,
    filter: { version: 1, source: 'github', eventType: 'issues.opened' },
    action: { kind: 'start_session', prompt: 'Triage it', agentProfileId: null, skillId: null },
    state: 'active',
    version: 3,
    idempotencyKey: 'key-w',
    cooldownMs: 60_000,
    maxConcurrent: 1,
    maxExecutions: 10,
    executionCount: 2,
    nextEligibleAt: 0,
    subscriptionId: 'sub-w',
    createdAt: NOW - 48 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    lastError: null,
    ...overrides,
  };
}

describe('trigger attention', () => {
  it('flags a paused trigger whose last finished runs all failed, without claiming who paused it', () => {
    const runs = [
      run('r4', 'skipped', '2026-10-20T11:00:00Z'),
      run('r3', 'failed', '2026-10-20T10:00:00Z', 'GitHub token expired'),
      run('r2', 'failed', '2026-10-19T10:00:00Z'),
      run('r1', 'failed', '2026-10-18T10:00:00Z'),
    ];
    const item = fromTrigger(trigger({ status: 'paused' }), runs);
    expect(failureStreak(runs)).toBe(3);
    expect(item.attention).toMatchObject({
      tone: 'danger',
      title: 'Paused · its last 3 runs failed',
      fix: 'resume',
    });
    expect(item.attention?.body).toContain('The last error was: GitHub token expired');
    expect(item.attention?.body).toContain('Resuming starts the count again.');
    expect(item.attention?.title).not.toMatch(/automatically|SAM paused/i);
  });

  it('does not flag a trigger whose newest finished run succeeded', () => {
    const runs = [
      run('r3', 'completed', '2026-10-20T10:00:00Z'),
      run('r2', 'failed', '2026-10-19T10:00:00Z'),
      run('r1', 'failed', '2026-10-18T10:00:00Z'),
    ];
    expect(fromTrigger(trigger({ status: 'paused' }), runs).attention).toBeNull();
  });

  it('asks an active trigger with a failure streak to be reviewed, not resumed', () => {
    const runs = ['a', 'b', 'c'].map((id) => run(id, 'failed', '2026-10-20T10:00:00Z'));
    expect(fromTrigger(trigger(), runs).attention).toMatchObject({ fix: 'review-runs' });
  });

  it('stays quiet until runs have loaded', () => {
    expect(fromTrigger(trigger({ status: 'paused' })).attention).toBeNull();
  });
});

describe('trigger presentation', () => {
  it('describes a weekday cron and notes a zone that is not the viewer’s', () => {
    const item = fromTrigger(trigger({ cronTimezone: 'Pacific/Chatham' }));
    expect(item.when).toBe('Weekdays at 9:00 AM');
    expect(item.whenNote).toBe('Pacific/Chatham time');
    expect(item.nextAt).toBe(Date.parse('2026-10-21T09:00:00Z'));
  });

  it('falls back to the API wording for a cron it cannot read', () => {
    const item = fromTrigger(
      trigger({ cronExpression: '*/15 9-17 * * 1-5', cronHumanReadable: 'Every 15 minutes' })
    );
    expect(item.when).toBe('Every 15 minutes');
  });

  it('has no next run while paused', () => {
    expect(fromTrigger(trigger({ status: 'paused' })).nextAt).toBeNull();
  });

  it('describes GitHub triggers in words', () => {
    expect(githubTriggerWhen('issue_comment', { commandPrefix: '/sam' })).toBe(
      'When someone comments /sam on an issue or PR'
    );
    expect(githubTriggerWhen('pull_request', { actions: ['opened', 'synchronize'] })).toBe(
      'When a pull request is opened or updated with new commits'
    );
    expect(githubTriggerWhen('push', { branches: ['main'] })).toBe('When code is pushed to main');
  });
});

describe('one-time schedules', () => {
  it('names an unnamed schedule after the first line of its prompt', () => {
    expect(fromSchedule(schedule(), NOW, WINDOW).name).toBe('Check the release');
    expect(fromSchedule(schedule({ reason: 'Release check' }), NOW, WINDOW).name).toBe(
      'Release check'
    );
    expect(titleFromPrompt('x'.repeat(120), 'fallback')).toHaveLength(80);
  });

  it('reads a past-due pending schedule as waiting to start', () => {
    const item = fromSchedule(schedule({ dueAt: NOW - HOUR }), NOW, WINDOW);
    expect(item.state).toBe('late');
    expect(item.stateNote).toMatch(/^Waiting to start/);
  });

  it('raises unconfirmed and failed schedules only inside the attention window', () => {
    const recent = fromSchedule(
      schedule({ state: 'ambiguous', updatedAt: NOW - HOUR }),
      NOW,
      WINDOW
    );
    expect(recent.attention).toMatchObject({
      title: 'Could not confirm it ran',
      fix: 'check-receipt',
    });
    const old = fromSchedule(
      schedule({ state: 'failed', updatedAt: NOW - WINDOW - HOUR }),
      NOW,
      WINDOW
    );
    expect(old.attention).toBeNull();
    expect(old.state).toBe('done');
  });
});

describe('standing watches', () => {
  it('says what the watch waits for and how many runs it used', () => {
    const item = fromWatch(watch(), null);
    expect(item.when).toBe('When an issue is opened');
    expect(item.name).toBe('When an issue is opened');
    expect(item.stateNote).toBe('2 of 10 runs used');
  });

  it('flags a watch that used all its runs', () => {
    expect(fromWatch(watch({ executionCount: 10 }), null).attention).toMatchObject({
      fix: 'raise-limit',
    });
    expect(fromWatch(watch({ executionCount: 10, state: 'revoked' }), null).attention).toBeNull();
  });

  it('does not offer to raise a watch that is already at the most runs a watch can have', () => {
    const attention = fromWatch(watch({ executionCount: 100, maxExecutions: 100 }), null).attention;
    expect(attention).toMatchObject({ fix: 'review' });
    expect(attention?.body).toMatch(/Create a new watch/);
  });

  it('never offers resume as the fix for a watch paused because of a problem', () => {
    const attention = fromWatch(
      watch({ state: 'paused', lastError: WATCH_TARGET_NOT_OWNED }),
      null
    ).attention;
    expect(attention).toMatchObject({ tone: 'danger', title: 'Paused by SAM', fix: 'review' });
    expect(attention?.body).toMatch(/no longer owns the chat/);
    expect(
      fromWatch(watch({ state: 'paused', lastError: WATCH_CREATOR_ACCESS_REVOKED }), null).attention
    ).toMatchObject({ fix: 'review' });
  });

  it('reads a person’s own pause reason as a note, not a problem', () => {
    const item = fromWatch(
      watch({ state: 'paused', lastError: 'Release freeze until Monday' }),
      null
    );
    expect(item.attention).toBeNull();
    expect(item.stateNote).toBe('Paused: Release freeze until Monday');
    expect(fromWatch(watch({ state: 'paused' }), null).attention).toBeNull();
  });
});

describe('collections', () => {
  it('folds schedules a watch created into that watch instead of listing them', () => {
    const items = buildAutomationItems(
      {
        triggers: [trigger()],
        runsByTrigger: new Map(),
        schedules: [schedule(), schedule({ id: 'sch-w', watchId: 'wat-1', createdAt: NOW - 5 })],
        watches: [watch()],
      },
      NOW,
      WINDOW
    );
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'trigger:trg-1',
      'schedule:sch-1',
      'watch:wat-1',
    ]);
    expect(items.find((item) => item.kind === 'watch')?.lastRunAt).toBe(NOW - 5);
  });

  it('orders attention by severity, then recency, and coming up by time', () => {
    const items = buildAutomationItems(
      {
        triggers: [],
        runsByTrigger: new Map(),
        schedules: [
          schedule({ id: 'a', state: 'ambiguous', updatedAt: NOW - 1 }),
          schedule({ id: 'f', state: 'failed', updatedAt: NOW - 10 }),
          schedule({ id: 'soon', dueAt: NOW + HOUR }),
          schedule({ id: 'later', dueAt: NOW + 5 * HOUR }),
        ],
        watches: [],
      },
      NOW,
      WINDOW
    );
    expect(attentionItems(items).map((item) => item.id)).toEqual(['f', 'a']);
    expect(comingUp(items, 1).map((item) => item.id)).toEqual(['soon']);
  });
});

describe('event filters and agent waits', () => {
  it('describes common waits in plain words', () => {
    expect(
      describeEventFilter({
        version: 1,
        source: 'github',
        eventType: 'check_suite.completed',
        subjectType: 'commit',
        subjectId: 'abc1234def5678',
      }).noun
    ).toBe('CI to finish on commit abc1234');
    expect(
      describeEventFilter({
        version: 1,
        source: 'sam.agent_channel',
        eventType: 'agent.channel.published',
        subjectType: 'agent_channel',
        subjectId: 'release-train',
      }).clause
    ).toBe('someone posts on #release-train');
    expect(
      describeEventFilter({
        version: 1,
        source: 'sam.lifecycle',
        eventType: 'deployment.release.failed',
      }).clause
    ).toBe('a release fails');
  });

  it('recognises SAM’s own agent-message relays', () => {
    const relay = {
      owner: { type: 'agent', id: 'p:chat', name: 'SAM agent messaging' },
      filter: {
        version: 1,
        source: 'sam.agent_channel',
        subjectType: 'agent_channel',
        subjectId: 'agent-dm.0123456789abcdef0123456789abcdef01234567',
      },
    } as unknown as ProjectEventSubscriptionRecord;
    const ownChannel = {
      owner: { type: 'agent', id: 'p:chat', name: null },
      filter: { version: 1, subjectType: 'agent_channel', subjectId: 'release-train' },
    } as unknown as ProjectEventSubscriptionRecord;
    const ci = {
      owner: { type: 'agent', id: 'p:chat', name: null },
      filter: { version: 1, subjectType: 'commit', subjectId: 'agent-dm.lookalike' },
    } as unknown as ProjectEventSubscriptionRecord;
    expect(isSamRelay(relay)).toBe(true);
    expect(isSamRelay(ownChannel)).toBe(false);
    expect(isSamRelay(ci)).toBe(false);
  });
});

describe('activity', () => {
  it('merges trigger runs and finished one-time actions, newest first, crediting watches', () => {
    const entries = buildActivity(
      [trigger()],
      new Map([['trg-1', [run('r1', 'failed', '2026-10-20T10:00:00Z', 'boom')]]]),
      [
        schedule({ id: 'pending' }),
        schedule({ id: 'done', state: 'admitted', updatedAt: NOW - 1 }),
        schedule({ id: 'by-watch', state: 'admitted', watchId: 'wat-1', updatedAt: NOW - 2 }),
      ]
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      'schedule:done',
      'schedule:by-watch',
      'run:r1',
    ]);
    expect(entries[1]?.owner).toEqual({ kind: 'watch', id: 'wat-1' });
    expect(entries[2]?.text).toBe('Failed: boom');
  });

  it('says a skipped run was skipped and why', () => {
    expect(executionText(run('s', 'skipped', '2026-10-20T10:00:00Z'))).toBe(
      'Skipped because the previous run was still going'
    );
    expect(scheduleEntry(schedule({ state: 'cancelled' }))).toBeNull();
  });
});
