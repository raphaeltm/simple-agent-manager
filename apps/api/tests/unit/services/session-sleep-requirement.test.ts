/**
 * Policy a3780107 (2026-11-03): a required sleep must not fail. These pin which sleeps are
 * required, which only skip the idle interval, and which are unchanged.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyRequiredSleepTurn,
  sleepStateChanged,
} from '../../../src/services/session-sleep-eligibility';
import {
  classifySleepRequirement,
  isLifetimeGovernedNode,
  isPersonRequiredSleepEpisode,
  resolveSleepRequirement,
} from '../../../src/services/session-sleep-requirement';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-03T12:00:00.000Z');
const LIFETIME = 24 * HOUR;
const LEEWAY = 30 * 60 * 1000;

function node(ageMs: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeCreatedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    nodeRole: 'workspace',
    nodeClass: 'managed',
    nodeAutoProvisioned: 1,
    ...overrides,
  };
}

function classify(ageMs: number, overrides: Record<string, unknown> = {}, person = false) {
  return classifySleepRequirement(node(ageMs, overrides), NOW, {
    absoluteMaxLifetimeMs: LIFETIME,
    forceSleepAfterMs: LEEWAY,
    requestedByPerson: person,
  });
}

describe('classifySleepRequirement', () => {
  it('makes every person-initiated sleep required, even on a young node', () => {
    expect(classify(HOUR, {}, true)).toBe('required');
  });

  it('leaves a node inside its lifetime normal', () => {
    expect(classify(LIFETIME - 1)).toBe('normal');
  });

  it('is a deadline from the absolute lifetime until the leeway runs out', () => {
    expect(classify(LIFETIME)).toBe('deadline');
    expect(classify(LIFETIME + LEEWAY - 1)).toBe('deadline');
  });

  it('is required once the leeway after the absolute lifetime has passed', () => {
    expect(classify(LIFETIME + LEEWAY)).toBe('required');
    expect(classify(LIFETIME + 5 * HOUR)).toBe('required');
  });

  it.each([
    ['a user-owned node', { nodeClass: 'user-owned' }],
    ['a deployment node', { nodeRole: 'deployment' }],
    ['a node no task auto-provisioned', { nodeAutoProvisioned: 0 }],
    ['a node with an unreadable age', { nodeCreatedAt: 'not-a-date' }],
  ])('never forces %s, however old', (_label, overrides) => {
    expect(classify(LIFETIME + 5 * HOUR, overrides)).toBe('normal');
  });
});

describe('isLifetimeGovernedNode', () => {
  it('matches the lifetime sweep population: auto-provisioned managed workspace nodes', () => {
    expect(isLifetimeGovernedNode(node(0))).toBe(true);
    expect(isLifetimeGovernedNode(node(0, { nodeAutoProvisioned: null }))).toBe(false);
  });
});

describe('resolveSleepRequirement', () => {
  it('does not read the leeway setting for a node inside its lifetime', async () => {
    // An env with no admin-settings store: a read would fall back loudly, not return normal.
    const env = { NODE_ABSOLUTE_MAX_LIFETIME_MS: String(LIFETIME) } as never;
    await expect(
      resolveSleepRequirement(env, node(HOUR), NOW, { requestedByPerson: false })
    ).resolves.toBe('normal');
  });

  it('enforces the deadline even when the settings store is unavailable', async () => {
    const env = { NODE_ABSOLUTE_MAX_LIFETIME_MS: String(LIFETIME) } as never;
    await expect(
      resolveSleepRequirement(env, node(LIFETIME + 31 * 60 * 1000), NOW, {
        requestedByPerson: false,
      })
    ).resolves.toBe('required');
  });
});

describe('classifyRequiredSleepTurn', () => {
  it('blocks only while a turn is running', () => {
    expect(classifyRequiredSleepTurn({ activity: 'prompting' })).toMatchObject({ idle: false });
  });

  it('does not count the cancelled agent restarting (recovering) as a turn', () => {
    expect(classifyRequiredSleepTurn({ activity: 'recovering' })).toMatchObject({ idle: true });
  });

  it('ignores a harness lease, the idle interval and an unknown state', () => {
    expect(
      classifyRequiredSleepTurn({
        activity: 'idle',
        activityAt: NOW.getTime(),
        runtimeWorkState: 'active',
        runtimeWorkUpdatedAt: NOW.getTime(),
        runtimeWorkProgressAt: NOW.getTime(),
      })
    ).toMatchObject({ idle: true });
    expect(classifyRequiredSleepTurn(null)).toMatchObject({ idle: true });
  });
});

describe('sleepStateChanged', () => {
  const idle = { activity: 'idle', activityAt: 1, workAt: 1 };

  it('never aborts a required sleep on its own; the required gate refuses a new turn', () => {
    expect(
      sleepStateChanged(idle, { ...idle, runtimeWorkState: 'inactive', workAt: 2 }, 'required')
    ).toBe(false);
    // A new prompt turn is refused by the required gate itself (classifyRequiredSleepTurn).
    expect(sleepStateChanged(idle, { ...idle, activity: 'prompting' }, 'required')).toBe(false);
    expect(sleepStateChanged(idle, { ...idle, activity: 'recovering' }, 'required')).toBe(false);
  });

  it('keeps the work-clock comparison for normal and deadline sleeps', () => {
    expect(sleepStateChanged(idle, { ...idle, workAt: 2 }, 'normal')).toBe(true);
    expect(sleepStateChanged(idle, { ...idle, workAt: 2 }, 'deadline')).toBe(true);
    expect(sleepStateChanged(idle, { ...idle }, 'normal')).toBe(false);
  });
});

describe('isPersonRequiredSleepEpisode', () => {
  const episode = '2026-11-03T11:00:00.000Z';

  it('is required while the marked episode lasts', () => {
    expect(
      isPersonRequiredSleepEpisode({
        sleepEpisodeStartedAt: episode,
        sleepRequiredEpisodeStartedAt: episode,
      })
    ).toBe(true);
  });

  it.each([
    ['the episode ended', { sleepEpisodeStartedAt: null, sleepRequiredEpisodeStartedAt: episode }],
    [
      'a new episode started',
      { sleepEpisodeStartedAt: '2026-11-03T11:30:00.000Z', sleepRequiredEpisodeStartedAt: episode },
    ],
    ['no person asked', { sleepEpisodeStartedAt: episode, sleepRequiredEpisodeStartedAt: null }],
    ['there is no row', null],
  ])('is not required when %s', (_label, row) => {
    expect(isPersonRequiredSleepEpisode(row)).toBe(false);
  });
});
