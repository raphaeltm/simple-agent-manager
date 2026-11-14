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

const before = [
  {
    name: 'api-agent-staging',
    applicationId: 'app',
    version: 4,
    rollouts: [{ id: 'old', target_version: 4 }],
  },
];
function rollout(status = 'completed', id = 'new', target_version = 5): Rollout {
  return { id, status, target_version, steps: [{ status, step_size: { percentage: 100 } }] };
}
function harness(initial = rollout()) {
  let time = 0;
  let current = initial;
  let activeVersion = initial.status === 'completed' ? initial.target_version : 4;
  const api: RolloutApi = {
    applications: vi.fn(async () => [{ id: 'app', name: before[0].name, version: activeVersion }]),
    rollouts: vi.fn(async () =>
      current.id === 'old' ? [current] : [current, rollout('completed', 'old', 4)]
    ),
  };
  const options = {
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
    log: vi.fn(),
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
  it('waits for every application while preserving independent rollout identities', async () => {
    const h = harness();
    let secondComplete = false;
    vi.mocked(h.api.applications).mockImplementation(async () => [
      { id: 'app', name: before[0].name, version: 5 },
      { id: 'second', name: 'second-app', version: secondComplete ? 5 : 4 },
    ]);
    vi.mocked(h.api.rollouts).mockImplementation(async (id) => [
      rollout(id === 'app' || secondComplete ? 'completed' : 'progressing', `${id}-new`),
    ]);
    h.options.sleep.mockImplementationOnce(async () => {
      secondComplete = true;
    });
    await waitForContainerRollouts(
      h.api,
      [before[0], { ...before[0], name: 'second-app', applicationId: 'second' }],
      h.options
    );
    expect(h.options.sleep).toHaveBeenCalledTimes(1);
    expect(h.options.log).toHaveBeenLastCalledWith(
      expect.stringContaining('application=second rollout=second-new status=completed')
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
  it('accepts metadata-only modification without requiring a new rollout', async () => {
    const h = harness(rollout('completed', 'old', 4));
    h.set(rollout('completed', 'old', 4), 5);
    await waitForContainerRollouts(h.api, before, h.options);
    expect(h.options.sleep).not.toHaveBeenCalled();
  });
  it('rejects a superseding rollout already present on the first post-deploy read', async () => {
    const h = harness();
    vi.mocked(h.api.rollouts).mockResolvedValue([rollout(), rollout('progressing', 'other', 6)]);
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      /new:5,other:6.*Ambiguous\/superseding/
    );
  });
  it('awaits an existing pending rollout even for an unchanged deployment', async () => {
    const h = harness(rollout('progressing'));
    const pendingBefore = [
      { ...before[0], rollouts: [{ id: 'new', target_version: 5 }, ...before[0].rollouts] },
    ];
    h.options.sleep.mockImplementationOnce(async () => {
      h.set(rollout());
    });
    await waitForContainerRollouts(h.api, pendingBefore, h.options);
    expect(h.options.sleep).toHaveBeenCalledTimes(1);
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
    await waitForContainerRollouts(h.api, before, h.options);
    expect(h.options.sleep).not.toHaveBeenCalled();
  });
  it('rejects a new rollout whose target is already behind the active version', async () => {
    const h = harness();
    await expect(
      waitForContainerRollouts(h.api, [{ ...before[0], version: 6 }], h.options)
    ).rejects.toThrow('regressed');
    h.set(rollout('completed', 'new', 4));
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      'did not advance'
    );
  });
  it('fails when previously observed rollout history disappears', async () => {
    const h = harness();
    vi.mocked(h.api.rollouts).mockResolvedValue([]);
    await expect(waitForContainerRollouts(h.api, before, h.options)).rejects.toThrow(
      'history disappeared'
    );
  });
  it('accepts first direct creation without inventing rollout', async () => {
    const h = harness();
    vi.mocked(h.api.rollouts).mockResolvedValue([]);
    await expect(
      waitForContainerRollouts(
        h.api,
        [{ ...before[0], applicationId: null, version: null, rollouts: [] }],
        h.options
      )
    ).resolves.toBeUndefined();
  });
  it('records absent apps for first install', async () => {
    const h = harness();
    vi.mocked(h.api.applications).mockResolvedValue([]);
    expect(await snapshotApplications(h.api, [before[0].name])).toEqual([
      { name: before[0].name, applicationId: null, version: null, rollouts: [] },
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
  it('snapshots and waits through the HTTP boundary without Wrangler stdout on either engine path', async () => {
    let activeVersion = 4;
    let records = [rollout('completed', 'old', 4)];
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify({
            success: true,
            result: String(url).endsWith('/rollouts')
              ? records
              : [{ id: 'app', name: before[0].name, version: activeVersion }],
          })
        )
    );
    const api = createRolloutApi(
      'account',
      'secret',
      new AbortController().signal,
      fetcher as typeof fetch
    );
    const saved = parseSnapshot(
      JSON.parse(JSON.stringify(await snapshotApplications(api, [before[0].name])))
    );
    records = [rollout('progressing'), ...records];
    const h = harness();
    h.options.sleep.mockImplementationOnce(async () => {
      records = [rollout(), rollout('completed', 'old', 4)];
      activeVersion = 5;
    });
    await waitForContainerRollouts(api, saved, h.options);
    expect(h.options.sleep).toHaveBeenCalledTimes(1);
    expect(h.options.log.mock.calls[0][0]).toContain('version=4 target=5');
    expect(h.options.log.mock.calls[1][0]).toContain('version=5 target=5');
  });

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
