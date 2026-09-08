import { describe, expect, it, vi } from 'vitest';

import { resolvePullRequestEvidenceState } from './pr-evidence-source';

const STALE_BODY = 'stale body captured when the run was triggered';
const CURRENT_BODY = '<!-- AGENT_PREFLIGHT_START --> filled <!-- AGENT_PREFLIGHT_END -->';

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pull_request: {
      number: 2016,
      body: STALE_BODY,
      html_url: 'https://github.com/o/r/pull/2016',
      labels: [{ name: 'needs-human-review' }],
      ...overrides,
    },
  });
}

const ENV = {
  GITHUB_TOKEN: 'tok',
  GITHUB_REPOSITORY: 'o/r',
} as NodeJS.ProcessEnv;

function apiResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('resolvePullRequestEvidenceState', () => {
  it('prefers current API state over the stale event payload', async () => {
    // This is the incident: the body was fixed after the run was triggered, so the
    // frozen payload still holds the old one. `gh run rerun` replays that payload.
    const fetchImpl = vi.fn(async () =>
      apiResponse({
        body: CURRENT_BODY,
        html_url: 'https://github.com/o/r/pull/2016',
        labels: [],
      })
    );

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('api');
    expect(state.body).toBe(CURRENT_BODY);
    // The label was removed after the trigger fired; live state must reflect that.
    expect(state.labels).toEqual([]);
  });

  it('requests the correct PR with auth headers', async () => {
    const fetchImpl = vi.fn(async () => apiResponse({ body: CURRENT_BODY, labels: [] }));

    await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/2016');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('falls back to the event payload when the API errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Degrades to exactly the previous behaviour — never less available than before.
    expect(state.source).toBe('event-payload');
    expect(state.body).toBe(STALE_BODY);
    expect(state.labels).toEqual([{ name: 'needs-human-review' }]);
  });

  it('falls back on a non-ok API response', async () => {
    const fetchImpl = vi.fn(async () => apiResponse({ message: 'Not Found' }, false));

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('event-payload');
    expect(state.body).toBe(STALE_BODY);
  });

  it('falls back when the API returns a structurally invalid body', async () => {
    // Hash-correct-but-incoherent analogue: a 200 whose shape we cannot trust.
    const fetchImpl = vi.fn(async () => apiResponse({ body: 12345, labels: 'nope' }));

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('event-payload');
    expect(state.body).toBe(STALE_BODY);
  });

  it('falls back when credentials are absent, without calling fetch', async () => {
    const fetchImpl = vi.fn();

    const state = await resolvePullRequestEvidenceState({
      env: {} as NodeJS.ProcessEnv,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('event-payload');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back when the payload has no PR number, without calling fetch', async () => {
    const fetchImpl = vi.fn();

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => JSON.stringify({ pull_request: { body: STALE_BODY } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('event-payload');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a null API body as empty rather than crashing', async () => {
    const fetchImpl = vi.fn(async () => apiResponse({ body: null, labels: [] }));

    const state = await resolvePullRequestEvidenceState({
      env: ENV,
      readEventPayload: () => eventPayload(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state.source).toBe('api');
    expect(state.body).toBe('');
  });

  it('throws on a structurally invalid event payload', async () => {
    await expect(
      resolvePullRequestEvidenceState({
        env: ENV,
        readEventPayload: () => JSON.stringify({ not_a_pull_request: true }),
      })
    ).rejects.toThrow(/must include pull_request/);
  });
});
