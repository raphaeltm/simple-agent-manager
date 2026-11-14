import { describe, expect, it, vi } from 'vitest';

import {
  createRolloutApi,
  parseSnapshot,
  readRolloutTiming,
  type Rollout,
  type RolloutApi,
  snapshotApplications,
  waitForContainerRollouts,
} from './container-rollout';
import { containerApplicationNames } from './wait-container-rollout';

const before = [{ name: 'api-agent-staging', applicationId: 'app', version: 4, rolloutId: 'old' }];
function rollout(status = 'completed', id = 'new', target_version = 5): Rollout {
  return { id, status, target_version, steps: [{ status, step_size: { percentage: 100 } }] };
}
function harness(initial = rollout()) {
  let time = 0;
  let current = initial;
  let activeVersion = initial.status === 'completed' ? initial.target_version : 4;
  const api: RolloutApi = {
    applications: vi.fn(async () => [{ id: 'app', name: before[0].name, version: activeVersion }]),
    rollouts: vi.fn(async () => [current, rollout('completed', 'old', 4)]),
  };
  const options = {
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
    log: vi.fn(),
    modifiedNames: new Set([before[0].name]),
  };
  return {
    api,
    options,
    set: (r: Rollout, version = r.target_version) => {
      current = r;
      activeVersion = version;
    },
  };
}
describe('container rollout deploy gate', () => {
  it('waits past old completed rollout until new target reaches100%', async () => {
    const h = harness(rollout('progressing'));
    h.options.sleep.mockImplementationOnce(async () => {
      h.set(rollout());
    });
    await waitForContainerRollouts(h.api, before, h.options);
    expect(h.options.sleep).toHaveBeenCalledTimes(1);
    expect(h.options.log).toHaveBeenLastCalledWith(
      expect.stringContaining('rollout=new status=completed version=5 target=5')
    );
  });
  it('waits for application version after rollout completion', async () => {
    const h = harness();
    h.set(rollout(), 4);
    h.options.sleep.mockImplementationOnce(async () => {
      h.set(rollout());
    });
    await waitForContainerRollouts(h.api, before, h.options);
    expect(h.options.sleep).toHaveBeenCalledTimes(1);
  });
  it('fails bounded timeout with pinned id/status', async () => {
    const h = harness(rollout('progressing'));
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      /timed out after 100ms.*rollout=new status=progressing/
    );
    expect(h.options.sleep).toHaveBeenCalledTimes(10);
  });
  it('rejects old completed rollout after a Wrangler modification', async () => {
    const h = harness(rollout('completed', 'old', 4));
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      'Modified application has no new rollout'
    );
  });
  it('rejects a superseding deployment', async () => {
    const h = harness(rollout('progressing'));
    h.options.sleep.mockImplementationOnce(async () => {
      h.set(rollout('completed', 'concurrent', 6));
    });
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow('superseded');
  });
  it.each(['failed', 'cancelled', 'unknown'])('fails status=%s', async (status) => {
    const h = harness(rollout(status));
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      /gate failed.*rollout=new status=/
    );
  });
  it('rejects completed34% rollout', async () => {
    const r = rollout();
    r.steps[0].step_size.percentage = 34;
    const h = harness(r);
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow('non-100%');
  });
  it('reports last target when API fails after initial progress', async () => {
    const h = harness(rollout('progressing'));
    h.options.sleep.mockImplementationOnce(async () => {
      vi.mocked(h.api.rollouts).mockRejectedValue(new Error('HTTP 403'));
    });
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      /rollout=new status=progressing.*HTTP 403/
    );
  });
  it('checks completed state when no container changes', async () => {
    const h = harness(rollout('completed', 'old', 4));
    h.options.modifiedNames.clear();
    await waitForContainerRollouts(h.api, before, h.options);
    expect(h.options.sleep).not.toHaveBeenCalled();
  });
  it('accepts first direct creation without inventing rollout', async () => {
    const h = harness();
    vi.mocked(h.api.rollouts).mockResolvedValue([]);
    h.options.modifiedNames.clear();
    await waitForContainerRollouts(
      h.api,
      [{ ...before[0], applicationId: null, version: null, rolloutId: null }],
      h.options
    );
  });
  it('records absent apps for first install', async () => {
    const h = harness();
    vi.mocked(h.api.applications).mockResolvedValue([]);
    expect(await snapshotApplications(h.api, [before[0].name])).toEqual([
      { name: before[0].name, applicationId: null, version: null, rolloutId: null },
    ]);
  });
  it('fails if an app disappears', async () => {
    const h = harness();
    vi.mocked(h.api.applications).mockResolvedValue([]);
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      'Missing/replaced'
    );
  });
});
describe('Cloudflare response boundary', () => {
  function api(body: unknown, status = 200) {
    return createRolloutApi(
      'account',
      'secret-token',
      new AbortController().signal,
      vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch
    );
  }
  it('strips sensitive configurations', async () => {
    expect(
      await api({
        success: true,
        result: [
          { id: 'app', name: 'name', version: 1, configuration: { env: { SECRET: 'do-not-log' } } },
        ],
      }).applications()
    ).toEqual([{ id: 'app', name: 'name', version: 1 }]);
  });
  it.each([403, 500])('fails HTTP%s without response body', async (status) => {
    await expect(api({ secret: 'do-not-log' }, status).applications()).rejects.toThrow(
      `HTTP ${status}`
    );
  });
  it.each([
    { success: false, result: [] },
    { success: true, result: {} },
    { success: true, result: [{ id: 'id', name: 'name' }] },
  ])('rejects malformed/API-failure response', async (body) => {
    await expect(api(body).applications()).rejects.toThrow('Unreadable');
  });
  it('rejects incomplete result pages', async () => {
    await expect(
      api({ success: true, result: [], result_info: { total_count: 2 } }).applications()
    ).rejects.toThrow('Incomplete');
  });
  it('rejects unreadable rollout steps', async () => {
    await expect(
      api({
        success: true,
        result: [{ id: 'r', status: 'completed', target_version: 2 }],
      }).rollouts('app')
    ).rejects.toThrow('Unreadable');
  });
  it('validates configurable timing and saved identity state', () => {
    expect(
      readRolloutTiming({
        CONTAINER_ROLLOUT_TIMEOUT_MS: '200',
        CONTAINER_ROLLOUT_POLL_INTERVAL_MS: '10',
      })
    ).toEqual({ timeoutMs: 200, pollIntervalMs: 10 });
    expect(() => readRolloutTiming({ CONTAINER_ROLLOUT_TIMEOUT_MS: 'Infinity' })).toThrow(
      'positive integer'
    );
    expect(parseSnapshot(before)).toEqual(before);
    expect(() => parseSnapshot([{ ...before[0], version: '4' }])).toThrow('Unreadable');
  });
  it('matches Wrangler naming including explicit names', () => {
    expect(
      containerApplicationNames(
        '[[containers]]\nclass_name="VmAgentContainer"\n[[containers]]\nname="explicit"',
        'fork-api-prod',
        'production'
      )
    ).toEqual(['fork-api-prod-vmagentcontainer-production', 'explicit']);
  });
});
