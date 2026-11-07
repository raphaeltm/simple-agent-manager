import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dockerfileSources,
  downloadVerified,
  fetchPrebuiltManifest,
  imageContextKey,
  importPrebuiltImages,
  placePrebuiltFiles,
  PREBUILT_MANIFEST,
  prebuiltBaseUrl,
  type PrebuiltManifest,
} from './installer-engine-prebuilt.js';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'prebuilt-'));
  directories.push(dir);
  return dir;
};
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const BASE = 'https://artifacts.example.com/v1';

/** A publisher serving fixed bodies by URL; everything else is 404. */
function publisher(files: Record<string, string>) {
  const requested: string[] = [];
  const request = async (url: string) => {
    requested.push(url);
    const name = url.slice(BASE.length + 1);
    return name in files ? new Response(files[name]) : new Response('missing', { status: 404 });
  };
  return { request, requested };
}

const binary = 'vm-agent-bytes';
const manifest = (overrides: Partial<PrebuiltManifest> = {}): PrebuiltManifest => ({
  schemaVersion: 1,
  files: [
    {
      kind: 'vm-agent',
      key: 'k1',
      path: 'bin/a',
      name: 'a',
      sha256: sha(binary),
      size: binary.length,
    },
    { kind: 'vm-agent', key: 'k1', path: 'bin/b', name: 'b', sha256: sha('bee'), size: 3 },
  ],
  images: [],
  ...overrides,
});

describe('prebuilt base URL', () => {
  it('accepts plain https and rejects anything that could smuggle credentials', () => {
    expect(prebuiltBaseUrl('https://example.com/releases/download/v1/')).toBe(
      'https://example.com/releases/download/v1'
    );
    for (const value of [
      'http://example.com/a',
      'https://user:pw@example.com/a',
      'https://example.com/a?token=1',
      'https://example.com/a#x',
      'not a url',
      '',
      undefined,
    ])
      expect(prebuiltBaseUrl(value)).toBeUndefined();
  });
});

describe('prebuilt manifest', () => {
  it('reads a valid manifest and treats absence or malformed content as no manifest', async () => {
    const valid = publisher({ [PREBUILT_MANIFEST]: JSON.stringify(manifest()) });
    expect((await fetchPrebuiltManifest(valid.request, BASE))?.files).toHaveLength(2);
    expect(await fetchPrebuiltManifest(publisher({}).request, BASE)).toBeUndefined();
    for (const bad of [
      '{not json',
      JSON.stringify({ ...manifest(), schemaVersion: 2 }),
      JSON.stringify(manifest({ files: [{ ...manifest().files[0], path: '../escape' }] })),
      JSON.stringify(manifest({ files: [{ ...manifest().files[0], sha256: 'abc' }] })),
    ])
      expect(
        await fetchPrebuiltManifest(publisher({ [PREBUILT_MANIFEST]: bad }).request, BASE)
      ).toBeUndefined();
  });
});

describe('verified download', () => {
  it('writes the file only when size and SHA-256 match', async () => {
    const dir = temp();
    const { request } = publisher({ a: binary, wrong: 'other-bytes!!', long: `${binary}x` });
    const expected = { sha256: sha(binary), size: binary.length };
    expect(await downloadVerified(request, `${BASE}/a`, join(dir, 'ok'), expected, 5000)).toBe(
      true
    );
    expect(readFileSync(join(dir, 'ok'), 'utf8')).toBe(binary);
    expect(await downloadVerified(request, `${BASE}/wrong`, join(dir, 'w'), expected, 5000)).toBe(
      false
    );
    expect(await downloadVerified(request, `${BASE}/long`, join(dir, 'l'), expected, 5000)).toBe(
      false
    );
    expect(await downloadVerified(request, `${BASE}/gone`, join(dir, 'g'), expected, 5000)).toBe(
      false
    );
    for (const name of ['w', 'l', 'g', 'w.partial', 'l.partial'])
      expect(existsSync(join(dir, name))).toBe(false);
  });

  it('places a kind only when the manifest covers every requested path', async () => {
    const dir = temp();
    const { request } = publisher({ a: binary, b: 'bee' });
    const input = {
      request,
      base: BASE,
      manifest: manifest(),
      kind: 'vm-agent',
      root: dir,
      timeoutMs: 5000,
    };
    expect(await placePrebuiltFiles({ ...input, key: 'k1', paths: ['bin/a', 'bin/b'] })).toBe(true);
    expect(readFileSync(join(dir, 'bin/b'), 'utf8')).toBe('bee');
    // A different content key, or a path the publisher did not provide, means build.
    expect(await placePrebuiltFiles({ ...input, key: 'k2', paths: ['bin/a', 'bin/b'] })).toBe(
      false
    );
    expect(
      await placePrebuiltFiles({ ...input, key: 'k1', paths: ['bin/a', 'bin/b', 'bin/c'] })
    ).toBe(false);
  });
});

