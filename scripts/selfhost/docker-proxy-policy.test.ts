/**
 * The Docker socket proxy's decision (deploy/selfhost/docker-proxy/policy.ts) and the policy file
 * the deploy writes for it (docker-proxy-policy.ts). The same decisions run against a real daemon
 * in live/docker-proxy.live.test.ts; these cover the shapes without Docker.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CELLD_FENCE_CMD,
  CELLD_FENCE_RULES_SHA256,
  type ContainerFacts,
  decide,
  type DecisionContext,
  parsePolicy,
  type ProxyPolicy,
} from '../../deploy/selfhost/docker-proxy/policy.ts';
import {
  assertCelldTaggedImages,
  celldImageReference,
  type DockerCli,
  previousSandboxImages,
  renderProxyPolicy,
  writeDockerProxyFiles,
} from './docker-proxy-policy';
import { CELLD_VERSION } from './versions';

const SANDBOX = `celld-image:${'a'.repeat(64)}`;
const FENCE = `celld-image:${'f'.repeat(64)}`;
const FENCE_RULES = 'table inet celld\n';
const POLICY: ProxyPolicy = {
  runtime: 'runsc',
  sandboxImages: [SANDBOX],
  fenceImage: FENCE,
  fenceRulesSha256: createHash('sha256').update(FENCE_RULES).digest('hex'),
  celldResolvConfBind: '/var/lib/celld/container-resolv.conf:/etc/resolv.conf:ro',
  resolvConfHostPath: '/srv/sam/.state/docker-proxy/container-resolv.conf',
  maxMemoryBytes: 1024 ** 3,
  maxNanoCpus: 250_000_000,
  maxPidsLimit: 1024,
};
const SANDBOX_ID = '1'.repeat(64);
const FENCE_ID = '2'.repeat(64);
const OTHER_ID = '3'.repeat(64);
const EXEC_ID = '4'.repeat(64);

const containers: Record<string, ContainerFacts> = {
  'celld-sandbox': {
    id: SANDBOX_ID,
    labels: { 'celld.node': 'n' },
    runtime: 'runsc',
    networkMode: 'celld',
    privileged: false,
  },
  'celld-fence': {
    id: FENCE_ID,
    labels: { 'celld.node': 'n', 'celld.fence': '1' },
    runtime: '',
    networkMode: 'host',
    privileged: false,
  },
  caddy: {
    id: OTHER_ID,
    labels: { 'com.docker.compose.service': 'caddy' },
    runtime: 'runc',
    networkMode: 'host',
    privileged: false,
  },
  'celld-runc': {
    id: OTHER_ID,
    labels: { 'celld.node': 'n' },
    runtime: 'runc',
    networkMode: 'celld',
    privileged: false,
  },
  'celld-privileged': {
    id: OTHER_ID,
    labels: { 'celld.node': 'n' },
    runtime: 'runsc',
    networkMode: 'celld',
    privileged: true,
  },
};

const context: DecisionContext = {
  policy: POLICY,
  inspectContainer: async (ref) => containers[ref] ?? null,
  ownsExec: (id) => id === EXEC_ID,
};

function sandbox(host: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    Image: SANDBOX,
    Env: ['A=1'],
    Labels: { 'celld.node': 'n', 'celld.cell': 'c', 'celld.class': 'SandboxDO' },
    Cmd: ['sleep', '1'],
    HostConfig: {
      NetworkMode: 'celld',
      PublishAllPorts: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 1024,
      Init: true,
      Runtime: 'runsc',
      Binds: [POLICY.celldResolvConfBind],
      NanoCpus: 250_000_000,
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      ...host,
    },
    ...top,
  };
}

const NAME = `celld-${'0'.repeat(24)}`;

async function create(body: unknown, name: string | null = NAME) {
  const url = name ? `/containers/create?name=${name}` : '/containers/create';
  return decide({ method: 'POST', url, body, upgrade: false }, context);
}

describe('sandbox create', () => {
  it("allows celld's exact sandbox and rewrites the resolver bind to the operator's file", async () => {
    const decision = await create(sandbox());
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    const forwarded = JSON.parse(decision.body ?? '');
    expect(forwarded.HostConfig.Binds).toEqual([
      `${POLICY.resolvConfHostPath}:/etc/resolv.conf:ro`,
    ]);
    expect(forwarded.HostConfig.Runtime).toBe('runsc');
    expect(decision.target).toBe(`/containers/create?name=${NAME}`);
    // Bounded logs whatever the daemon's default driver: a sandbox printing in a loop cannot fill
    // /var/lib/docker.
    expect(forwarded.HostConfig.LogConfig).toEqual({
      Type: 'json-file',
      Config: { 'max-size': '1m', 'max-file': '1' },
    });
  });

  it.each([
    ['privileged', sandbox({ Privileged: true })],
    ['a host bind', sandbox({ Binds: ['/:/host'] })],
    ['host networking', sandbox({ NetworkMode: 'host' })],
    ['another network', sandbox({ NetworkMode: 'sam-selfhost_default' })],
    ['a capability', sandbox({ CapAdd: ['NET_ADMIN'] })],
    ['the runc runtime', sandbox({ Runtime: 'runc' })],
    ['no runtime', sandbox({ Runtime: undefined })],
    ['another image', sandbox({}, { Image: 'alpine:3.22' })],
    ['too much memory', sandbox({ Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3 })],
    ['swap above memory', sandbox({ MemorySwap: -1 })],
    ['too many pids', sandbox({ PidsLimit: 0 })],
    ['published ports', sandbox({ PublishAllPorts: true })],
    ['an unknown top-level key', sandbox({}, { Volumes: { '/x': {} } })],
    ['a lowercase smuggled key', sandbox({}, { hostconfig: { Privileged: true } })],
    [
      'a fence label of another value',
      sandbox(
        {},
        { Labels: { 'celld.node': 'n', 'celld.cell': 'c', 'celld.class': 'S', 'celld.fence': '0' } }
      ),
    ],
    [
      'a non-celld label',
      sandbox(
        {},
        {
          Labels: {
            'celld.node': 'n',
            'celld.cell': 'c',
            'celld.class': 'S',
            'com.docker.compose.project': 'sam',
          },
        }
      ),
    ],
  ])('refuses %s', async (_what, body) => {
    expect((await create(body)).allow).toBe(false);
  });

  it('refuses a sandbox without celld’s name, or with another name', async () => {
    expect((await create(sandbox(), null)).allow).toBe(false);
    expect((await create(sandbox(), 'sam-selfhost-caddy-1')).allow).toBe(false);
  });
});

describe('Object.prototype names', () => {
  // Plain-object lookups (`name in {...}`) accepted these as celld networks: an unfenced bridge.
  const names = Object.getOwnPropertyNames(Object.prototype);
  it.each(names)(
    'refuses %s as a network, a sandbox network and a container network',
    async (name) => {
      const call = (method: string, url: string, body?: unknown) =>
        decide({ method, url, body, upgrade: false }, context);
      expect(
        (
          await call('POST', '/networks/create', {
            Name: name,
            Driver: 'bridge',
            Options: { 'com.docker.network.bridge.enable_icc': 'false' },
          })
        ).allow
      ).toBe(false);
      expect((await call('GET', `/networks/${name}`)).allow).toBe(false);
      expect((await call('DELETE', `/networks/${name}`)).allow).toBe(false);
      expect((await create(sandbox({ NetworkMode: name }))).allow).toBe(false);
      expect((await call('DELETE', `/containers/celld-sandbox?${name}=1`)).allow).toBe(false);
      const onPrototypeBridge: DecisionContext = {
        ...context,
        inspectContainer: async () => ({
          id: SANDBOX_ID,
          labels: { 'celld.node': 'n' },
          runtime: 'runsc',
          networkMode: name,
          privileged: false,
        }),
      };
      expect(
        (
          await decide(
            { method: 'POST', url: '/containers/x/start', body: undefined, upgrade: false },
            onPrototypeBridge
          )
        ).allow
      ).toBe(false);
    }
  );
});

describe('fence create', () => {
  const fence = {
    Image: FENCE,
    Env: [`CELLD_NFT=${FENCE_RULES}`],
    Cmd: CELLD_FENCE_CMD,
    Labels: { 'celld.node': 'n', 'celld.fence': '1' },
    HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN'] },
  };

  it("allows celld's exact fence container, with bounded logs", async () => {
    const decision = await create(fence, null);
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    expect(JSON.parse(decision.body ?? '').HostConfig.LogConfig).toEqual({
      Type: 'json-file',
      Config: { 'max-size': '1m', 'max-file': '1' },
    });
  });

  it.each([
    ['other rules', { ...fence, Env: ['CELLD_NFT=flush ruleset'] }],
    ['an extra env entry', { ...fence, Env: [...fence.Env, 'X=1'] }],
    ['another command', { ...fence, Cmd: ['sh', '-c', 'id'] }],
    ['the sandbox image', { ...fence, Image: SANDBOX }],
    [
      'more capabilities',
      { ...fence, HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN', 'SYS_ADMIN'] } },
    ],
    ['a bind', { ...fence, HostConfig: { ...fence.HostConfig, Binds: ['/:/host'] } }],
  ])('refuses a fence with %s', async (_what, body) => {
    expect((await create(body, null)).allow).toBe(false);
  });

  it('refuses a named fence container', async () => {
    expect((await create(fence)).allow).toBe(false);
  });
});

describe('container lifecycle', () => {
  const call = (method: string, url: string, body?: unknown, upgrade = false) =>
    decide({ method, url, body, upgrade }, context);

  it('addresses an owned container by its id after the check', async () => {
    const decision = await call('POST', '/containers/celld-sandbox/kill?signal=SIGKILL');
    expect(decision).toMatchObject({
      allow: true,
      target: `/containers/${SANDBOX_ID}/kill?signal=SIGKILL`,
    });
    // Removal always takes the container's anonymous volumes with it.
    expect(await call('DELETE', '/containers/celld-fence?force=true')).toMatchObject({
      allow: true,
      target: expect.stringMatching(/^\/containers\/[0-9a-f]+\?force=true&v=true$/),
    });
  });

  it('answers 404 for containers that are not celld sandboxes, like a missing one (no oracle)', async () => {
    for (const ref of ['caddy', 'celld-runc', 'celld-privileged']) {
      expect(await call('GET', `/containers/${ref}/json`)).toMatchObject({
        allow: false,
        status: 404,
        reason: `No such container: ${ref}`,
        detail: 'container is not one of celld’s sandboxes',
      });
    }
    expect(await call('DELETE', '/containers/missing?force=true')).toMatchObject({
      allow: false,
      status: 404,
    });
  });

  it('allows exec only into a sandbox, without Privileged, and only owned exec ids', async () => {
    expect(await call('POST', '/containers/celld-sandbox/exec', { Cmd: ['id'] })).toMatchObject({
      allow: true,
      recordsExec: true,
    });
    expect((await call('POST', '/containers/celld-fence/exec', { Cmd: ['id'] })).allow).toBe(false);
    expect(
      (await call('POST', '/containers/celld-sandbox/exec', { Cmd: ['id'], Privileged: true }))
        .allow
    ).toBe(false);
    expect(
      await call('POST', `/exec/${EXEC_ID}/start`, { Detach: false, Tty: false }, true)
    ).toMatchObject({ allow: true, upgrade: true });
    expect((await call('POST', `/exec/${'5'.repeat(64)}/start`, { Detach: true })).allow).toBe(
      false
    );
    expect((await call('POST', '/containers/celld-sandbox/start', undefined, true)).allow).toBe(
      false
    );
  });

  it('refuses everything else', async () => {
    for (const [method, url] of [
      ['POST', '/images/load?quiet=true'],
      ['POST', '/build'],
      ['GET', '/containers/json'],
      ['GET', '/info'],
      ['POST', '/containers/celld-sandbox/update'],
      ['POST', '/containers/celld-sandbox/rename?name=x'],
      ['PUT', '/containers/celld-sandbox/archive?path=/'],
      ['POST', '/containers/x/../../images/load'],
      ['POST', '/v1.47/containers/create'],
      ['GET', `/images/${'alpine:3.22'}/json`],
    ] as const) {
      expect(
        (await call(method, url, method === 'GET' ? undefined : {})).allow,
        `${method} ${url}`
      ).toBe(false);
    }
  });
});

describe('the policy file', () => {
  it('pins the fence rules of the celld release the deploy uses', () => {
    // Bumping celld means re-deriving CELLD_FENCE_RULES_SHA256 (and the fence Dockerfile) from
    // its container.rs and deploy.rs; this test is the reminder.
    expect(CELLD_VERSION).toBe('0.6.3');
    expect(CELLD_FENCE_RULES_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is rendered from the instance type and written world-readable next to the resolver file', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sam-proxy-'));
    const policy = renderProxyPolicy({
      runtime: 'runsc',
      instanceType: 'basic',
      sandboxImage: SANDBOX,
      fenceImage: FENCE,
      stateDir,
    });
    expect(policy).toMatchObject({
      maxMemoryBytes: 1024 ** 3,
      maxNanoCpus: 250_000_000,
      maxPidsLimit: 1024,
    });
    const dir = writeDockerProxyFiles(stateDir, policy);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'policy.json')).mode & 0o777).toBe(0o644);
    expect(parsePolicy(readFileSync(join(dir, 'policy.json'), 'utf8'))).toEqual(policy);
    expect(readFileSync(policy.resolvConfHostPath, 'utf8')).toContain('nameserver 1.1.1.1');
    // The next deploy keeps the previous sandbox image for nodes still on the old version.
    const next = renderProxyPolicy({
      runtime: 'runsc',
      instanceType: 'basic',
      sandboxImage: `celld-image:${'b'.repeat(64)}`,
      fenceImage: FENCE,
      stateDir,
      previousSandboxImages: previousSandboxImages(stateDir),
    });
    expect(next.sandboxImages).toEqual([`celld-image:${'b'.repeat(64)}`, SANDBOX]);
  });

  it("computes celld's content reference from the image inspect output", () => {
    const content = '["sha256:x"]{"Cmd":["sh"]}';
    const docker: DockerCli = (args) => {
      expect(args).toEqual([
        'image',
        'inspect',
        '--format',
        '{{json .RootFS.Layers}}{{json .Config}}',
        'id1',
      ]);
      return content;
    };
    expect(celldImageReference(docker, 'id1')).toBe(
      `celld-image:${createHash('sha256').update(content).digest('hex')}`
    );
  });

  it('fails the deploy when celld did not tag what the policy allows', () => {
    const missing: DockerCli = () => {
      throw new Error('No such image');
    };
    expect(() => assertCelldTaggedImages(missing, POLICY)).toThrow(/did not tag/);
    expect(() => assertCelldTaggedImages(() => 'sha256:ok', POLICY)).not.toThrow();
  });

  it('refuses a malformed policy', () => {
    expect(() => parsePolicy(JSON.stringify({ ...POLICY, runtime: '' }))).toThrow(/runtime/);
    expect(() => parsePolicy(JSON.stringify({ ...POLICY, sandboxImages: ['alpine'] }))).toThrow(
      /sandboxImages/
    );
    expect(() =>
      parsePolicy(JSON.stringify({ ...POLICY, resolvConfHostPath: 'relative' }))
    ).toThrow(/absolute/);
    expect(() => parsePolicy(JSON.stringify({ ...POLICY, extra: 1 }))).toThrow(/extra/);
  });
});
