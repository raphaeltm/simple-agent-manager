/**
 * Live: the Docker socket proxy celld uses for guided credential login
 * (deploy/selfhost/docker-proxy), built from its Dockerfile and run as compose runs it (no
 * network, read-only root, no capabilities, non-root, the host socket through the docker group),
 * in front of the real Docker daemon.
 *
 * The test plays a compromised celld holding the proxy socket. It must NOT be able to start a
 * privileged container, mount the host filesystem, use host networking or a capability, use an
 * image or a runtime the deploy did not name, read or exec into or remove a container that is not
 * one of celld's sandboxes, load an image, or reach the daemon through path tricks or JSON key
 * smuggling. And celld's real call sequence must still work end to end (create, start, inspect,
 * exec with a hijacked stream, kill, wait, remove; the fence container; its two networks), or
 * every refusal above would be vacuous.
 *
 * The runtime in the policy here is `runc`, because CI has no gVisor; the proxy enforces
 * equality with whatever the policy names, which on a box is `runsc`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LIVE_TMP, REPO_ROOT, sleep, waitFor } from './harness';

const RUN = randomBytes(4).toString('hex');
const IMAGE = 'sam-selfhost-docker-proxy:live-test';
const BASE = 'alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f';
const SANDBOX_IMAGE = `celld-image:${createHash('sha256').update(`sandbox-${RUN}`).digest('hex')}`;
const FENCE_IMAGE = `celld-image:${createHash('sha256').update(`fence-${RUN}`).digest('hex')}`;
const NODE = `live-${RUN}`;
const DIR = join(LIVE_TMP, `docker-proxy-${RUN}`);
const SOCKET = join(DIR, 'sock', 'docker.sock');
const RESOLV_HOST = join(DIR, 'policy', 'container-resolv.conf');
const CELLD_RESOLV_BIND = '/var/lib/celld/container-resolv.conf:/etc/resolv.conf:ro';
// celld 0.6.3 FENCE_RULES, verbatim (crates/celld/container.rs).
const FENCE_RULES = `table inet celld
delete table inet celld
table inet celld {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname { "celld0", "celld1" } ct state established,related accept
    iifname { "celld0", "celld1" } reject
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname { "celld0", "celld1" } ip daddr { 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } reject
    iifname { "celld0", "celld1" } ip6 daddr { fe80::/10, fc00::/7 } reject
  }
}
`;
const PROXY = `sam-docker-proxy-live-${RUN}`;
const OUTSIDER = `sam-outsider-live-${RUN}`;
const created = new Set<string>();

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Docker answers vary
}

function call(method: string, path: string, body?: unknown, rawBody?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
    const req = request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: {
          Host: 'docker',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: unknown = raw;
          try {
            json = JSON.parse(raw);
          } catch {
            // Not JSON (logs, empty body).
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on('error', reject);
    req.end(text);
  });
}

/** celld's `hijack`: exec start with Upgrade: tcp, then the multiplexed stream until EOF. */
function hijackExec(execId: string): Promise<{ head: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET);
    const body = JSON.stringify({ Detach: false, Tty: false });
    let buffer = Buffer.alloc(0);
    socket.on('connect', () => {
      socket.write(
        `POST /exec/${execId}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n` +
          `Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      socket.end(); // stdin EOF, as celld's close_stdin does
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const split = buffer.indexOf('\r\n\r\n');
      const head = buffer.subarray(0, split).toString('utf8');
      let rest = buffer.subarray(split + 4);
      let stdout = '';
      while (rest.length >= 8) {
        const length = rest.readUInt32BE(4);
        if (rest[0] === 1) stdout += rest.subarray(8, 8 + length).toString('utf8');
        rest = rest.subarray(8 + length);
      }
      resolve({ head, stdout });
    });
  });
}

function sandboxBody(
  overrides: Record<string, unknown> = {},
  hostOverrides: Record<string, unknown> = {}
) {
  return {
    Image: SANDBOX_IMAGE,
    Env: ['CLOUDFLARE_LOCATION=loc01', 'SAM_TEST=1'],
    Labels: { 'celld.node': NODE, 'celld.cell': 'cell-1', 'celld.class': 'SandboxDO' },
    Cmd: ['sleep', '300'],
    HostConfig: {
      NetworkMode: 'celld',
      PublishAllPorts: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 1024,
      Init: true,
      Runtime: 'runc',
      Binds: [CELLD_RESOLV_BIND],
      NanoCpus: 250_000_000,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      ...hostOverrides,
    },
    ...overrides,
  };
}

function containerName(label: string): string {
  return `celld-${createHash('sha256').update(`${RUN}-${label}`).digest('hex').slice(0, 24)}`;
}

async function createSandbox(label: string, body: unknown = sandboxBody()): Promise<Reply> {
  const name = containerName(label);
  const reply = await call('POST', `/containers/create?name=${name}`, body);
  if (reply.status === 201) created.add(reply.json.Id as string);
  return reply;
}

function inspectDirect(ref: string): any {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  return JSON.parse(docker('inspect', ref))[0];
}

const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!dockerAvailable)('docker socket proxy (live, real daemon)', () => {
  beforeAll(async () => {
    mkdirSync(join(DIR, 'sock'), { recursive: true });
    mkdirSync(join(DIR, 'policy'), { recursive: true });
    chmodSync(join(DIR, 'sock'), 0o777); // the proxy runs as uid 7103
    writeFileSync(RESOLV_HOST, 'nameserver 1.1.1.1\n', { mode: 0o644 });
    writeFileSync(
      join(DIR, 'policy', 'policy.json'),
      JSON.stringify({
        runtime: 'runc',
        sandboxImages: [SANDBOX_IMAGE],
        fenceImage: FENCE_IMAGE,
        fenceRulesSha256: createHash('sha256').update(FENCE_RULES).digest('hex'),
        celldResolvConfBind: CELLD_RESOLV_BIND,
        resolvConfHostPath: RESOLV_HOST,
        maxMemoryBytes: 1024 * 1024 * 1024,
        maxNanoCpus: 250_000_000,
        maxPidsLimit: 1024,
      }),
      { mode: 0o644 }
    );
    docker('build', '-q', '-t', IMAGE, join(REPO_ROOT, 'deploy/selfhost/docker-proxy'));
    docker('pull', '-q', BASE);
    docker('tag', BASE, SANDBOX_IMAGE);
    docker('tag', BASE, FENCE_IMAGE);
    // Not celld's: a container the box runs for something else (the stack's own services).
    docker(
      'run',
      '-d',
      '--name',
      OUTSIDER,
      '-e',
      'OUTSIDER_SECRET=do-not-leak',
      BASE,
      'sleep',
      '300'
    );
    const socketGid = docker(
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/s',
      BASE,
      'stat',
      '-c',
      '%g',
      '/s'
    );
    docker(
      'run',
      '-d',
      '--name',
      PROXY,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--group-add',
      socketGid,
      '-e',
      'SAM_DOCKER_PROXY_SOCKET_MODE=666', // the test runner is not in celld's group
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${join(DIR, 'sock')}:/run/sam-docker-proxy`,
      '-v',
      `${join(DIR, 'policy')}:/etc/sam/docker-proxy:ro`,
      IMAGE
    );
    await waitFor(
      'the proxy socket',
      async () => (await call('GET', '/_ping').catch(() => null))?.status === 200,
      30_000,
      () => docker('logs', PROXY)
    );
  });

  afterAll(() => {
    for (const id of created) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    spawnSync('docker', ['rm', '-f', PROXY, OUTSIDER], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', SANDBOX_IMAGE, FENCE_IMAGE], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', 'celld', 'celld-internal'], { stdio: 'ignore' });
    rmSync(DIR, { recursive: true, force: true });
  });

  it("runs celld's own sequence end to end (control)", async () => {
    // networks(): create both bridges exactly as celld does (409 when they exist is fine).
    for (const [name, internal, bridge] of [
      ['celld', false, 'celld0'],
      ['celld-internal', true, 'celld1'],
    ] as const) {
      const reply = await call('POST', '/networks/create', {
        Name: name,
        Driver: 'bridge',
        Internal: internal,
        Options: {
          'com.docker.network.bridge.enable_icc': 'false',
          'com.docker.network.bridge.name': bridge,
        },
      });
      expect([201, 409]).toContain(reply.status);
      expect((await call('GET', `/networks/${name}`)).status).toBe(200);
    }
    expect((await call('GET', `/images/${SANDBOX_IMAGE}/json`)).status).toBe(200);

    const createdReply = await createSandbox('control');
    expect(createdReply.status).toBe(201);
    const name = containerName('control');
    // The resolver bind now names the operator's file, not celld's data dir.
    const direct = inspectDirect(name);
    expect(direct.HostConfig.Binds).toEqual([`${RESOLV_HOST}:/etc/resolv.conf:ro`]);
    expect(direct.HostConfig.Privileged).toBe(false);
    expect(direct.HostConfig.CapDrop).toEqual(['ALL']);

    expect((await call('POST', `/containers/${name}/start`)).status).toBe(204);
    const inspected = await call('GET', `/containers/${name}/json`);
    expect(inspected.status).toBe(200);
    expect(inspected.json.State.Running).toBe(true);
    const listed = await call(
      'GET',
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`celld.node=${NODE}`] }))}`
    );
    expect(listed.status).toBe(200);
    expect(listed.json.map((c: { Id: string }) => c.Id)).toContain(createdReply.json.Id);

    const exec = await call('POST', `/containers/${name}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['sh', '-c', 'echo hello-from-sandbox; cat /etc/resolv.conf'],
    });
    expect(exec.status).toBe(201);
    const stream = await hijackExec(exec.json.Id);
    expect(stream.head).toMatch(/^HTTP\/1\.1 101/);
    expect(stream.stdout).toContain('hello-from-sandbox');
    expect(stream.stdout).toContain('nameserver 1.1.1.1');
    const execInfo = await waitFor(
      'the exec to exit',
      async () => {
        const reply = await call('GET', `/exec/${exec.json.Id}/json`);
        return reply.json.Running === false ? reply : null;
      },
      10_000
    );
    expect(execInfo?.json.ExitCode).toBe(0);

    const waiter = call('POST', `/containers/${name}/wait`);
    expect((await call('POST', `/containers/${name}/kill?signal=SIGKILL`)).status).toBe(204);
    expect((await waiter).json.StatusCode).toBe(137);
    expect((await call('DELETE', `/containers/${name}?force=true`)).status).toBe(204);
    // celld deletes before every create; a missing container stays the daemon's 404.
    expect((await call('DELETE', `/containers/${name}?force=true`)).status).toBe(404);
  });

  it("allows celld's exact fence container and nothing like it", async () => {
    const fence = {
      Image: FENCE_IMAGE,
      Env: [`CELLD_NFT=${FENCE_RULES}`],
      Cmd: ['sh', '-c', `printf '%s' "$CELLD_NFT" | nft -f -`],
      Labels: { 'celld.node': NODE, 'celld.fence': '1' },
      HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN'] },
    };
    const ok = await call('POST', '/containers/create', fence);
    expect(ok.status).toBe(201);
    created.add(ok.json.Id);
    expect(
      (await call('GET', `/containers/${ok.json.Id}/logs?stdout=true&stderr=true`)).status
    ).toBe(200);
    // Any other host-network NET_ADMIN container: other rules, other command, other image, more caps.
    const attempts = [
      { ...fence, Env: ['CELLD_NFT=flush ruleset'] },
      { ...fence, Cmd: ['sh', '-c', 'nft flush ruleset'] },
      { ...fence, Image: SANDBOX_IMAGE },
      { ...fence, HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN', 'SYS_ADMIN'] } },
      { ...fence, HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN'], Privileged: true } },
      { ...fence, HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN'], Binds: ['/:/host'] } },
    ];
    for (const attempt of attempts) {
      expect((await call('POST', '/containers/create', attempt)).status).toBe(403);
    }
    // No exec into the fence container (it runs with host networking).
    expect((await call('POST', `/containers/${ok.json.Id}/exec`, { Cmd: ['id'] })).status).toBe(
      404
    );
  });

  describe('a compromised celld', () => {
    const refusals: Array<[string, unknown, Record<string, unknown>?]> = [
      ['a privileged container', sandboxBody({}, { Privileged: true })],
      ['the host filesystem as a bind', sandboxBody({}, { Binds: ['/:/host'] })],
      [
        'the host filesystem through a second bind',
        sandboxBody({}, { Binds: [CELLD_RESOLV_BIND, '/etc:/x:ro'] }),
      ],
      [
        'a mount instead of a bind',
        sandboxBody({}, { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }),
      ],
      ['an anonymous volume', sandboxBody({ Volumes: { '/data': {} } })],
      ['host networking', sandboxBody({}, { NetworkMode: 'host' })],
      ['the default bridge', sandboxBody({}, { NetworkMode: 'bridge' })],
      ['a capability', sandboxBody({}, { CapAdd: ['SYS_ADMIN'] })],
      ['keeping capabilities', sandboxBody({}, { CapDrop: [] })],
      [
        'a device',
        sandboxBody({}, { Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda' }] }),
      ],
      ['the host PID namespace', sandboxBody({}, { PidMode: 'host' })],
      [
        'seccomp off',
        sandboxBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] }),
      ],
      ['another image', sandboxBody({ Image: BASE })],
      ['another runtime', sandboxBody({}, { Runtime: 'io.containerd.runc.v2' })],
      ['no runtime (daemon default)', sandboxBody({}, { Runtime: undefined })],
      ['more memory than its type', sandboxBody({}, { Memory: 8 * 1024 * 1024 * 1024 })],
      ['a different user entrypoint field', sandboxBody({ Entrypoint: ['/bin/sh'] })],
      ['a case-variant HostConfig key', { ...sandboxBody(), hostconfig: { Privileged: true } }],
      ['a case-variant field inside HostConfig', sandboxBody({}, { privileged: true })],
      [
        'the fence label on a sandbox',
        sandboxBody({
          Labels: { 'celld.node': NODE, 'celld.cell': 'c', 'celld.class': 'S', 'celld.fence': '0' },
        }),
      ],
    ];
    it.each(refusals)('cannot create a container with %s', async (_what, body) => {
      const reply = await createSandbox(`attack-${_what}`, body);
      expect(reply.status).toBe(403);
      expect(String(reply.json.message)).toMatch(/^sam-docker-proxy refused/);
    });

    it('cannot smuggle a duplicate JSON key past the check', async () => {
      // The daemon sees the re-serialised body this proxy checked, never the raw duplicate.
      const good = JSON.stringify(sandboxBody());
      const raw = `{"HostConfig":{"Privileged":true,"Binds":["/:/host"]},${good.slice(1)}`;
      const name = containerName('duplicate');
      const reply = await call('POST', `/containers/create?name=${name}`, undefined, raw);
      expect(reply.status).toBe(201);
      created.add(reply.json.Id);
      const direct = inspectDirect(name);
      expect(direct.HostConfig.Privileged).toBe(false);
      expect(direct.HostConfig.Binds).toEqual([`${RESOLV_HOST}:/etc/resolv.conf:ro`]);
    });

    it('cannot read, exec into, stop or remove a container that is not a celld sandbox', async () => {
      for (const [method, path, body] of [
        ['GET', `/containers/${OUTSIDER}/json`, undefined],
        ['GET', `/containers/${OUTSIDER}/logs?stdout=true`, undefined],
        ['POST', `/containers/${OUTSIDER}/exec`, { Cmd: ['env'], AttachStdout: true }],
        ['POST', `/containers/${OUTSIDER}/kill?signal=SIGKILL`, undefined],
        ['POST', `/containers/${OUTSIDER}/wait`, undefined],
        ['DELETE', `/containers/${OUTSIDER}?force=true`, undefined],
        ['POST', `/containers/${PROXY}/exec`, { Cmd: ['sh'] }],
        ['GET', `/containers/${PROXY}/json`, undefined],
      ] as const) {
        const reply = await call(method, path, body);
        // The same answer as for a container that does not exist: no oracle for what else runs.
        expect(reply.status, `${method} ${path}`).toBe(404);
        expect(JSON.stringify(reply.json)).not.toContain('do-not-leak');
      }
      const missing = await call('GET', '/containers/sam-no-such-container/json');
      expect(missing.status).toBe(404);
      expect(inspectDirect(OUTSIDER).State.Running).toBe(true);
    });

    it('cannot create or use a bridge named after an Object.prototype key (unfenced network)', async () => {
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const reply = await call('POST', '/networks/create', {
          Name: name,
          Driver: 'bridge',
          Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        });
        expect(reply.status, name).toBe(403);
        expect(
          (await createSandbox(`proto-${name}`, sandboxBody({}, { NetworkMode: name }))).status
        ).toBe(403);
      }
      expect(docker('network', 'ls', '--format', '{{.Name}}').split('\n')).not.toContain(
        'constructor'
      );
    });

    it('gets only the inspect fields celld reads, not host layout', async () => {
      const sandbox = await createSandbox('inspect-trim');
      expect(sandbox.status).toBe(201);
      const inspected = await call('GET', `/containers/${sandbox.json.Id}/json`);
      expect(inspected.status).toBe(200);
      expect(Object.keys(inspected.json).sort()).toEqual([
        'Id',
        'Name',
        'NetworkSettings',
        'State',
      ]);
      expect(JSON.stringify(inspected.json)).not.toContain(RESOLV_HOST);
      expect((await call('GET', `/images/${SANDBOX_IMAGE}/json`)).json).toEqual({
        Id: expect.any(String),
      });
    });

    it('survives a client that hangs up in the middle of an upgrade request', async () => {
      await new Promise<void>((resolve) => {
        const socket = connect(SOCKET, () => {
          socket.write(
            'POST /containers/create HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\n' +
              'Upgrade: tcp\r\nContent-Length: 2\r\n\r\n{}'
          );
          socket.destroy();
          resolve();
        });
      });
      await sleep(300);
      expect((await call('GET', '/_ping')).status).toBe(200);
      expect(docker('inspect', '--format', '{{.State.Running}} {{.RestartCount}}', PROXY)).toBe(
        'true 0'
      );
    });

    it('cannot use an exec it did not create, or start one with Privileged', async () => {
      const outsiderExec = JSON.parse(
        execFileSync(
          'curl',
          [
            '-s',
            '--unix-socket',
            '/var/run/docker.sock',
            '-X',
            'POST',
            '-H',
            'Content-Type: application/json',
            '-d',
            '{"Cmd":["true"]}',
            `http://docker/containers/${OUTSIDER}/exec`,
          ],
          { encoding: 'utf8' }
        )
      ).Id as string;
      expect((await call('POST', `/exec/${outsiderExec}/start`, { Detach: true })).status).toBe(
        403
      );
      expect((await call('GET', `/exec/${outsiderExec}/json`)).status).toBe(403);
      const sandbox = await createSandbox('exec-priv');
      expect(sandbox.status).toBe(201);
      expect((await call('POST', `/containers/${sandbox.json.Id}/start`)).status).toBe(204);
      const privileged = await call('POST', `/containers/${sandbox.json.Id}/exec`, {
        Cmd: ['id'],
        Privileged: true,
      });
      expect(privileged.status).toBe(403);
    });

    it('cannot load, pull, build, tag or commit an image, or touch other daemon state', async () => {
      for (const [method, path] of [
        ['POST', '/images/load?quiet=true'],
        ['POST', '/images/create?fromImage=alpine&tag=latest'],
        ['POST', '/build'],
        ['POST', `/images/${SANDBOX_IMAGE}/tag?repo=sam-selfhost-caddy&tag=local`],
        ['POST', `/commit?container=${OUTSIDER}&repo=x`],
        ['GET', `/images/${BASE.split('@')[0]}/json`],
        ['GET', '/images/json'],
        ['DELETE', `/images/${SANDBOX_IMAGE}`],
        ['GET', '/containers/json'],
        ['GET', '/containers/json?all=true'],
        [
          'GET',
          `/containers/json?filters=${encodeURIComponent(JSON.stringify({ name: ['sam'] }))}`,
        ],
        ['POST', '/networks/create'],
        ['GET', '/networks/bridge'],
        ['DELETE', '/networks/bridge'],
        ['POST', '/volumes/create'],
        ['GET', '/info'],
        ['POST', '/swarm/init'],
        ['POST', '/plugins/pull'],
        ['GET', '/events'],
      ] as const) {
        const reply = await call(method, path, method === 'POST' ? {} : undefined);
        expect(reply.status, `${method} ${path}`).toBe(403);
      }
    });

    it('cannot reach a refused endpoint through path tricks or a versioned path', async () => {
      for (const path of [
        '/containers/x/../../images/load',
        '/containers/%2e%2e/images/load',
        '/v1.47/containers/create',
        '//images/load',
        '/containers/create/../../build',
      ]) {
        const reply = await call('POST', path, {});
        expect(reply.status, path).toBe(403);
      }
    });

    it('cannot create a network other than celld’s two, or with other options', async () => {
      const bad = [
        { Name: 'evil', Driver: 'bridge', Internal: false, Options: {} },
        {
          Name: 'celld',
          Driver: 'bridge',
          Internal: false,
          Options: {
            'com.docker.network.bridge.enable_icc': 'true',
            'com.docker.network.bridge.name': 'celld0',
          },
        },
        {
          Name: 'celld',
          Driver: 'macvlan',
          Internal: false,
          Options: {
            'com.docker.network.bridge.enable_icc': 'false',
            'com.docker.network.bridge.name': 'celld0',
          },
        },
      ];
      for (const body of bad)
        expect((await call('POST', '/networks/create', body)).status).toBe(403);
    });
  });

  it('reaps sandboxes a previous celld session left behind when celld reaps for its new node', async () => {
    const stale = await createSandbox(
      'stale-node',
      sandboxBody({
        Labels: { 'celld.node': `old-${NODE}`, 'celld.cell': 'c', 'celld.class': 'SandboxDO' },
      })
    );
    const current = await createSandbox('current-node');
    expect([stale.status, current.status]).toEqual([201, 201]);
    // Same labels as a stale sandbox, but not a sandbox shape (default runtime, default bridge):
    // the reaper must not touch it.
    const lookalike = docker(
      'run',
      '-d',
      '--label',
      `celld.node=old-${NODE}`,
      '--label',
      'celld.class=SandboxDO',
      BASE,
      'sleep',
      '300'
    );
    created.add(lookalike);
    const filters = encodeURIComponent(JSON.stringify({ label: [`celld.node=${NODE}`] }));
    expect((await call('GET', `/containers/json?all=true&filters=${filters}`)).status).toBe(200);
    await waitFor(
      'the stale sandbox to be reaped',
      () => spawnSync('docker', ['inspect', stale.json.Id], { stdio: 'ignore' }).status !== 0
    );
    expect(inspectDirect(current.json.Id).Id).toBe(current.json.Id);
    expect(inspectDirect(lookalike).State.Running).toBe(true);
    expect(docker('logs', PROXY)).toContain('"event":"reaped_stale_sandbox"');
  });

  it('removes sandboxes older than the maximum session age, and nothing else', async () => {
    // A second proxy with a 3 s age limit and a 1 s sweep, on its own socket.
    const sweeper = `${PROXY}-age`;
    const dir = join(DIR, 'sock-age');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const socketGid = docker(
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/s',
      BASE,
      'stat',
      '-c',
      '%g',
      '/s'
    );
    const sandbox = await createSandbox('over-age');
    expect(sandbox.status).toBe(201);
    const lookalike = docker(
      'run',
      '-d',
      '--label',
      `celld.node=${NODE}`,
      '--label',
      'celld.class=SandboxDO',
      BASE,
      'sleep',
      '300'
    );
    created.add(lookalike);
    docker(
      'run',
      '-d',
      '--name',
      sweeper,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--group-add',
      socketGid,
      '-e',
      'SAM_DOCKER_PROXY_MAX_SANDBOX_AGE_SECONDS=3',
      '-e',
      'SAM_DOCKER_PROXY_SWEEP_INTERVAL_MS=1000',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${dir}:/run/sam-docker-proxy`,
      '-v',
      `${join(DIR, 'policy')}:/etc/sam/docker-proxy:ro`,
      IMAGE
    );
    created.add(sweeper);
    try {
      await waitFor(
        'the over-age sandbox to be removed',
        () => spawnSync('docker', ['inspect', sandbox.json.Id], { stdio: 'ignore' }).status !== 0,
        20_000,
        () => docker('logs', sweeper)
      );
      expect(inspectDirect(lookalike).State.Running).toBe(true);
      expect(docker('logs', sweeper)).toContain('"reason":"over_max_age"');
    } finally {
      spawnSync('docker', ['rm', '-f', sweeper], { stdio: 'ignore' });
    }
  });

  it('logs refusals without request bodies', async () => {
    await sleep(200);
    const logs = docker('logs', PROXY);
    expect(logs).toContain('"event":"refused"');
    expect(logs).not.toContain('SAM_TEST=1');
    expect(logs).not.toContain('OUTSIDER_SECRET');
  });
});
