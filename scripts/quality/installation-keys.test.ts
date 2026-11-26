import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { D1_LOCATIONS } from '../../apps/api/src/selfhost/key-rotation/d1-locations';
import { deriveDeploySigningPublicKey } from '../deploy/deploy-signing-keys';
import {
  createInstallationKeys,
  inspectSecretListing,
  INSTALLATION_DATA_EXISTS_SQL,
  INSTALLATION_KEY_GROUPS,
  INSTALLATION_KEY_NAMES,
  InstallationKeysError,
  parseSecretListing,
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
function cloudflare(
  init: {
    names?: string[];
    users?: number;
    credentials?: boolean;
    failWrite?: boolean;
    /** A table that keeps a row though every user is gone (a partly restored database). */
    orphanIn?: string;
  } = {}
) {
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
      if (url.endsWith('/d1/database/db/query')) {
        // The real statement against a real SQLite users table that, like every installation's,
        // holds migration 0043's system sentinel row.
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, status TEXT)');
        // Every table the key-rotation registry lists as holding ciphertext.
        for (const table of new Set(D1_LOCATIONS.map((location) => location.table)))
          db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
        if (init.credentials) db.exec("INSERT INTO platform_credentials VALUES ('pc1')");
        if (init.orphanIn) db.exec(`INSERT INTO ${init.orphanIn} VALUES ('orphan')`);
        db.exec(
          "INSERT INTO users VALUES ('system_anonymous_trials', 'system@sam.invalid', 'system')"
        );
        for (let i = 0; i < (init.users ?? 0); i++)
          db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(
            `u${i}`,
            `u${i}@example.test`,
            i % 2 ? 'pending' : 'active'
          );
        const { sql } = JSON.parse(String(requestInit?.body)) as { sql: string };
        return Response.json({ success: true, result: [{ results: db.prepare(sql).all() }] });
      }
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

  const fresh = { freshInstallation: true };

  it('creates every key in one write for a brand-new installation and returns only names', async () => {
    const world = cloudflare();
    const created = await createInstallationKeys(world.access, fresh);
    expect([...created].sort()).toEqual([...INSTALLATION_KEY_NAMES].sort());
    expect(world.writes).toHaveLength(1);
    expect([...world.secrets.keys()].sort()).toEqual([...INSTALLATION_KEY_NAMES].sort());
    await expect(requireInstallationKeys(world.access)).resolves.toBeUndefined();
  });

  it('a fresh database holding only the system sentinel row counts as empty', async () => {
    const world = cloudflare();
    await expect(createInstallationKeys(world.access, fresh)).resolves.toHaveLength(
      INSTALLATION_KEY_NAMES.length
    );
    expect(INSTALLATION_DATA_EXISTS_SQL).toContain("status IS NOT 'system'");
  });

  it('writes nothing for an installation that has every key', async () => {
    const world = cloudflare({ names: [...INSTALLATION_KEY_NAMES] });
    await expect(createInstallationKeys(world.access, fresh)).resolves.toEqual([]);
    expect(world.writes).toEqual([]);
  });

  it('fills a whole group an older installation never had, never touching the others', async () => {
    const names = INSTALLATION_KEY_NAMES.filter((name) => name !== 'PREVIEW_SIGNING_KEY');
    // Users and credentials exist: only ENCRYPTION_KEY depends on the database being empty.
    const world = cloudflare({ names, users: 2, credentials: true });
    await expect(createInstallationKeys(world.access)).resolves.toEqual(['PREVIEW_SIGNING_KEY']);
    expect(world.secrets.get('ENCRYPTION_KEY')).toBe('existing');
  });

  it.each([
    [
      'holds half of a key pair',
      { names: ['ENCRYPTION_KEY', 'JWT_PRIVATE_KEY'] },
      fresh,
      'part of a key pair',
    ],
    [
      'lacks only ENCRYPTION_KEY',
      { names: INSTALLATION_KEY_NAMES.filter((n) => n !== 'ENCRYPTION_KEY') },
      fresh,
      'never created for an existing installation',
    ],
    [
      'has no keys but is not a new installation',
      {},
      {},
      'never created for an existing installation',
    ],
    ['has no keys but real users', { users: 1 }, fresh, 'already has users or credentials'],
    [
      'has no keys but stored credentials',
      { credentials: true },
      fresh,
      'already has users or credentials',
    ],
  ])('refuses when the installation %s, and writes nothing', async (_l, init, options, message) => {
    const world = cloudflare(init);
    await expect(createInstallationKeys(world.access, options)).rejects.toThrow(message);
    expect(world.writes).toEqual([]);
  });

  // A partly restored database: ciphertext rows survive though no user or credential row does.
  it.each([...new Set(D1_LOCATIONS.map((location) => location.table))])(
    'refuses ENCRYPTION_KEY when %s still holds a row, though no user is left',
    async (table) => {
      const world = cloudflare({ orphanIn: table });
      await expect(createInstallationKeys(world.access, fresh)).rejects.toThrow(
        'already has users or credentials'
      );
      expect(world.writes).toEqual([]);
    }
  );

  it('a failed write reports only its status and error code, never a body', async () => {
    const world = cloudflare({ failWrite: true });
    const error = await createInstallationKeys(world.access, fresh).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(InstallationKeysError);
    const written = JSON.parse(world.writes[0]) as { secrets: Record<string, { text: string }> };
    for (const { text } of Object.values(written.secrets))
      for (const line of text.split('\n').filter((part) => part.length > 16))
        expect(String((error as Error).message)).not.toContain(line);
    expect((error as Error).message).toBe('Cloudflare API workers returned 400 (error 10215)');
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

  const allNames = async () => new Set<string>(INSTALLATION_KEY_NAMES);
  const marker = urn('random:index/randomId:RandomId', 'installation-keys-retired');

  /**
   * A stack's state as Pulumi would change it: a targeted `up` of the marker adds it, `state
   * delete` removes a resource. `failOn` makes one command fail, as a killed or erroring run would.
   */
  function fakeStack(initial: string[], failOn?: string) {
    const state = new Set(initial);
    const calls: string[] = [];
    return {
      state,
      calls,
      listUrns: async () => [...state],
      pulumi: async (args: string[]) => {
        const line = args.join(' ');
        calls.push(line);
        if (failOn && line === failOn) throw new Error(`pulumi failed: ${line}`);
        if (args[0] === 'up' && args[1] === '--target') state.add(args[2]);
        if (args[0] === 'state' && args[1] === 'delete') state.delete(args[2]);
      },
    };
  }

  it('checks the Worker, creates the marker, then unprotects and deletes each key resource', async () => {
    const f = fakeStack([stack, ...keys, identity]);
    const order: string[] = [];
    const retired = await retireKeyResources({
      urns: [...f.state],
      listUrns: f.listUrns,
      workerSecretNames: async () => {
        order.push('require');
        return allNames();
      },
      pulumi: async (args) => {
        order.push(args.join(' '));
        await f.pulumi(args);
      },
    });
    expect(retired).toEqual(keys);
    expect(order[0]).toBe('require');
    expect(order[1]).toBe(`up --target ${marker} --yes --skip-preview`);
    expect(order.slice(2)).toEqual(
      keys.flatMap((key) => [`state unprotect ${key} --yes`, `state delete ${key} --yes`])
    );
    expect([...f.state].sort()).toEqual([stack, identity, marker].sort());
  });

  it('a run that fails part-way has already left the marker in state', async () => {
    const third = keys[2]!;
    const f = fakeStack([stack, ...keys, identity], `state unprotect ${third} --yes`);
    await expect(
      retireKeyResources({
        urns: [...f.state],
        listUrns: f.listUrns,
        workerSecretNames: allNames,
        pulumi: f.pulumi,
      })
    ).rejects.toThrow('pulumi failed');
    // Two resources are gone and the rest remain, but an older release still meets the marker.
    expect(f.state.has(marker)).toBe(true);
    expect(f.state.has(keys[0]!)).toBe(false);
    expect(f.state.has(third)).toBe(true);
  });

  it('removes nothing when the marker could not be created', async () => {
    const f = fakeStack([stack, ...keys]);
    const calls: string[] = [];
    await expect(
      retireKeyResources({
        urns: [...f.state],
        listUrns: f.listUrns,
        workerSecretNames: allNames,
        // The targeted update "succeeds" but the marker never reaches state.
        pulumi: async (args) => {
          calls.push(args.join(' '));
        },
      })
    ).rejects.toThrow('marker was not created');
    expect(calls.filter((line) => line.startsWith('state'))).toEqual([]);
    expect(f.state.size).toBe(keys.length + 1);
  });

  it('does not recreate a marker already in state', async () => {
    const f = fakeStack([stack, marker, ...keys]);
    await retireKeyResources({
      urns: [...f.state],
      listUrns: f.listUrns,
      workerSecretNames: allNames,
      pulumi: f.pulumi,
    });
    expect(f.calls.some((line) => line.startsWith('up'))).toBe(false);
    expect([...f.state].sort()).toEqual([stack, marker].sort());
  });

  it('leaves state untouched when the Worker lacks a key that state still holds', async () => {
    const f = fakeStack([stack, ...keys]);
    await expect(
      retireKeyResources({
        urns: [...f.state],
        listUrns: f.listUrns,
        workerSecretNames: async () =>
          new Set(INSTALLATION_KEY_NAMES.filter((name) => name !== 'VAPID_PUBLIC_KEY')),
        pulumi: f.pulumi,
      })
    ).rejects.toThrow('does not have (VAPID_PUBLIC_KEY)');
    expect(f.calls).toEqual([]);
  });

  it('retires a resource whose keys are on the Worker even if another group is absent from both', async () => {
    const encryption = keys.find((key) => key.endsWith('::encryption-key'))!;
    const f = fakeStack([stack, encryption]);
    await retireKeyResources({
      urns: [...f.state],
      listUrns: f.listUrns,
      // An older installation that never had VAPID keys anywhere.
      workerSecretNames: async () =>
        new Set(INSTALLATION_KEY_NAMES.filter((name) => !name.startsWith('VAPID_'))),
      pulumi: f.pulumi,
    });
    expect(f.calls).toEqual([
      `up --target ${marker} --yes --skip-preview`,
      `state unprotect ${encryption} --yes`,
      `state delete ${encryption} --yes`,
    ]);
  });

  it('is a no-op on a stack already migrated, without even checking the Worker', async () => {
    let checked = false;
    const retired = await retireKeyResources({
      urns: [stack, identity],
      listUrns: async () => [stack, identity],
      workerSecretNames: async () => {
        checked = true;
        return allNames();
      },
      pulumi: async () => {
        throw new Error('no state command expected');
      },
    });
    expect(retired).toEqual([]);
    expect(checked).toBe(false);
  });
});

describe('parseSecretListing', () => {
  const listing = [{ name: 'ENCRYPTION_KEY', type: 'secret_text' }];
  it('reads the JSON after notices that contain brackets', () => {
    const text = `[WARNING] a notice [with brackets]\n${JSON.stringify(listing, null, 2)}\n`;
    expect(parseSecretListing(text)).toEqual(listing);
  });
  it('reads compact and empty listings', () => {
    expect(parseSecretListing(JSON.stringify(listing))).toEqual(listing);
    expect(parseSecretListing('[]')).toEqual([]);
  });
  it('throws on output with no listing', () => {
    expect(() => parseSecretListing('[ERROR] not logged in')).toThrow();
  });
});
