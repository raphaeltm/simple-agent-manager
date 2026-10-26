import type {
  ProjectEventSubscriptionRecord,
  ProjectSchedule,
  ProjectStandingWatch,
  TriggerExecutionResponse,
  TriggerResponse,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { AUTOMATION_STARTS } from '../../../src/lib/automation-routes';
import { buildActivity, runEntry, scheduleEntry } from '../../../src/pages/automation/activity';
import { triggerAdvancedRows } from '../../../src/pages/automation/advanced-rows';
import { triggersNeedingRuns } from '../../../src/pages/automation/data';
import {
  describeEventFilter,
  emailTriggerWhen,
  executionOutcome,
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
  isReaction,
  titleFromPrompt,
  WATCH_CREATOR_ACCESS_REVOKED,
  WATCH_TARGET_NOT_OWNED,
} from '../../../src/pages/automation/model';
import { START_META } from '../../../src/pages/automation/ui';

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
      'When a pull request is opened or updated with new commits · excluding drafts'
    );
    expect(githubTriggerWhen('push', { branches: ['main'] })).toBe('When code is pushed to main');
    expect(
      githubTriggerWhen('pull_request', { actions: ['labeled'], labels: ['needs-review'] })
    ).toBe('When a label is added to a pull request with needs-review · excluding drafts');
    expect(githubTriggerWhen('issues', { actions: ['opened'], labels: ['bug'] })).toBe(
      'When an issue labeled bug is opened'
    );
  });

  it('states comment subject and every configured review restriction', () => {
    expect(
      githubTriggerWhen('issue_comment', { isPullRequest: false, commandPrefix: '/sam' })
    ).toBe('When someone comments /sam on an issue');
    const sentence = githubTriggerWhen('pull_request_review', {
      actions: ['submitted'],
      commandPrefix: '/review',
      reviewStates: ['approved'],
      actors: ['alice'],
      authorAssociation: ['MEMBER'],
      ignoreBots: true,
      commentContains: 'yes',
    });
    for (const condition of ['/review', 'approved', 'alice', 'MEMBER', 'users only', 'yes'])
      expect(sentence).toContain(condition);
  });

  it('maps an email trigger to the email start kind, its real address, and the reacting group', () => {
    const item = fromTrigger(
      trigger({
        sourceType: 'email',
        cronExpression: null,
        emailConfig: {
          address: 'agent+k3j2h7m9q2xw4n8p@agents.example.com',
          allowedSenders: ['a@x.test'],
        },
      })
    );
    // Before this fix, a trigger without a `case 'email'` fell through `triggerWhen`'s cron
    // `default:` branch and misread as "No schedule" (rule 79 — a denylist default silently
    // reclassifies a new enum member).
    expect(item.start).toBe('email');
    expect(item.when).toBe('When an email arrives at agent+k3j2h7m9q2xw4n8p@agents.example.com');
    expect(item.whenNote).toBeUndefined();
    expect(item.nextAt).toBeNull();
    expect(isReaction(item)).toBe(true);
  });

  it('reads an email trigger missing its config as "No schedule" only through explicit absence, not the cron default', () => {
    // No emailConfig at all (e.g. a load race) still reads as an email automation, never as cron.
    const item = fromTrigger(trigger({ sourceType: 'email', cronExpression: null }));
    expect(item.start).toBe('email');
    expect(item.when).toBe('When someone emails this automation’s address');
  });

  it('describes an email trigger before and after it has an address', () => {
    expect(emailTriggerWhen(null)).toBe('When someone emails this automation’s address');
    expect(emailTriggerWhen('agent+abc@agents.example.com')).toBe(
      'When an email arrives at agent+abc@agents.example.com'
    );
  });
});

