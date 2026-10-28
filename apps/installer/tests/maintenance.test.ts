import { afterEach, describe, expect, it, vi } from 'vitest';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';

// Execute the precise dependency-free module uploaded to the owner's account.
const Coordinator = new Function(
  maintenanceSource
    .replace('export class MaintenanceCoordinator', 'class MaintenanceCoordinator')
    .replace('export default', 'const worker =') + '\nreturn MaintenanceCoordinator;'
)() as new (
  state: unknown,
  env: Record<string, string>
) => { fetch(request: Request): Promise<Response> };
const origin = 'https://install.example.com';
const target = 'https://sam-maintenance.example.workers.dev';
function storageState() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return structuredClone(values.get(key));
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async transaction<T>(work: (store: typeof storage) => Promise<T>): Promise<T> {
      return work(storage);
    },
  };
  return { storage, values };
}
async function fixture() {
  const state = storageState();
  const env = {
    INSTALLER_ORIGIN: origin,
    OWNER_KEY_HASH: await digest('owner-secret'),
    CLAIM_EXPIRES: String(Date.now() + 60000),
    OWNER_SESSION_TTL_SECONDS: '3600',
  };
  const coordinator = new Coordinator(state, env);
  const post = (path: string, form: Record<string, string>, cookie?: string, from = target) =>
    coordinator.fetch(
      new Request(target + path, {
        method: 'POST',
        headers: { Origin: from, ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams(form),
      })
    );
  const claim = () => post('/claim', { key: 'owner-secret' }, undefined, origin);
  return { state, env, coordinator, post, claim };
}
function session(response: Response) {
  return response.headers.get('Set-Cookie')!.split(';')[0]!;
}
function recovery(html: string) {
  return /<code>([a-f0-9]{64})<\/code>/.exec(html)![1]!;
}
afterEach(() => vi.useRealTimers());
describe('uploaded durable maintenance module', () => {
  it('consumes one claim, gives an independent session and only stores hashes across restarts', async () => {
    const f = await fixture();
    expect((await f.coordinator.fetch(new Request(target))).status).toBe(401);
    expect(
      (await f.post('/claim', { key: 'owner-secret' }, undefined, 'https://attacker.example'))
        .status
    ).toBe(403);
    const responses = await Promise.all([f.claim(), f.claim()]);
    expect(responses.map((r) => r.status)).toEqual([200, 409]);
    const first = responses[0]!;
    expect(first.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    const credential = recovery(await first.text()),
      cookie = session(first);
    expect(cookie).not.toContain('owner-secret');
    expect(cookie).not.toContain(credential);
    const stored = JSON.stringify([...f.state.values]);
    expect(stored).not.toContain(credential);
    expect(stored).not.toContain(cookie.split('=')[1]);
    f.env.CLAIM_EXPIRES = String(Date.now() - 1);
    const restarted = new Coordinator(f.state, f.env);
    const owned = await restarted.fetch(new Request(target, { headers: { Cookie: cookie } }));
    expect(owned.status).toBe(200);
    expect(await owned.text()).not.toContain(credential);
    expect((await f.claim()).status).toBe(409);
  });
  it('recovers after session/bootstrap expiry, rotates credentials and invalidates old sessions', async () => {
    const f = await fixture(),
      claimed = await f.claim();
    const oldCookie = session(claimed),
      oldRecovery = recovery(await claimed.text());
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601000);
    expect(
      (await f.coordinator.fetch(new Request(target, { headers: { Cookie: oldCookie } }))).status
    ).toBe(401);
    expect(
      (await f.post('/recover', { recovery: oldRecovery }, undefined, 'https://attacker.example'))
        .status
    ).toBe(403);
    const recovered = await f.post('/recover', { recovery: oldRecovery });
    expect(recovered.status).toBe(200);
    const currentCookie = session(recovered);
    expect((await f.post('/rotate', {}, currentCookie, 'https://attacker.example')).status).toBe(
      403
    );
    const preview = await f.post('/rotate', {}, currentCookie);
    const previewHtml = await preview.text();
    const newRecovery = recovery(previewHtml);
    const rotation = /name="rotation" value="([a-f0-9]{64})"/.exec(previewHtml)![1]!;
    const beforeConfirm = await f.post('/recover', { recovery: oldRecovery });
    expect(beforeConfirm.status).toBe(200);
    const rotated = await f.post(
      '/confirm-rotate',
      { rotation, saved: 'yes' },
      session(beforeConfirm)
    );
    const newCookie = session(rotated);
    expect(newRecovery).not.toBe(oldRecovery);
    expect((await f.post('/recover', { recovery: oldRecovery })).status).toBe(401);
    expect(
      (await f.coordinator.fetch(new Request(target, { headers: { Cookie: currentCookie } })))
        .status
    ).toBe(401);
    expect((await f.post('/logout', {}, newCookie)).headers.get('Set-Cookie')).toContain(
      'Max-Age=0'
    );
    expect(
      (await f.coordinator.fetch(new Request(target, { headers: { Cookie: newCookie } }))).status
    ).toBe(401);
    expect((await f.post('/recover', { recovery: newRecovery })).status).toBe(200);
  });
  it('enforces claim expiry, persistent recovery throttling and bounded bodies', async () => {
    const f = await fixture();
    f.env.CLAIM_EXPIRES = String(Date.now() - 1);
    expect((await f.claim()).status).toBe(403);
    f.env.CLAIM_EXPIRES = String(Date.now() + 60000);
    await f.claim();
    for (let i = 0; i < 10; i++)
      expect((await f.post('/recover', { recovery: 'wrong' })).status).toBe(401);
    const restarted = new Coordinator(f.state, f.env);
    expect(
      (
        await restarted.fetch(
          new Request(target + '/recover', {
            method: 'POST',
            headers: { Origin: target },
            body: new URLSearchParams({ recovery: 'wrong' }),
          })
        )
      ).status
    ).toBe(429);
    expect((await f.post('/recover', { recovery: 'x'.repeat(5000) })).status).toBe(413);
    expect((await f.coordinator.fetch(new Request(target + '/rotate'))).status).toBe(405);
  });
});

it('retains owner recovery when the successful claim response is lost', async () => {
  const f = await fixture();
  Object.assign(f.env, { CLIENT_RECOVERY_REQUIRED: 'true' });
  expect((await f.claim()).status).toBe(400);
  const knownRecovery = 'a'.repeat(64);
  expect(
    (await f.post('/claim', { key: 'owner-secret', recovery: 'short' }, undefined, origin)).status
  ).toBe(400);
  // The browser already saved this value; deliberately discard the response/cookie.
  await f.post('/claim', { key: 'owner-secret', recovery: knownRecovery }, undefined, origin);
  const restarted = new Coordinator(f.state, f.env);
  const recovered = await restarted.fetch(
    new Request(target + '/recover', {
      method: 'POST',
      headers: { Origin: target },
      body: new URLSearchParams({ recovery: knownRecovery }),
    })
  );
  expect(recovered.status).toBe(200);
  expect(recovered.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(JSON.stringify([...f.state.values])).not.toContain(knownRecovery);
  expect(
    (await f.post('/claim', { key: 'owner-secret', recovery: 'b'.repeat(64) }, undefined, origin))
      .status
  ).toBe(409);
});

it('keeps saved recovery usable after dropped rotation responses and rejects stale confirmation', async () => {
  const f = await fixture(),
    claimed = await f.claim();
  const initialCookie = session(claimed),
    initialRecovery = recovery(await claimed.text());
  // Dropped preparation response does not change the active recovery credential.
  await f.post('/rotate', {}, initialCookie);
  const stillOwned = await f.post('/recover', { recovery: initialRecovery });
  expect(stillOwned.status).toBe(200);
  const cookie = session(stillOwned);
  const preview = await f.post('/rotate', {}, cookie),
    html = await preview.text();
  const nextRecovery = recovery(html),
    rotation = /name="rotation" value="([a-f0-9]{64})"/.exec(html)![1]!;
  expect(JSON.stringify([...f.state.values])).not.toContain(nextRecovery);
  expect((await f.post('/confirm-rotate', { rotation }, cookie)).status).toBe(409);
  expect(
    (
      await f.post(
        '/confirm-rotate',
        { rotation, saved: 'yes' },
        cookie,
        'https://attacker.example'
      )
    ).status
  ).toBe(403);
  // The owner saved nextRecovery before this request; discard the successful response.
  await f.post('/confirm-rotate', { rotation, saved: 'yes' }, cookie);
  const recovered = await f.post('/recover', { recovery: nextRecovery });
  expect(recovered.status).toBe(200);
  expect(
    (await f.post('/confirm-rotate', { rotation, saved: 'yes' }, session(recovered))).status
  ).toBe(409);
  expect((await f.post('/recover', { recovery: initialRecovery })).status).toBe(401);
});

it('expires rotation approval without invalidating the existing credential or confirming another tab', async () => {
  const f = await fixture(),
    claimed = await f.claim();
  const cookie = session(claimed),
    initialRecovery = recovery(await claimed.text());
  const first = await f.post('/rotate', {}, cookie),
    firstHtml = await first.text();
  const oldRotation = /name="rotation" value="([a-f0-9]{64})"/.exec(firstHtml)![1]!;
  const second = await f.post('/rotate', {}, cookie),
    html = await second.text();
  const rotation = /name="rotation" value="([a-f0-9]{64})"/.exec(html)![1]!;
  expect(
    (await f.post('/confirm-rotate', { rotation: oldRotation, saved: 'yes' }, cookie)).status
  ).toBe(409);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 900001);
  expect((await f.post('/confirm-rotate', { rotation, saved: 'yes' }, cookie)).status).toBe(409);
  expect((await f.post('/recover', { recovery: initialRecovery })).status).toBe(200);
});
