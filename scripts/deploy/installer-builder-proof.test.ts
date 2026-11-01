import { describe, expect, it, vi } from 'vitest';
import {
  PROOF_COMPUTE_UPPER_USD,
  proofWorkerSource,
  ownsProofWorker,
  runProofWithCleanup,
} from './installer-builder-proof';

describe('bounded cold build proof', () => {
  it('keeps deployment credentials outside the container and never starts twice', async () => {
    const state = new Map<string, any>();
    const storage = {
      get: vi.fn(async (k: string) => state.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        state.set(k, structuredClone(v));
      }),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    };
    const container = {
      start: vi.fn(),
      destroy: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({})),
      getTcpPort: vi.fn(() => ({ fetch: async () => Response.json({ state: 'running' }) })),
    };
    const source = proofWorkerSource();
    const Constructor = new Function(
      source
        .replace('export class BuildProof', 'class BuildProof')
        .replace(/export default[\s\S]*$/, 'return BuildProof;')
    )();
    const env = {
      PROOF_KEY: 'private-proof-control',
      SOURCE_COMMIT: 'a'.repeat(40),
      CF_API_TOKEN: 'must-not-enter-container',
    };
    const proof = new Constructor({ storage, container }, env);
    const request = () =>
      new Request('https://proof/start', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.PROOF_KEY },
      });
    expect((await proof.fetch(new Request('https://proof/start', { method: 'POST' }))).status).toBe(
      403
    );
    expect((await proof.fetch(request())).status).toBe(202);
    expect((await proof.fetch(request())).status).toBe(409);
    expect(container.start).toHaveBeenCalledTimes(1);
    const options = container.start.mock.calls[0][0];
    expect(options.instance).toBe('standard-3');
    expect(options.env).not.toHaveProperty('CF_API_TOKEN');
    expect(options.env.SAM_BUILD_FIT_ONLY).toBe('1');
    const record = state.get('job');
    record.deadline = Date.now() - 1;
    state.set('job', record);
    await proof.alarm();
    expect(container.destroy).toHaveBeenCalledWith('SAM proof timed_out');
    expect(state.get('job').status).toBe('timed_out');
    expect(PROOF_COMPUTE_UPPER_USD).toBeCloseTo(0.220032);
  });
});

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
it('requires a manual canonical staging invocation of the exact approved branch SHA', () => {
  const workflow = parse(
    readFileSync(
      new URL('../../.github/workflows/installer-build-proof.yml', import.meta.url),
      'utf8'
    )
  );
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  const job = workflow.jobs['cold-build'];
  expect(job.environment).toBe('staging');
  expect(job.if).toContain("github.repository == 'raphaeltm/simple-agent-manager'");
  expect(job.if).toContain('github.sha == inputs.source_commit');
  expect(job.if).toContain("inputs.approval == 'one-cold-build-60-minutes'");
  expect(job.if).toContain("github.ref != 'refs/heads/main'");
  const proof = job.steps.find((step: { run?: string }) =>
    step.run?.includes('installer-builder-proof.ts')
  );
  expect(proof.env.SAM_INSTALLER_PAID_PROOF).toBe('one-cold-build-60-minutes');
  expect(proof.env).not.toHaveProperty('CF_RUNTIME_API_TOKEN');
  expect(job.steps[0].with['fetch-depth']).toBe(0);
});

it('cleanup requires this proof ownership marker and exact source', () => {
  const commit = 'a'.repeat(40),
    ownership = 'b'.repeat(64);
  const settings = {
    bindings: [
      { name: 'PROOF_OWNERSHIP', text: ownership },
      { name: 'SOURCE_COMMIT', text: commit },
    ],
  };
  expect(ownsProofWorker(settings, ownership, commit)).toBe(true);
  expect(ownsProofWorker(settings, 'c'.repeat(64), commit)).toBe(false);
  expect(ownsProofWorker(settings, ownership, 'd'.repeat(40))).toBe(false);
  expect(ownsProofWorker({ bindings: [] }, ownership, commit)).toBe(false);
});

describe('proof failure cleanup', () => {
  it('preserves the original failure while still attempting cleanup', async () => {
    const original = new Error('original');
    const cleanup = vi.fn(async () => new Error('cleanup'));
    await expect(
      runProofWithCleanup(async () => {
        throw original;
      }, cleanup)
    ).rejects.toBe(original);
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('fails a successful proof when cleanup remains incomplete', async () => {
    const cleanup = new Error('cleanup');
    await expect(
      runProofWithCleanup(
        async () => {},
        async () => cleanup
      )
    ).rejects.toBe(cleanup);
  });
  it('preserves original failure when cleanup unexpectedly throws', async () => {
    const original = new Error('original');
    await expect(
      runProofWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          throw new Error('cleanup');
        }
      )
    ).rejects.toBe(original);
  });
});