describe('every start kind has presentation metadata', () => {
  it('gives START_META an entry for every automation start plus the admin-only incident kind', () => {
    // A `Record<StartKind, …>` is compiler-enforced, but this guards the invariant even if
    // `START_META`'s type is ever loosened to a `Partial`.
    for (const start of [...AUTOMATION_STARTS, 'incident']) {
      expect(START_META, `missing START_META entry for "${start}"`).toHaveProperty(start);
    }
    expect(Object.keys(START_META).sort()).toEqual(
      [...AUTOMATION_STARTS, 'incident'].slice().sort()
    );
  });

  it('groups email with webhook and GitHub as a reaction, not a schedule', () => {
    const base = trigger();
    expect(isReaction(fromTrigger({ ...base, sourceType: 'email', cronExpression: null }))).toBe(
      true
    );
    expect(isReaction(fromTrigger({ ...base, sourceType: 'webhook', cronExpression: null }))).toBe(
      true
    );
    expect(isReaction(fromTrigger(base))).toBe(false); // cron stays "scheduled"
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
    expect(item.stateNote).toMatch(/^It keeps trying until/);
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

  it('preserves uncertain delivery and stable routed chat links in History', () => {
    const routed = {
      ...run('r', 'routed', '2026-10-20T10:00:00Z'),
      taskId: null,
      routedTaskId: 'old-task',
      routedSessionId: 'stable-chat',
    };
    expect(runEntry(trigger(), routed).chat).toEqual({ sessionId: 'stable-chat' });
    const uncertain = {
      ...routed,
      status: 'dropped' as const,
      skipReason: 'delivery_uncertain' as const,
    };
    expect(executionOutcome(uncertain)).toBe('unknown');
    expect(executionText(uncertain)).toBe(
      'May have reached the chat, but SAM could not confirm it'
    );
    expect(runEntry(trigger(), { ...routed, status: 'waiting' }).chat).toBeNull();
    expect(
      runEntry(trigger(), { ...routed, status: 'dropped', skipReason: 'target_unavailable' }).chat
    ).toBeNull();
    expect(
      runEntry(trigger(), { ...routed, status: 'dropped', skipReason: 'queue_expired' }).chat
    ).toBeNull();
    expect(executionOutcome({ ...routed, status: 'routing' })).toBe('waiting');
  });

  it('says a skipped run was skipped and why', () => {
    expect(executionText(run('s', 'skipped', '2026-10-20T10:00:00Z'))).toBe(
      'Skipped because the previous run was still going'
    );
    expect(scheduleEntry(schedule({ state: 'cancelled' }))).toBeNull();
  });
});

describe('event wording fallbacks', () => {
  it('names an event type nobody wrote words for, instead of saying "matching activity"', () => {
    expect(
      describeEventFilter({ version: 1, source: 'github', eventType: 'repository.renamed' }).noun
    ).toBe('a GitHub “repository renamed” event');
    expect(describeEventFilter({ version: 1, eventType: 'custom.thing_done' }).clause).toBe(
      'a “custom thing done” event arrives'
    );
    expect(
      describeEventFilter({
        version: 1,
        source: 'github',
        eventType: 'pull_request.review_requested',
      }).clause
    ).toBe('someone requests a PR review');
    expect(describeEventFilter({ version: 1, source: 'github' }).noun).toBe(
      'matching GitHub activity'
    );
    // How agents usually wait for CI: every CI completion type at once, pinned to a commit.
    expect(
      describeEventFilter({
        version: 1,
        source: 'github',
        eventType: ['check_run.completed', 'check_suite.completed', 'workflow_run.completed'],
        subjectType: 'commit',
        subjectId: 'abcdef1234567',
      }).noun
    ).toBe('CI to finish on commit abcdef1');
    // Mixed types that do not share a meaning still fall back to the family.
    expect(
      describeEventFilter({
        version: 1,
        source: 'github',
        eventType: ['issues.opened', 'pull_request.opened'],
      }).noun
    ).toBe('matching GitHub activity');
    expect(
      describeEventFilter({
        version: 1,
        source: 'webhook',
        eventType: 'webhook.accepted',
        subjectType: 'webhook_trigger',
        subjectId: 'trig-webhook-stripe',
      }).noun
    ).toBe('a webhook call to webhook trig-webhook');
  });
});

describe('which triggers get their runs read', () => {
  const fired = (
    id: string,
    hoursAgo: number | null,
    status: TriggerResponse['status'] = 'active'
  ) =>
    trigger({
      id,
      status,
      lastTriggeredAt:
        hoursAgo === null
          ? null
          : new Date(Date.UTC(2026, 9, 20, 12) - hoursAgo * 3_600_000).toISOString(),
    });

  it('reads paused triggers first, then the most recently fired, within the cap', () => {
    const triggers = [
      fired('old', 30),
      fired('paused-old', 50, 'paused'),
      fired('new', 1),
      fired('never', null),
      fired('paused-new', 2, 'paused'),
    ];
    const all = triggersNeedingRuns(triggers, 'overview', 25);
    expect(all.read.map((item) => item.id)).toEqual(['paused-new', 'paused-old', 'new', 'old']);
    expect(all.unread).toBe(0);
    const capped = triggersNeedingRuns(triggers, 'overview', 3);
    expect(capped.read.map((item) => item.id)).toEqual(['paused-new', 'paused-old', 'new']);
    expect(capped.unread).toBe(1);
  });

  it('reads every trigger on History, most recently fired first, and counts what the cap left out', () => {
    const triggers = [fired('a', 5), fired('b', 1), fired('c', null), fired('d', 3)];
    const history = triggersNeedingRuns(triggers, 'all', 2);
    expect(history.read.map((item) => item.id)).toEqual(['b', 'd']);
    expect(history.unread).toBe(2);
  });
});

describe('saved structured GitHub filter presentation', () => {
  const lookups = {
    chats: [],
    profiles: [],
    skills: [],
    chatTitle: () => 'Chat',
    profileName: () => 'Agent',
    skillName: () => null,
    agentEmail: { enabled: false, domain: null },
  };
  it('shows only active comment/review/subject filters and keeps sender restrictions visible', () => {
    const filters = {
      actors: ['alice'],
      ignoreBots: true,
      authorAssociation: ['MEMBER'],
      commentContains: '/sam',
      commandPrefix: '/sam',
      reviewStates: ['changes_requested'],
      isPullRequest: true,
      addedLabel: 'sam',
      branches: ['feature'],
    };
    const review = trigger({
      sourceType: 'github',
      githubConfig: { eventType: 'pull_request_review', filters },
    });
    const rows = new Map(triggerAdvancedRows(review, lookups, () => 'Owner'));
    expect(rows.get('Allowed actors')).toBe('alice');
    expect(rows.get('Author association')).toContain('MEMBER');
    expect(rows.get('Review states')).toBe('changes_requested');
    expect(rows.get('Comment contains')).toBe('/sam');
    expect(rows.has('Changed label')).toBe(false);
    const pushed = new Map(
      triggerAdvancedRows(
        { ...review, githubConfig: { eventType: 'push', filters } },
        lookups,
        () => 'Owner'
      )
    );
    expect(pushed.has('Review states')).toBe(false);
    expect(pushed.has('Comment contains')).toBe(false);
    expect(pushed.has('Author association')).toBe(false);
    expect(pushed.has('Subject')).toBe(false);
    expect(pushed.get('Allowed actors')).toBe('alice');
  });
});
