import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveDeploySigningPublicKey } from '../deploy/deploy-signing-keys';
import {
  createInstallationKeys,
  inspectSecretListing,
  INSTALLATION_KEY_GROUPS,
  INSTALLATION_KEY_NAMES,
  InstallationKeysError,
  requireInstallationKeys,
  type WorkerAccess,
} from '../deploy/installation-keys';
import {
  presentKeyResources,
  previewExcludeArgs,
  RETIRED_KEY_RESOURCES,
  retireKeyResources,
} from '../deploy/retire-key-resources';

/** A Worker as Cloudflare holds it: secrets by name, a database that may have users. */
function cloudflare(init: { names?: string[]; users?: number; failWrite?: boolean } = {}) {
  const secrets = new Map((init.names ?? []).map((name) => [name, 'existing'] as const));
  const writes: string[] = [];
  const requests: string[] = [];
  const access: WorkerAccess & { databaseId: string } = {
    apiBase: 'https://cf.test',
    accountId: 'acct',
    token: 'token',
    worker: 'sam-api-prod',
    databaseId: 'db',
    async request(url, requestInit) {
      requests.push(`${requestInit?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/workers/scripts/sam-api-prod/secrets'))
        return Response.json({
          success: true,
          result: [...secrets.keys()].map((name) => ({ name, type: 'secret_text' })),
        });
      if (url.endsWith('/d1/database/db/query'))
        return Response.json({
          success: true,
          result: [{ results: Array.from({ length: init.users ?? 0 }, () => ({ present: 1 })) }],
        });
      if (url.endsWith('/workers/scripts/sam-api-prod/secrets-bulk')) {
        const body = String(requestInit?.body);
        writes.push(body);
        if (init.failWrite)
          return Response.json(
            { success: false, errors: [{ code: 10215, message: body }] },
            { status: 400 }
          );
        for (const [name, value] of Object.entries(
          (JSON.parse(body) as { secrets: Record<string, { text: string }> }).secrets
        ))
          secrets.set(name, value.text);
        return Response.json({ success: true, result: {} });
      }
      return Response.json({ success: false }, { status: 404 });
    },
  };
  return { access, secrets, writes, requests };
}

describe('installation keys', () => {
  it('generates every key in the shape the app and the VM agent read', () => {
    const keys = Object.assign({}, ...INSTALLATION_KEY_GROUPS.map((group) => group.generate()));
    expect(Object.keys(keys).sort()).toEqual([...INSTALLATION_KEY_NAMES].sort());
    expect(Buffer.from(keys.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    expect(Buffer.from(keys.PREVIEW_SIGNING_KEY, 'base64')).toHaveLength(32);
    // The JWT pair signs and verifies together.
    const signature = sign('sha256', Buffer.from('x'), createPrivateKey(keys.JWT_PRIVATE_KEY));
    expect(
      verify('sha256', Buffer.from('x'), createPublicKey(keys.JWT_PUBLIC_KEY), signature)
    ).toBe(true);
    expect(deriveDeploySigningPublicKey(keys.DEPLOY_SIGNING_PRIVATE_KEY)).toBe(
      keys.DEPLOY_SIGNING_PUBLIC_KEY
    );
    expect(Buffer.from(keys.VAPID_PUBLIC_KEY, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.VAPID_PRIVATE_KEY, 'base64url')).toHaveLength(32);
  });

  it.each([
    ['absent', [], 'absent'],
    ['complete', [...INSTALLATION_KEY_NAMES], 'complete'],
    [
      'missing one half of a pair',
      INSTALLATION_KEY_NAMES.filter((n) => n !== 'JWT_PUBLIC_KEY'),
      'incomplete',
    ],
  ])('reads a Worker whose keys are %s, by name only', (_label, names, state) => {
    expect(inspectSecretListing(names.map((name) => ({ name, type: 'secret_text' }))).state).toBe(
      state
    );
  });

  it('rejects a listing that is not one, rather than reading it as no keys', () => {
    expect(() => inspectSecretListing({ result: [] })).toThrow(InstallationKeysError);
  });

  it('creates every key in one write for a brand-new installation and returns nothing', async () => {
    const world = cloudflare();
    await expect(createInstallationKeys(world.access)).resolves.toBeUndefined();
    expect(world.writes).toHaveLength(1);
    expect([...world.secrets.keys()].sort()).toEqual([...INSTALLATION_KEY_NAMES].sort());
    await expect(requireInstallationKeys(world.access)).resolves.toBeUndefined();
  });

  it.each([
    ['already has every key', { names: [...INSTALLATION_KEY_NAMES] }, 'never replaced'],
    ['has some keys', { names: ['ENCRYPTION_KEY'] }, 'refusing to create keys'],
    ['has users in its database', { users: 1 }, 'already has users'],
  ])(
    'refuses to create keys when the installation %s, and writes nothing',
    async (_l, init, message) => {
      const world = cloudflare(init);
      await expect(createInstallationKeys(world.access)).rejects.toThrow(message);
      expect(world.writes).toEqual([]);
      expect(world.secrets.get('ENCRYPTION_KEY')).toBe(
        init.names?.includes('ENCRYPTION_KEY') ? 'existing' : undefined
      );
    }
  );

  it('a failed write reports only its status, never the request or response body', async () => {
    const world = cloudflare({ failWrite: true });
    const error = await createInstallationKeys(world.access).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallationKeysError);
    const written = JSON.parse(world.writes[0]) as { secrets: Record<string, { text: string }> };
    for (const { text } of Object.values(written.secrets))
      for (const line of text.split('\n').filter((part) => part.length > 16))
        expect(String((error as Error).message)).not.toContain(line);
    expect((error as Error).message).toBe('Cloudflare API workers returned 400');
  });

  it('names the missing keys, and never creates one, when a deploy requires them', async () => {
    const world = cloudflare({
      names: INSTALLATION_KEY_NAMES.filter((n) => n !== 'VAPID_PUBLIC_KEY'),
    });
    await expect(requireInstallationKeys(world.access)).rejects.toThrow(
      'missing installation keys: VAPID_PUBLIC_KEY'
    );
    expect(world.writes).toEqual([]);
  });
});

describe('retiring key resources from Pulumi state', () => {
  const stack = 'urn:pulumi:prod::sam-infra::pulumi:pulumi:Stack::sam-infra-prod';
  const urn = (type: string, name: string) => `urn:pulumi:prod::sam-infra::${type}::${name}`;
  const keys = RETIRED_KEY_RESOURCES.map(([type, name]) => urn(type, name));
  const identity = urn('random:index/randomId:RandomId', 'installation-id');
  const lookalike = urn('cloudflare:index/record:Record', 'encryption-key');

  it('matches the allowlist on type and name, never the identity or a same-named resource', () => {
    expect(presentKeyResources([stack, ...keys, identity, lookalike])).toEqual(keys);
  });

  it('excludes present key resources and the marker from previews; a fresh stack excludes nothing', () => {
    const args = previewExcludeArgs([stack, keys[0], identity]);
    expect(args).toEqual([
      '--exclude',
      keys[0],
      '--exclude',
      urn('random:index/randomId:RandomId', 'installation-keys-retired'),
    ]);
    expect(previewExcludeArgs([])).toEqual([]);
  });

  it('checks the Worker holds every key before touching state, then unprotects and deletes', async () => {
    const calls: string[] = [];
    const retired = await retireKeyResources({
      urns: [stack, ...keys, identity],
      requireKeys: async () => {
        calls.push('require');
      },
      pulumi: async (args) => {
        calls.push(args.join(' '));
      },
    });
    expect(retired).toEqual(keys);
    expect(calls[0]).toBe('require');
    expect(calls.slice(1)).toEqual(
      keys.flatMap((key) => [`state unprotect ${key} --yes`, `state delete ${key} --yes`])
    );
  });

  it('leaves state untouched when the Worker is missing a key', async () => {
    const calls: string[] = [];
    await expect(
      retireKeyResources({
        urns: [stack, ...keys],
        requireKeys: async () => {
          throw new InstallationKeysError('missing installation keys: ENCRYPTION_KEY');
        },
        pulumi: async (args) => {
          calls.push(args.join(' '));
        },
      })
    ).rejects.toThrow('missing installation keys');
    expect(calls).toEqual([]);
  });

  it('is a no-op on a stack already migrated, without even checking the Worker', async () => {
    let checked = false;
    const retired = await retireKeyResources({
      urns: [stack, identity],
      requireKeys: async () => {
        checked = true;
      },
      pulumi: async () => {
        throw new Error('no state command expected');
      },
    });
    expect(retired).toEqual([]);
    expect(checked).toBe(false);
  });
});
