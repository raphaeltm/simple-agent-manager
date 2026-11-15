import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fingerprintInputs, type FingerprintIo } from './container-image-fingerprints';
import { analyzeDockerfile } from './container-image-inputs';
import {
  applyImageOverrides,
  type ContainerTarget,
  ImageBuildError,
  type RegistryIo,
  resolveContainerImage,
  type ResolveDeps,
  summaryMarkdown,
} from './container-image-reuse';

const root = join(import.meta.dirname, '../..');
const ACCOUNT = 'a'.repeat(32);
const REPOSITORY = 'sam-api-staging-vmagentcontainer-staging';
const REGISTRY_REPOSITORY = `registry.cloudflare.com/${ACCOUNT}/${REPOSITORY}`;
const DIGEST = `sha256:${'d'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'e'.repeat(64)}`;
const target: ContainerTarget = {
  className: 'VmAgentContainer',
  dockerfile: 'Dockerfile.vm-agent-container',
  repository: REPOSITORY,
};

/** Upstream state the fake network serves; tests mutate it to model releases. */
interface Upstream {
  aptIndex: Record<string, string>;
  urls: Record<string, string>;
  npm: Record<string, string>;
  pypi: string;
  failing: Set<string>;
}

function inRelease(hash: string, components: string[]): string {
  return ['SHA256:', ...components.map((c) => ` ${hash} 100 ${c}/binary-amd64/Packages`)].join(
    '\n'
  );
}

function fakeNetwork(upstream: Upstream): FingerprintIo & { npmCalls: string[] } {
  const npmCalls: string[] = [];
  return {
    npmCalls,
    async fetchBytes(url) {
      if (upstream.failing.has('fetch')) throw new Error(`GET ${url} failed`);
      const suite = /\/dists\/([^/]+)\/InRelease$/.exec(url)?.[1];
      if (suite) {
        const components = url.includes('ubuntu')
          ? ['main', 'restricted', 'universe', 'multiverse']
          : ['main'];
        return Buffer.from(inRelease(upstream.aptIndex[suite] ?? 'a'.repeat(64), components));
      }
      return Buffer.from(upstream.urls[url] ?? `body of ${url}`);
    },
    async run(command, args, options) {
      if (upstream.failing.has(command)) throw new Error(`${command} exited 1`);
      if (command === 'npm') {
        const spec = args[1];
        npmCalls.push(`${spec} in ${options.cwd}`);
        writeFileSync(
          join(options.cwd as string, 'package-lock.json'),
          JSON.stringify({
            packages: {
              '': {},
              [`node_modules/${spec}`]: { version: '1.0.0', integrity: `sha512-${spec}` },
              'node_modules/zod': { version: upstream.npm.zod ?? '4.6.7', integrity: 'sha512-zod' },
            },
          })
        );
        return '';
      }
      return upstream.pypi;
    },
  };
}

