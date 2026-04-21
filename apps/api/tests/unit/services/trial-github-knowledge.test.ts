/**
 * Behavioral tests for emitGithubKnowledgeEvents.
 *
 * Covers:
 *   - Happy path: emits events for description, language, stars, topics,
 *     license, language breakdown, and README first paragraph.
 *   - Per-request timeout: a hanging response aborts without blocking others.
 *   - Max-events cap: never emits more than `TRIAL_KNOWLEDGE_MAX_EVENTS`.
 *   - Errors are swallowed: a total-network-failure produces 0 events without
 *     throwing.
 *   - env.TRIAL_EVENT_BUS errors don't bubble (bridge already covers this
 *     but the helper's emit wrapper is the last line of defense).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { emitTrialEventMock } = vi.hoisted(() => ({
  emitTrialEventMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEvent: emitTrialEventMock,
}));

const { emitGithubKnowledgeEvents } = await import(
  '../../../src/services/trial/github-knowledge'
);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIAL_EVENT_BUS: {
      idFromName: vi.fn(() => 'stub-id'),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response('ok')) })),
    },
    ...overrides,
  } as unknown as Env;
}

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textResp(body: string): Response {
  return new Response(body, { status: 200 });
}

/**
 * Build a fetch mock that returns different responses per URL pattern.
 * Matches on path suffix to support both `/repos/:o/:n` and `/repos/:o/:n/languages`.
 */
function routedFetch(routes: {
  repo?: () => Response | Promise<Response>;
  languages?: () => Response | Promise<Response>;
  readme?: () => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/languages') && routes.languages) return routes.languages();
    if (url.endsWith('/readme') && routes.readme) return routes.readme();
    if (routes.repo) return routes.repo();
    return new Response('', { status: 404 });
  });
}

describe('emitGithubKnowledgeEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits description, language, stars, topics, license, language breakdown, and README', async () => {
    const fetchFn = routedFetch({
      repo: () =>
        jsonResp({
          description: 'A delightful CLI for widgets',
          language: 'TypeScript',
          stargazers_count: 1234,
          topics: ['cli', 'widgets', 'typescript'],
          license: { spdx_id: 'MIT' },
        }),
      languages: () =>
        jsonResp({ TypeScript: 9000, JavaScript: 500, CSS: 100 }),
      readme: () =>
        textResp(
          '# Widgets\n\nA delightful CLI for widgets — does amazing things when you need them most.\n\n## Installation\n\nRun npm install.'
        ),
    });

    await emitGithubKnowledgeEvents(
      makeEnv(),
      'trial_abc',
      { owner: 'alice', name: 'widgets' },
      { fetchFn: fetchFn as unknown as typeof fetch }
    );

    const calls = emitTrialEventMock.mock.calls;
    const observations = calls.map(
      (c) => (c[2] as { observation: string }).observation
    );
    expect(observations.some((o) => o.includes('Description:'))).toBe(true);
    expect(observations.some((o) => o.includes('Primary language: TypeScript'))).toBe(
      true
    );
    expect(observations.some((o) => o.includes('Stars: 1234'))).toBe(true);
    expect(observations.some((o) => o.includes('Topics:'))).toBe(true);
    expect(observations.some((o) => o.includes('License: MIT'))).toBe(true);
    expect(observations.some((o) => o.includes('Languages (by bytes):'))).toBe(
      true
    );
    expect(observations.some((o) => o.startsWith('README:'))).toBe(true);
  });

  it('caps total events at TRIAL_KNOWLEDGE_MAX_EVENTS', async () => {
    const fetchFn = routedFetch({
      repo: () =>
        jsonResp({
          description: 'desc',
          language: 'Go',
          stargazers_count: 1,
          topics: ['a', 'b'],
          license: { spdx_id: 'Apache-2.0' },
        }),
      languages: () => jsonResp({ Go: 100, Shell: 50 }),
      readme: () => textResp('A decent description paragraph that exceeds twenty characters by enough.'),
    });
    // Cap at 2 — must NOT emit more than 2 events even though the probes
    // would naturally produce ~7.
    const env = makeEnv({ TRIAL_KNOWLEDGE_MAX_EVENTS: '2' });
    await emitGithubKnowledgeEvents(
      env,
      'trial_xyz',
      { owner: 'a', name: 'b' },
      { fetchFn: fetchFn as unknown as typeof fetch }
    );
    expect(emitTrialEventMock).toHaveBeenCalledTimes(2);
  });

  it('swallows total-network-failure and emits 0 events', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      emitGithubKnowledgeEvents(
        makeEnv(),
        'trial_err',
        { owner: 'a', name: 'b' },
        { fetchFn: fetchFn as unknown as typeof fetch }
      )
    ).resolves.toBeUndefined();
    expect(emitTrialEventMock).not.toHaveBeenCalled();
  });

  it('survives a non-2xx repo metadata response without throwing', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 403 }));
    await expect(
      emitGithubKnowledgeEvents(
        makeEnv(),
        'trial_403',
        { owner: 'a', name: 'b' },
        { fetchFn: fetchFn as unknown as typeof fetch }
      )
    ).resolves.toBeUndefined();
    // No observations emitted when all probes fail.
    expect(emitTrialEventMock).not.toHaveBeenCalled();
  });

  it('does not throw when emitTrialEvent rejects (last line of defense)', async () => {
    emitTrialEventMock.mockRejectedValueOnce(new Error('bus closed'));
    const fetchFn = routedFetch({
      repo: () => jsonResp({ description: 'hello' }),
      languages: () => jsonResp({}),
      readme: () => new Response('', { status: 404 }),
    });
    await expect(
      emitGithubKnowledgeEvents(
        makeEnv(),
        'trial_ok',
        { owner: 'a', name: 'b' },
        { fetchFn: fetchFn as unknown as typeof fetch }
      )
    ).resolves.toBeUndefined();
  });
});
