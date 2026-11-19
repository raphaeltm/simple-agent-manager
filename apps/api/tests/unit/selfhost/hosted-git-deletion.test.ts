import { beforeEach, expect, it, vi } from 'vitest';

import { HostedGitRepo } from '../../../src/selfhost/hosted-git/hosted-git-repo';
import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
const state = vi.hoisted(() => ({
  meta: new Map<string, string>(),
  events: [] as string[],
  validate: vi.fn(),
  setAlarm: vi.fn(async () => undefined),
  cancel: vi.fn(),
  deleteAlarm: vi.fn(async () => undefined),
}));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: unknown) {}
  },
}));
vi.mock('../../../src/selfhost/hosted-git/policy', () => ({
  resolveHostedGitLimits: async () => DEFAULT_HOSTED_GIT_LIMITS,
}));
vi.mock('../../../src/vendor/dgit/git/store', () => ({
  GitStore: class {
    getMeta(key: string) {
      return state.meta.get(key);
    }
    setMeta(key: string, value: string) {
      state.meta.set(key, value);
    }
    refs() {
      return [];
    }
    dbSize() {
      return 0;
    }
    objectCount() {
      return 0;
    }
    wipe() {
      state.events.push('wipe');
      state.meta.clear();
    }
    packs = { ingest: async () => ({ packId: 1 }) };
  },
}));
vi.mock('../../../src/vendor/dgit/git/protocol', () => ({
  advertisement: () => new Uint8Array(),
  parsePushCommands: () => ({ commands: [], caps: [] }),
  sidebandFrames: () => [],
  renderStatus: () => new Uint8Array(),
  validatePush: (...args: unknown[]) => state.validate(...args),
  commitPush: () => {
    state.events.push('commit');
    return { results: [], changed: false, needsGc: false };
  },
  uploadPack: async (_store: unknown, _body: unknown, release: () => void) =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          state.cancel();
          release();
        },
      })
    ),
}));
function repo() {
  return new HostedGitRepo(
    {
      storage: {
        sql: {},
        deleteAlarm: state.deleteAlarm,
        setAlarm: state.setAlarm,
        transactionSync: (fn: () => unknown) => fn(),
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    } as unknown as DurableObjectState,
    {}
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.meta.clear();
  state.events = [];
  state.validate.mockResolvedValue({});
});
it('DELETE waits for an accepted push, then fences new writes and persists deletion', async () => {
  let resume = () => {};
  state.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = () => resolve({});
      })
  );
  const cell = repo();
  const push = cell.fetch(
    new Request('https://git/git-receive-pack', { method: 'POST', body: '0000' })
  );
  await vi.waitFor(() => expect(state.validate).toHaveBeenCalledOnce());
  const deletion = cell.fetch(new Request('https://git/', { method: 'DELETE' }));
  await vi.waitFor(async () =>
    expect(
      (await cell.fetch(new Request('https://git/init', { method: 'PUT', body: '{}' }))).status
    ).toBe(410)
  );
  expect(state.events).toEqual([]);
  resume();
  expect((await push).status).toBe(200);
  expect((await deletion).status).toBe(200);
  expect(state.events).toEqual(['commit', 'wipe']);
  expect(
    (await repo().fetch(new Request('https://git/init', { method: 'PUT', body: '{}' }))).status
  ).toBe(410);
});
it('DELETE cancels an active clone stream before wiping its packs', async () => {
  const cell = repo();
  const upload = await cell.fetch(
    new Request('https://git/git-upload-pack', { method: 'POST', body: '0000' })
  );
  expect((await cell.fetch(new Request('https://git/', { method: 'DELETE' }))).status).toBe(200);
  expect(state.cancel).toHaveBeenCalledOnce();
  expect(state.events).toEqual(['wipe']);
  await upload.body?.cancel();
});
it('schedules collection for an ingested pack even when all ref updates are rejected', async () => {
  const cell = repo();
  expect(
    (
      await cell.fetch(
        new Request('https://git/git-receive-pack', {
          method: 'POST',
          body: new Uint8Array([48, 48, 48, 48, 80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 0]),
        })
      )
    ).status
  ).toBe(200);
  expect(state.setAlarm).toHaveBeenCalledOnce();
  expect(state.meta.get('gc-pending')).toBe('1');
});

it('retries failed cleanup while keeping all writes fenced', async () => {
  state.deleteAlarm.mockRejectedValueOnce(new Error('temporary storage failure'));
  const cell = repo();
  expect((await cell.fetch(new Request('https://git/', { method: 'DELETE' }))).status).toBe(500);
  expect(
    (await cell.fetch(new Request('https://git/init', { method: 'PUT', body: '{}' }))).status
  ).toBe(410);
  expect((await cell.fetch(new Request('https://git/', { method: 'DELETE' }))).status).toBe(200);
  expect(state.deleteAlarm).toHaveBeenCalledTimes(2);
  expect(state.meta.get('deleted')).toBe('1');
});

it('reclaims failed-ingest rows even when scheduling the cleanup alarm fails', async () => {
  const cell = repo();
  const events: string[] = [];
  const packs = (cell as unknown as { store: { packs: { ingest: () => Promise<never>; cleanupOrphans: () => Promise<void> } } }).store.packs;
  packs.ingest = async () => { events.push('ingest'); throw new Error('pack checksum mismatch'); };
  packs.cleanupOrphans = async () => { events.push('cleanup'); };
  state.setAlarm.mockImplementationOnce(async () => { events.push('alarm'); throw new Error('alarm storage unavailable'); });
  const response = await cell.fetch(new Request('https://git/git-receive-pack', { method: 'POST', body: new Uint8Array([48, 48, 48, 48, 80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 0]) }));
  expect(response.status).toBe(500);
  expect(events).toEqual(['ingest', 'cleanup', 'alarm']);
  expect(state.meta.get('gc-pending')).toBe('1');
});
