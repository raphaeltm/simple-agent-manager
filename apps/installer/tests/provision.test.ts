import { afterEach, describe, expect, it, vi } from 'vitest';

import { provision } from '../src/provision';
import { digest } from '../src/security';
const account = 'a'.repeat(32),
  name = 'sam-maintenance-unit',
  key = 'claim-private',
  origin = 'https://install.example.com';
const config = {
  accountId: account,
  zoneId: 'b'.repeat(32),
  zoneName: 'example.com',
  baseDomain: 'sam.example.com',
  ownerEmail: 'owner@example.com',
  sourceCommit: 'c'.repeat(40),
};
const credentials = {
  deploymentToken: 'deploy-private',
  runtimeToken: 'runtime-private',
  r2AccessKeyId: 'd'.repeat(32),
  r2SecretAccessKey: 'storage-private',
  pulumiPassphrase: 'state-private',
  tokenIds: [],
};
afterEach(() => vi.unstubAllGlobals());
function fake(existing?: unknown) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/settings'))
      return Response.json(
        { success: !!existing, result: existing },
        { status: existing ? 200 : 404 }
      );
    const result = url.endsWith('/workers/subdomain')
      ? { subdomain: 'account-existing' }
      : url.endsWith('/r2/buckets')
        ? { buckets: [{ name: `${name}-builds` }] }
        : url.endsWith('/containers/applications')
          ? []
          : {};
    return Response.json({ success: true, result });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('owner-account service provisioning', () => {
  it('uploads independent durable owner/builder bindings and distinct credentials, then registers native managed scheduling', async () => {
    const fetch = fake();
    expect(
      await provision('bootstrap-private', account, name, key, origin, Date.now() + 60000, {
        config,
        credentials,
      })
    ).toBe(`https://${name}.account-existing.workers.dev`);
    const upload = fetch.mock.calls.find(
      ([url, init]) => url.endsWith(`/scripts/${name}`) && init?.method === 'PUT'
    )?.[1]?.body as FormData;
    const metadata = JSON.parse(await (upload.get('metadata') as Blob).text());
    expect(metadata.migrations.new_sqlite_classes).toEqual([
      'MaintenanceCoordinator',
      'InstallationBuilder',
    ]);
    const value = (name: string) =>
      metadata.bindings.find((binding: { name: string }) => binding.name === name);
    expect(value('CLIENT_RECOVERY_REQUIRED').text).toBe('true');
    expect(value('CF_API_TOKEN')).toMatchObject({ type: 'secret_text', text: 'deploy-private' });
    expect(value('CF_RUNTIME_API_TOKEN').text).toBe('runtime-private');
    expect(JSON.stringify(metadata)).not.toContain('bootstrap-private');
    expect(await (upload.get('worker.js') as Blob).text()).toContain('class InstallationBuilder');
    const app = fetch.mock.calls.find(
      ([url, init]) => url.endsWith('/containers/applications') && init?.method === 'POST'
    );
    expect(JSON.parse(String(app?.[1]?.body))).toMatchObject({
      scheduling_policy: 'durable_object',
      durable_objects: { script_name: name, class_name: 'InstallationBuilder' },
    });
  });
  it('fails closed on a mismatched existing Worker without overwriting or enabling its address', async () => {
    const fetch = fake({ bindings: [] });
    await expect(
      provision('private', account, name, key, origin, Date.now() + 60000)
    ).rejects.toThrow('does not match');
    expect(
      fetch.mock.calls.some(([, init]) => init?.method === 'PUT' || init?.method === 'POST')
    ).toBe(false);
  });
  it('reuses the exact existing service without replacing its owner secrets', async () => {
    const fetch = fake({
      bindings: [
        { name: 'INSTALLATION_ID', text: name },
        { name: 'BOOTSTRAP_IDENTITY', text: await digest(key) },
        { name: 'INSTALLER_ORIGIN', text: origin },
      ],
    });
    await provision('private', account, name, key, origin, Date.now() + 60000);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });
});