describe('image content key', () => {
  const context = () => {
    const dir = temp();
    mkdirSync(join(dir, 'artifacts'));
    writeFileSync(
      join(dir, 'Dockerfile'),
      [
        'FROM base@sha256:' + 'a'.repeat(64) + ' AS stage',
        'COPY artifacts/one.sh /tmp/one.sh',
        'COPY --chmod=755 artifacts/two /usr/local/bin/two',
        'COPY --from=stage /opt/x /opt/x',
      ].join('\n')
    );
    writeFileSync(join(dir, 'artifacts/one.sh'), 'one');
    writeFileSync(join(dir, 'artifacts/two'), 'two');
    writeFileSync(join(dir, 'unrelated'), 'u');
    return dir;
  };

  it('lists copied context files and ignores multi-stage copies', () => {
    expect(dockerfileSources(readFileSync(join(context(), 'Dockerfile'), 'utf8'))).toEqual([
      'artifacts/one.sh',
      'artifacts/two',
    ]);
  });

  it('changes with any copied file or the Dockerfile, and nothing else', () => {
    const dir = context();
    const before = imageContextKey(dir, 'Dockerfile');
    writeFileSync(join(dir, 'unrelated'), 'changed');
    expect(imageContextKey(dir, 'Dockerfile')).toBe(before);
    writeFileSync(join(dir, 'artifacts/two'), 'changed');
    const afterCopy = imageContextKey(dir, 'Dockerfile');
    expect(afterCopy).not.toBe(before);
    writeFileSync(
      join(dir, 'Dockerfile'),
      `${readFileSync(join(dir, 'Dockerfile'), 'utf8')}\nENV X=1`
    );
    expect(imageContextKey(dir, 'Dockerfile')).not.toBe(afterCopy);
  });
});

describe('prebuilt image import', () => {
  const setup = (registryDigest: string) => {
    const dir = temp();
    writeFileSync(join(dir, 'Dockerfile.sandbox'), 'FROM x\nCOPY a /a\n');
    writeFileSync(join(dir, 'a'), 'a');
    const key = imageContextKey(dir, 'Dockerfile.sandbox');
    const archive = 'oci-layout-tar';
    const published = 'sha256:' + 'b'.repeat(64);
    const { request, requested } = publisher({ 'sandbox.tar': archive });
    const commands: { executable: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    let passwordFile = '';
    const input = {
      request,
      base: BASE,
      manifest: {
        schemaVersion: 1 as const,
        files: [],
        images: [
          {
            className: 'SandboxDO',
            key,
            name: 'sandbox.tar',
            sha256: sha(archive),
            size: archive.length,
            digest: published,
          },
          {
            className: 'Unused',
            key: 'c'.repeat(64),
            name: 'unused.tar',
            sha256: sha('x'),
            size: 1,
            digest: published,
          },
        ],
      },
      accountId: 'f'.repeat(32),
      contextDir: dir,
      containers: [
        { className: 'SandboxDO', dockerfile: 'Dockerfile.sandbox' },
        { className: 'VmAgentContainer', dockerfile: 'Dockerfile.sandbox' },
      ],
      repository: (className: string) => `s123-api-prod-${className.toLowerCase()}`,
      work: join(dir, 'work'),
      timeoutMs: 5000,
      run: async (executable: string, args: string[], env?: NodeJS.ProcessEnv) => {
        commands.push({ executable, args, env });
        if (executable === 'crane' && args[0] === 'push')
          passwordFile = readFileSync(join(String(env?.DOCKER_CONFIG), 'config.json'), 'utf8');
        return executable === 'crane' && args[0] === 'digest' ? `${registryDigest}\n` : '';
      },
      registryPassword: async () => 'registry-password-value',
    };
    return { input, commands, requested, published, getPasswordFile: () => passwordFile };
  };

  it('pushes a matching image and returns its digest-pinned account reference', async () => {
    const t = setup('sha256:' + 'b'.repeat(64));
    const references = await importPrebuiltImages(t.input);
    expect(references).toEqual({
      SandboxDO: `registry.cloudflare.com/${'f'.repeat(32)}/s123-api-prod-sandboxdo@${t.published}`,
    });
    // The class whose key matches nothing published is left for Wrangler to build.
    expect(t.requested).not.toContain(`${BASE}/unused.tar`);
    expect(t.commands.map((c) => `${c.executable} ${c.args[0]}`)).toEqual([
      'tar -xf',
      'crane push',
      'crane digest',
    ]);
    // The registry password reaches crane through a private config file, never argv.
    expect(t.commands.flatMap((c) => c.args).join(' ')).not.toContain('registry-password-value');
    expect(
      Buffer.from(
        JSON.parse(t.getPasswordFile()).auths['registry.cloudflare.com'].auth,
        'base64'
      ).toString()
    ).toBe('v1:registry-password-value');
    expect(existsSync(t.input.work)).toBe(false);
  });

  it('rejects an image whose registry digest differs from the published one', async () => {
    const t = setup('sha256:' + 'e'.repeat(64));
    expect(await importPrebuiltImages(t.input)).toEqual({});
  });
});