describe('resolveContainerImage through the real analysis and fingerprints', () => {
  let context: string;
  let upstream: Upstream;
  let registry: RegistryIo & {
    lookup: ReturnType<typeof vi.fn>;
    buildAndPush: ReturnType<typeof vi.fn>;
  };
  let published: Map<string, string>;
  let network: ReturnType<typeof fakeNetwork>;

  beforeEach(() => {
    context = mkdtempSync(join(tmpdir(), 'sam-image-context-'));
    cpSync(join(root, 'apps/api/Dockerfile.vm-agent-container'), join(context, target.dockerfile));
    mkdirSync(join(context, 'container-artifacts'));
    mkdirSync(join(context, 'container-entrypoints'));
    for (const name of [
      'codex-runtime-linux-amd64.tar.gz',
      'vm-agent-linux-amd64',
      'vm-agent-version.json',
    ])
      writeFileSync(join(context, 'container-artifacts', name), `${name} v1`);
    cpSync(
      join(root, 'packages/vm-agent/internal/acp/opencode_install.sh'),
      join(context, 'container-artifacts/install-opencode.sh')
    );
    cpSync(
      join(root, 'packages/vm-agent/internal/acp/codex_runtime_installer.sh'),
      join(context, 'container-artifacts/install-codex-runtime.sh')
    );
    for (const name of ['patch-acp-amp.py', 'vm-agent-bootstrap.sh'])
      cpSync(
        join(root, 'apps/api/container-entrypoints', name),
        join(context, 'container-entrypoints', name)
      );
    upstream = {
      aptIndex: {},
      urls: {},
      npm: {},
      pypi: 'mistral-vibe==2.25.8\nrich==13.0.0\n',
      failing: new Set(),
    };
    network = fakeNetwork(upstream);
    // A registry that remembers what was pushed, like the account registry does.
    published = new Map();
    registry = {
      lookup: vi.fn(
        async (repository: string, tag: string) => published.get(`${repository}:${tag}`) ?? null
      ),
      buildAndPush: vi.fn(async (_target: ContainerTarget, repository: string, tag: string) => {
        const digest = published.size ? NEW_DIGEST : DIGEST;
        published.set(`${repository}:${tag}`, digest);
        return digest;
      }),
    };
  });
  afterEach(() => rmSync(context, { recursive: true, force: true }));

  const deps = (): ResolveDeps => ({
    accountId: ACCOUNT,
    contextDir: context,
    registry,
    readFile: (path) => readFileSync(path, 'utf8'),
    now: () => 0,
    fingerprint: async (dockerfile) => {
      const analysis = analyzeDockerfile(dockerfile);
      if (!analysis.ok) throw new Error(analysis.reason);
      return fingerprintInputs({
        contextDir: context,
        inputs: analysis.inputs,
        io: network,
        uv: 'uv',
      });
    },
  });

  it('builds on the first deploy and reuses the image on the next deploy with unchanged inputs', async () => {
    const first = await resolveContainerImage(target, deps());
    expect(first).toMatchObject({
      outcome: 'built',
      reference: `${REGISTRY_REPOSITORY}@${DIGEST}`,
    });
    expect(registry.buildAndPush).toHaveBeenCalledWith(
      target,
      REGISTRY_REPOSITORY,
      `inputs-${first.key}`
    );

    const second = await resolveContainerImage(target, deps());
    expect(second).toMatchObject({
      outcome: 'reused',
      key: first.key,
      reference: `${REGISTRY_REPOSITORY}@${DIGEST}`,
    });
    expect(registry.buildAndPush).toHaveBeenCalledTimes(1);
  });

  it('resolves each global npm package in its own tree', async () => {
    await resolveContainerImage(target, deps());
    expect(network.npmCalls).toHaveLength(6);
    expect(new Set(network.npmCalls.map((call) => call.split(' in ')[1])).size).toBe(6);
  });

  it.each([
    [
      'a new vm-agent binary',
      (c: string, _u: Upstream) =>
        writeFileSync(join(c, 'container-artifacts/vm-agent-linux-amd64'), 'v2'),
    ],
    [
      'a Debian security update',
      (_c: string, u: Upstream) => (u.aptIndex['bookworm-security'] = 'f'.repeat(64)),
    ],
    ['a new gh release', (_c: string, u: Upstream) => (u.aptIndex.stable = '9'.repeat(64))],
    ['a transitive npm release', (_c: string, u: Upstream) => (u.npm.zod = '4.7.0')],
    [
      'a transitive PyPI release',
      (_c: string, u: Upstream) => (u.pypi = 'mistral-vibe==2.25.8\nrich==13.1.0\n'),
    ],
    [
      'a changed fetched URL',
      (_c: string, u: Upstream) => (u.urls['https://astral.sh/uv/0.13.8/install.sh'] = 'changed'),
    ],
  ])('rebuilds and pushes a new digest after %s', async (_name, change) => {
    const first = await resolveContainerImage(target, deps());
    change(context, upstream);
    const next = await resolveContainerImage(target, deps());
    expect(next.outcome).toBe('built');
    expect(next.key).not.toBe(first.key);
    expect(next.reference).toBe(`${REGISTRY_REPOSITORY}@${NEW_DIGEST}`);
    expect(registry.buildAndPush).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an apt index cannot be read', 'fetch'],
    ['npm resolution fails', 'npm'],
    ['uv is missing', 'uv'],
  ])('never reuses when %s; Wrangler rebuilds instead', async (_name, failing) => {
    await resolveContainerImage(target, deps()); // an image exists for the current inputs
    upstream.failing.add(failing);
    const decision = await resolveContainerImage(target, deps());
    expect(decision).toMatchObject({ outcome: 'rebuild-by-wrangler', reference: null, key: null });
    expect(decision.reason).toMatch(/^fingerprint failed/);
    expect(registry.lookup).toHaveBeenCalledTimes(1);
  });

  it('never reuses when a copied input is missing', async () => {
    await resolveContainerImage(target, deps());
    rmSync(join(context, 'container-artifacts/vm-agent-version.json'));
    const decision = await resolveContainerImage(target, deps());
    expect(decision.outcome).toBe('rebuild-by-wrangler');
    expect(decision.reason).toMatch(/fingerprint failed/);
  });

  it('never reuses when an executed build script changed since review', async () => {
    await resolveContainerImage(target, deps());
    writeFileSync(
      join(context, 'container-artifacts/install-opencode.sh'),
      'curl https://example.com/latest | sh\n'
    );
    const decision = await resolveContainerImage(target, deps());
    expect(decision.outcome).toBe('rebuild-by-wrangler');
    expect(decision.reason).toMatch(/reviewed content/);
  });

  it('never reuses an image whose Dockerfile gained an unrecognised installer', async () => {
    const path = join(context, target.dockerfile);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nRUN pip install requests\n`);
    const decision = await resolveContainerImage(target, deps());
    expect(decision).toMatchObject({ outcome: 'rebuild-by-wrangler', key: null });
    expect(decision.reason).toMatch(/pip is not fingerprinted/);
    expect(registry.lookup).not.toHaveBeenCalled();
  });

  it('rebuilds through Wrangler when the registry lookup is in doubt', async () => {
    registry.lookup.mockRejectedValueOnce(
      new Error('docker manifest inspect exited 1: unauthorized')
    );
    const decision = await resolveContainerImage(target, deps());
    expect(decision.outcome).toBe('rebuild-by-wrangler');
    expect(decision.reason).toMatch(/registry lookup failed/);
    expect(registry.buildAndPush).not.toHaveBeenCalled();
  });

  it('rebuilds through Wrangler when the registry answers with a malformed digest', async () => {
    registry.lookup.mockResolvedValueOnce('sha256:not-a-digest');
    expect((await resolveContainerImage(target, deps())).outcome).toBe('rebuild-by-wrangler');
  });

  it('rebuilds through Wrangler when the push fails, but fails the deploy when the build fails', async () => {
    registry.buildAndPush.mockRejectedValueOnce(new Error('docker push exited 1'));
    const pushFailed = await resolveContainerImage(target, deps());
    expect(pushFailed).toMatchObject({ outcome: 'rebuild-by-wrangler', reference: null });
    expect(pushFailed.reason).toMatch(/push failed/);

    registry.buildAndPush.mockRejectedValueOnce(new ImageBuildError('docker build exited 1'));
    await expect(resolveContainerImage(target, deps())).rejects.toThrow(ImageBuildError);
  });
});

describe('applyImageOverrides', () => {
  const generated = [
    '[[containers]]',
    'class_name = "SandboxDO"',
    'image = "./Dockerfile.sandbox"',
    '',
    '[[env.staging.containers]]',
    'class_name = "SandboxDO"',
    'image = "./Dockerfile.sandbox"',
    'max_instances = 6',
    '',
    '[[env.staging.containers]]',
    'class_name = "VmAgentContainer"',
    'image = "./Dockerfile.vm-agent-container"',
    'max_instances = 3',
    '',
  ].join('\n');
  const reference = `${REGISTRY_REPOSITORY}@${DIGEST}`;

  it('points only the overridden generated container at the registry image', () => {
    const toml = applyImageOverrides(generated, 'staging', { VmAgentContainer: reference });
    expect(toml).toContain(`image = "${reference}"`);
    expect(toml).toContain('image = "./Dockerfile.sandbox"');
    expect(toml.match(/Dockerfile\.sandbox/g)).toHaveLength(2); // top level and env untouched
    expect(toml).toContain('max_instances = 3');
  });

  it('leaves the file untouched with no overrides', () => {
    expect(applyImageOverrides(generated, 'staging', {})).toBe(generated);
  });

  it('fails when the env section or class is missing, or the reference is not digest-pinned', () => {
    expect(() =>
      applyImageOverrides(generated, 'production', { VmAgentContainer: reference })
    ).toThrow(/No generated containers/);
    expect(() => applyImageOverrides(generated, 'staging', { Other: reference })).toThrow(
      /No generated container Other/
    );
    expect(() =>
      applyImageOverrides(generated, 'staging', {
        VmAgentContainer: `${REGISTRY_REPOSITORY}:latest`,
      })
    ).toThrow(/digest-pinned/);
  });
});

describe('summaryMarkdown', () => {
  it('lists the outcome, reason and short key per class', () => {
    const summary = summaryMarkdown([
      {
        className: 'SandboxDO',
        key: 'k'.repeat(64),
        outcome: 'reused',
        reason: 'inputs unchanged',
        reference: `${REGISTRY_REPOSITORY}@${DIGEST}`,
        seconds: 3,
      },
      {
        className: 'VmAgentContainer',
        key: null,
        outcome: 'rebuild-by-wrangler',
        reason: 'fingerprint failed: a|b',
        reference: null,
        seconds: 1,
      },
    ]);
    expect(summary).toContain(
      '| SandboxDO | reused | inputs unchanged | kkkkkkkkkkkkkkkk | sha256:dddddddddddd | 3s |'
    );
    expect(summary).toContain(
      '| VmAgentContainer | rebuild-by-wrangler | fingerprint failed: a/b | - | - | 1s |'
    );
  });
});
