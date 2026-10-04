/**
 * The bounded sleep-failure episode's pure decisions: which phase a row is in, which
 * budget ended the full phase, how the configured knobs resolve through the real
 * readers, and the stored decision record. The scheduled path that consumes these is
 * covered end to end in `tests/integration/session-sleep-bounded-fallback.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  DEFAULT_SESSION_SLEEP_FAILURE_MAX_ATTEMPTS,
  DEFAULT_SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS,
  parseSessionSleepFallbackRecord,
  serializeSessionSleepFallbackRecord,
  type SessionSleepFallbackRecord,
  sessionSleepEpisodeConfig,
  sessionSleepEpisodePhase,
  sessionSleepEpisodeTrigger,
} from '../../../src/services/session-sleep-episode';
import {
  SESSION_RECOVERY_INITIAL_PROMPT,
  sessionRecoveryInitialPrompt,
  sessionSleepBlockedNotice,
  sessionSleepFallbackNotice,
} from '../../../src/services/session-sleep-fallback-messages';

const STARTED = '2026-10-04T08:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(STARTED) + ms);
const env = (overrides: Partial<Env> = {}) => overrides as Env;

function record(overrides: Partial<SessionSleepFallbackRecord> = {}): SessionSleepFallbackRecord {
  return {
    version: 1,
    outcome: 'slept',
    trigger: 'attempt_budget',
    blockedReason: null,
    decidedAt: '2026-10-04T08:15:00.000Z',
    episodeStartedAt: STARTED,
    failedAttempts: 3,
    lastError: 'Workspace snapshot completion was not durably verified',
    recoveryPoint: {
      generation: 'gen-3',
      commit: 'f'.repeat(40),
      branch: 'sam/feature',
      detached: false,
      upstream: 'origin/sam/feature',
      capturedAt: '2026-10-04T08:10:00.000Z',
      snapshotStatus: 'degraded',
      degradation: 'home-skipped',
      workingTreeSaved: true,
      homeSaved: false,
    },
    ...overrides,
  };
}

describe('sessionSleepEpisodeConfig', () => {
  it('resolves the production defaults through the real readers', () => {
    expect(sessionSleepEpisodeConfig(env())).toEqual({
      failureMaxAttempts: DEFAULT_SESSION_SLEEP_FAILURE_MAX_ATTEMPTS,
      failureMaxElapsedMs: DEFAULT_SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS,
      ceilingFailures: 9,
    });
    expect(DEFAULT_SESSION_SLEEP_FAILURE_MAX_ATTEMPTS).toBe(3);
    expect(DEFAULT_SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS).toBe(15 * 60 * 1000);
  });

  it('reads each knob from its own variable', () => {
    expect(
      sessionSleepEpisodeConfig(
        env({
          SESSION_SLEEP_FAILURE_MAX_ATTEMPTS: '5',
          SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS: '60000',
          SESSION_SLEEP_MAX_ATTEMPTS: '12',
        })
      )
    ).toEqual({ failureMaxAttempts: 5, failureMaxElapsedMs: 60_000, ceilingFailures: 12 });
  });

  it('keeps the ceiling above the full budget so the fallback always gets an attempt', () => {
    const config = sessionSleepEpisodeConfig(
      env({ SESSION_SLEEP_FAILURE_MAX_ATTEMPTS: '6', SESSION_SLEEP_MAX_ATTEMPTS: '4' })
    );
    expect(config.ceilingFailures).toBe(7);
    expect(
      sessionSleepEpisodePhase(
        { sleepEpisodeStartedAt: STARTED, sleepEpisodeFailures: 6 },
        at(0),
        config
      )
    ).toBe('fallback');
  });

  it('ignores invalid values', () => {
    expect(
      sessionSleepEpisodeConfig(
        env({ SESSION_SLEEP_FAILURE_MAX_ATTEMPTS: '0', SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS: 'x' })
      )
    ).toMatchObject({ failureMaxAttempts: 3, failureMaxElapsedMs: 15 * 60 * 1000 });
  });
});

describe('sessionSleepEpisodePhase', () => {
  const config = sessionSleepEpisodeConfig(env());
  const phase = (failures: number | null, nowMs: number, startedAt: string | null = STARTED) =>
    sessionSleepEpisodePhase(
      { sleepEpisodeStartedAt: startedAt, sleepEpisodeFailures: failures },
      at(nowMs),
      config
    );

  it('stays full below the attempt budget and falls back exactly at it', () => {
    expect(phase(2, 0)).toBe('full');
    expect(phase(3, 0)).toBe('fallback');
  });

  it('falls back exactly when the elapsed budget is reached', () => {
    expect(phase(1, 15 * 60 * 1000 - 1)).toBe('full');
    expect(phase(1, 15 * 60 * 1000)).toBe('fallback');
  });

  it('needs a failure before time alone ends the full phase', () => {
    // A session that has only been deferred (never idle) never reaches the fallback.
    expect(phase(0, 60 * 60 * 1000)).toBe('full');
  });

  it('ends blocked at the ceiling', () => {
    expect(phase(8, 0)).toBe('fallback');
    expect(phase(9, 0)).toBe('blocked');
  });

  it('cannot measure time from an unreadable start, but the attempt budget still bounds it', () => {
    expect(phase(1, 24 * 60 * 60 * 1000, 'not-a-date')).toBe('full');
    expect(phase(3, 0, 'not-a-date')).toBe('fallback');
  });

  it('reads a row written before the column default as a fresh episode', () => {
    expect(phase(null, 60 * 60 * 1000, null)).toBe('full');
  });

  it('names the budget that ended the full phase', () => {
    const trigger = (failures: number, nowMs: number) =>
      sessionSleepEpisodeTrigger(
        { sleepEpisodeStartedAt: STARTED, sleepEpisodeFailures: failures },
        at(nowMs),
        config
      );
    expect(trigger(1, 0)).toBeNull();
    expect(trigger(3, 0)).toBe('attempt_budget');
    expect(trigger(1, 15 * 60 * 1000)).toBe('elapsed_budget');
    expect(trigger(9, 0)).toBe('retry_ceiling');
  });
});

describe('the stored fallback record', () => {
  it('round-trips through the validated serializer', () => {
    const value = record();
    expect(parseSessionSleepFallbackRecord(serializeSessionSleepFallbackRecord(value))).toEqual(
      value
    );
  });

  it('reads malformed or foreign JSON as absent instead of throwing', () => {
    expect(parseSessionSleepFallbackRecord(null)).toBeNull();
    expect(parseSessionSleepFallbackRecord('{')).toBeNull();
    expect(parseSessionSleepFallbackRecord('{"version":2,"outcome":"slept"}')).toBeNull();
    expect(parseSessionSleepFallbackRecord('{"version":1,"outcome":"blocked"}')).toBeNull();
  });

  it('refuses to serialize a record that does not match the schema', () => {
    expect(() =>
      serializeSessionSleepFallbackRecord({ ...record(), outcome: 'other' } as never)
    ).toThrow();
  });
});

describe('what the user and the woken agent are told', () => {
  it('says plainly what a fallback kept and lost, without promising an exact restore', () => {
    const notice = sessionSleepFallbackNotice(record());
    expect(notice).toContain('SAM put this session to sleep without saving all of its files.');
    expect(notice).toContain('Saving a complete snapshot failed after 3 attempts over 15 minutes.');
    expect(notice).toContain(`branch sam/feature at commit ${'f'.repeat(12)}`);
    expect(notice).toContain('installed tools and the agent’s own session files');
    expect(notice).toContain('rebuilds its context from this conversation');
    expect(notice).not.toMatch(/exact(ly)? (restore|reconstruct)/i);
  });

  it('describes a complete recovery point differently', () => {
    const notice = sessionSleepFallbackNotice(
      record({
        recoveryPoint: {
          ...record().recoveryPoint!,
          snapshotStatus: 'available',
          degradation: 'none',
          homeSaved: true,
        },
      })
    );
    expect(notice).toContain('SAM put this session to sleep using its last complete snapshot.');
    expect(notice).toContain('Not kept: any change made after that snapshot was saved.');
  });

  it('tells the user what to do when the episode ends blocked', () => {
    const blocked = record({
      outcome: 'blocked',
      blockedReason: 'no_git_baseline',
      recoveryPoint: null,
    });
    const vm = sessionSleepBlockedNotice(blocked, 'vm');
    expect(vm).toContain('SAM could not put this session to sleep.');
    expect(vm).toContain('no saved snapshot records which Git commit the workspace is on');
    expect(vm).toContain('Its workspace keeps running.');
    expect(vm).toContain('commit and push anything you want to keep, then archive');
    expect(sessionSleepBlockedNotice(blocked, 'cf-container')).toContain(
      'This Instant workspace keeps running'
    );
  });

  it('keeps the ordinary wake prompt for a normal sleep', () => {
    expect(sessionRecoveryInitialPrompt(null)).toBe(SESSION_RECOVERY_INITIAL_PROMPT);
    expect(
      sessionRecoveryInitialPrompt(
        record({ outcome: 'blocked', blockedReason: 'no_git_baseline', recoveryPoint: null })
      )
    ).toBe(SESSION_RECOVERY_INITIAL_PROMPT);
  });

  it('guides a fallback wake to check Git state and not replay outside effects', () => {
    const prompt = sessionRecoveryInitialPrompt(record());
    expect(prompt).toContain('Use get_session_messages for this chat session');
    expect(prompt).toContain(`SAM restored commit ${'f'.repeat(40)} on branch sam/feature`);
    expect(prompt).toContain(`confirm the workspace is at commit ${'f'.repeat(12)}`);
    expect(prompt).toContain('pushes, pull requests, deployments, messages, or API calls');
    expect(prompt).toContain('Then wait for and answer the latest queued follow-up message.');
  });
});
