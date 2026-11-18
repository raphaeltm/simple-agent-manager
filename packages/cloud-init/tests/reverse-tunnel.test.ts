/**
 * Reverse-tunnel (frp) ingress mode. Like tunnel.test.ts, rendered scripts run under their
 * declared interpreters with stubbed system commands; the frpc release is a real tarball
 * extracted by the real `tar`, so the extraction path is exercised, not asserted as text.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  generateCloudInit,
  validateCloudInitSize,
  validateCloudInitVariables,
} from '../src/generate';
import {
  DEFAULT_FRPC_VERSION,
  FRPC_RELEASES,
  REVERSE_TUNNEL_PROXY_NAME,
} from '../src/reverse-tunnel';
import type { CloudInitVariables } from '../src/variables';

const CREDENTIAL = 'Rt_credential-fixture_0123456789abcdefABCDEF';
const CALLBACK_TOKEN = 'CALLBACK-CANARY';
const INCARNATION = '0f6c0a8e-2a4b-4c55-9d6e-1b2c3d4e5f60';
const RELEASE = FRPC_RELEASES[DEFAULT_FRPC_VERSION]!;

function variables(overrides?: Partial<CloudInitVariables>): CloudInitVariables {
  return {
    nodeId: '01M72NODEREVERSE0000000001',
    nodeRuntimeIncarnationId: INCARNATION,
    hostname: 'sam-reverse-node',
    controlPlaneUrl: 'https://api.box.example.org',
    jwksUrl: 'https://api.box.example.org/.well-known/jwks.json',
    callbackToken: CALLBACK_TOKEN,
    swapSizeMb: '0',
    ...overrides,
  };
}

const reverse = (overrides?: Partial<CloudInitVariables>) =>
  variables({
    reverseTunnelCredential: CREDENTIAL,
    reverseTunnelRemotePort: '20007',
    ...overrides,
  });

type Parsed = {
  runcmd: string[];
  write_files: Array<{ path: string; content: string; permissions?: string; owner?: string }>;
};

const parse = (vars: CloudInitVariables) => YAML.parse(generateCloudInit(vars)) as Parsed;

function file(parsed: Parsed, path: string) {
  const entry = parsed.write_files.find((f) => f.path === path);
  if (!entry) throw new Error(`missing write_files entry ${path}`);
  return entry;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reverse-tunnel variable validation', () => {
  it('accepts a credential and lease port with defaults', () => {
    expect(() => validateCloudInitVariables(reverse())).not.toThrow();
  });

  it.each([
    ['credential with shell metacharacters', { reverseTunnelCredential: `${'a'.repeat(40)}';id` }],
    ['credential too short', { reverseTunnelCredential: 'short' }],
    ['missing lease port', { reverseTunnelRemotePort: '' }],
    ['lease port out of range', { reverseTunnelRemotePort: '70000' }],
    ['listener port equal to the agent port', { reverseTunnelLocalPort: '8080' }],
    [
      'Origin CA in reverse-tunnel mode',
      { originCaCertificateUrl: 'https://api.box.example.org/c' },
    ],
    ['a Cloudflare token as well', { cloudflareTunnelToken: 'c'.repeat(64) }],
    ['no runtime incarnation', { nodeRuntimeIncarnationId: '' }],
    ['a cloudflared-only setting', { cloudflaredVersion: '2026.10.7' }],
    ['wait seconds out of range', { tunnelListenerWaitSeconds: '0' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => validateCloudInitVariables(reverse(overrides))).toThrow(/validation failed/);
  });

  it('never echoes the credential in validation errors', () => {
    let message = '';
    try {
      validateCloudInitVariables(reverse({ reverseTunnelCredential: `${'Q'.repeat(40)}$(id)` }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('reverseTunnelCredential');
    expect(message).not.toContain('QQQQ');
  });

  it.each(['reverseTunnelRemotePort', 'reverseTunnelLocalPort'] as const)(
    'rejects %s without a credential instead of booting a direct-ingress node',
    (name) => {
      expect(() => validateCloudInitVariables(variables({ [name]: '20001' }))).toThrow(
        `${name}: requires reverseTunnelCredential`
      );
    }
  );
});

describe('rendered reverse-tunnel user-data', () => {
  it('runs the agent with the loopback tunnel listener and no Origin CA', () => {
    const output = generateCloudInit(reverse());
    const unit = file(parse(reverse()), '/etc/systemd/system/vm-agent.service').content;
    expect(unit).toContain('Environment=VM_AGENT_PORT=8080\n');
    expect(unit).toContain('Environment=TLS_CERT_PATH=\n');
    expect(unit).toContain('Environment=VM_AGENT_TUNNEL_ENABLED=true\n');
    expect(unit).toContain('Environment=VM_AGENT_TUNNEL_PORT=8444\n');
    expect(unit).toContain('ExecStartPre=/etc/sam/firewall/setup-firewall.sh');
    expect(output).not.toContain('origin-ca');
    expect(output).not.toContain('sam-cloudflared');
    expect(output).not.toContain('/usr/local/bin/cloudflared');
  });

  it('writes an frpc config that dials the control plane over verified wss with one proxy', () => {
    const toml = file(parse(reverse()), '/etc/sam/frpc/frpc.toml');
    // Pre-opened work connections keep the NewWorkConn plugin round trip off the data path.
    expect(toml.content).toContain('transport.poolCount = 2\n');
    expect(toml.permissions).toBe('0644');
    const lines = toml.content.split('\n');
    for (const expected of [
      'serverAddr = "api.box.example.org"',
      'serverPort = 443',
      'loginFailExit = false',
      'user = "01M72NODEREVERSE0000000001"',
      'metadatas.node_id = "01M72NODEREVERSE0000000001"',
      `metadatas.incarnation = "${INCARNATION}"`,
      'metadatas.credential = "{{ .Envs.SAM_REVERSE_TUNNEL_CREDENTIAL }}"',
      'transport.protocol = "wss"',
      'transport.tls.enable = true',
      'transport.tls.serverName = "api.box.example.org"',
      'transport.tls.useSystemCa = true',
      `name = "${REVERSE_TUNNEL_PROXY_NAME}"`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      'localPort = 8444',
      'remotePort = 20007',
    ]) {
      expect(lines).toContain(expected);
    }
    expect(toml.content.match(/\[\[proxies\]\]/g)).toHaveLength(1);
    expect(toml.content).not.toContain(CREDENTIAL);
  });

  it('keeps the credential in a root-only environment file, exactly once in user-data', () => {
    const output = generateCloudInit(reverse());
    expect(output.split(CREDENTIAL)).toHaveLength(2);
    const env = file(parse(reverse()), '/etc/sam/frpc/credential.env');
    expect(env.permissions).toBe('0400');
    expect(env.owner).toBe('root:root');
    expect(env.content.trim()).toBe(`SAM_REVERSE_TUNNEL_CREDENTIAL=${CREDENTIAL}`);
  });

  it('supervises frpc as an unprivileged, restart-always unit gated on the agent listener', () => {
    const parsed = parse(reverse());
    const unit = file(parsed, '/etc/systemd/system/sam-frpc.service').content;
    expect(unit).toContain('User=sam-frpc\n');
    expect(unit).toContain('EnvironmentFile=/etc/sam/frpc/credential.env\n');
    expect(unit).toContain('ExecStartPre=/usr/local/sbin/sam-wait-tunnel-listener\n');
    expect(unit).toContain('ExecStart=/usr/local/bin/frpc -c /etc/sam/frpc/frpc.toml\n');
    expect(unit).toContain('Restart=always\n');
    expect(unit).toContain('StartLimitIntervalSec=0\n');
    expect(unit).toContain('NoNewPrivileges=yes\n');
    expect(unit).not.toContain(CREDENTIAL);
    expect(file(parsed, '/usr/local/sbin/sam-wait-tunnel-listener').content).toContain(
      'http://127.0.0.1:8444/health'
    );
  });

  it('uses the control plane port when the URL carries one', () => {
    const toml = file(
      parse(reverse({ controlPlaneUrl: 'https://api.box.example.org:8443' })),
      '/etc/sam/frpc/frpc.toml'
    ).content;
    expect(toml).toContain('serverPort = 8443\n');
  });

  it('pins the release tarball checksum for both architectures', () => {
    const parsed = parse(reverse());
    const block = parsed.runcmd.find((e) => typeof e === 'string' && e.includes('FRP_SHA256'))!;
    expect(block).toContain(`FRP_SHA256=${RELEASE.amd64}`);
    expect(block).toContain(`FRP_SHA256=${RELEASE.arm64}`);
    expect(block).toContain(
      `https://github.com/fatedier/frp/releases/download/v${DEFAULT_FRPC_VERSION}/$FRP_NAME.tar.gz`
    );
  });

  it('stays under the Hetzner limit with production-sized identifiers', () => {
    const output = generateCloudInit(
      reverse({
        callbackToken: 'c'.repeat(900),
        nodeUserId: 'u'.repeat(32),
        projectId: 'p'.repeat(26),
        chatSessionId: 's'.repeat(36),
        taskId: 'k'.repeat(26),
        vmAgentRequiredVersion: 'a'.repeat(40),
        provider: 'hetzner',
      }),
      { validateSize: false }
    );
    expect(validateCloudInitSize(output)).toBe(true);
  });

  it('control: direct and Cloudflare-tunnel nodes render no frpc at all', () => {
    for (const vars of [
      variables({ originCaCertificateUrl: 'https://api.box.example.org/cert' }),
      variables({ cloudflareTunnelToken: Buffer.from('x'.repeat(48)).toString('base64') }),
    ]) {
      const output = generateCloudInit(vars);
      expect(output).not.toContain('frpc');
      expect(output).not.toContain('sam-frpc');
      expect(output).not.toContain('SAM_REVERSE_TUNNEL_CREDENTIAL');
    }
  });
});

/** Run the whole runcmd script under /bin/sh with the frp tarball served by a curl stub. */
function runBootScript(vars: CloudInitVariables, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-reverse-tunnel-test-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  mkdirSync(bin);
  mkdirSync(join(root, 'etc-sam', 'firewall'), { recursive: true });
  mkdirSync(join(root, 'usr-local-bin'), { recursive: true });
  writeFileSync(join(dir, 'calls.log'), '');

  // A real release-shaped tarball: frp_<v>_linux_amd64/frpc
  const releaseName = `frp_${DEFAULT_FRPC_VERSION}_linux_amd64`;
  mkdirSync(join(dir, 'release', releaseName), { recursive: true });
  writeFileSync(join(dir, 'release', releaseName, 'frpc'), '#!/bin/sh\necho fake-frpc\n');
  writeFileSync(join(dir, 'release', releaseName, 'frps'), 'not-installed');
  spawnSync('tar', ['-czf', join(dir, 'frp.tar.gz'), '-C', join(dir, 'release'), releaseName]);

  const stubs: Record<string, string> = {
    logger: 'cat >/dev/null 2>&1; true',
    systemctl: 'case "$*" in *sam-frpc*) exit "${FRPC_UNIT_EXIT:-0}" ;; esac',
    chage: 'true',
    sysctl: 'true',
    uname: 'echo x86_64',
    curl: `case "$*" in *fatedier/frp*) [ -z "\${FRP_CURL_EXIT:-}" ] || exit "$FRP_CURL_EXIT"
  while [ "$#" -gt 0 ]; do if [ "$1" = -fsSLo ]; then shift; cp "$TEST_DIR/frp.tar.gz" "$1"; fi; shift; done; exit 0 ;; esac
while [ "$#" -gt 0 ]; do if [ "$1" = -fLo ] || [ "$1" = -fsSLo ]; then shift; printf 'binary' > "$1"; fi; shift; done`,
    sha256sum: `echo "\${FAKE_SHA:-${RELEASE.amd64}}  $1"`,
    install: 'true',
    id: 'exit 1',
    useradd: 'true',
    chown: 'true',
    'sam-boot-failure': 'true',
    'sam-configure-docker-memory.sh': 'true',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$TEST_DIR/calls.log"\n${body}\n`,
      { mode: 0o755 }
    );
  }
  writeFileSync(
    join(root, 'etc-sam', 'firewall', 'setup-firewall.sh'),
    `#!/bin/sh\nprintf 'firewall\\n' >> "$TEST_DIR/calls.log"\nexit "\${FIREWALL_EXIT:-0}"\n`,
    { mode: 0o755 }
  );
  const script = parse(vars)
    .runcmd.join('\n')
    .replaceAll('/usr/local/sbin/', `${bin}/`)
    .replaceAll('/usr/local/bin/', `${root}/usr-local-bin/`)
    .replaceAll('/etc/sam/', `${root}/etc-sam/`)
    .replaceAll('/var/lib/vm-agent', `${root}/var-lib-vm-agent`);
  const result = spawnSync('/bin/sh', ['-c', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DIR: dir, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { result, calls: readFileSync(join(dir, 'calls.log'), 'utf8') };
}

const lineIndex = (calls: string, needle: string) =>
  calls.split('\n').findIndex((line) => line.includes(needle));

describe('executed reverse-tunnel boot sequence', () => {
  it('verifies and extracts frpc, closes ingress, then starts the agent and the connector', () => {
    const { result, calls } = runBootScript(reverse());
    expect(result.status).toBe(0);
    expect(calls).toMatch(
      /install -m 0755 \S+\/frp_0\.72\.0_linux_amd64\/frpc \S+\/usr-local-bin\/frpc/
    );
    expect(calls).toContain('useradd --system --no-create-home --shell /usr/sbin/nologin sam-frpc');
    expect(calls).not.toContain('sam-boot-failure');
    const firewall = lineIndex(calls, 'firewall');
    const agentStart = lineIndex(calls, 'systemctl start vm-agent');
    const connector = lineIndex(calls, 'systemctl enable --now sam-frpc.service');
    expect(firewall).toBeGreaterThan(-1);
    expect(agentStart).toBeGreaterThan(firewall);
    expect(connector).toBeGreaterThan(agentStart);
    expect(result.stdout + result.stderr + calls).not.toContain(CREDENTIAL);
  });

  it.each([
    ['checksum mismatch', { FAKE_SHA: '0'.repeat(64) }, 'frpc_install'],
    ['download failure', { FRP_CURL_EXIT: '22' }, 'frpc_install'],
    ['firewall failure', { FIREWALL_EXIT: '1' }, 'tunnel_firewall'],
  ])('fails closed on %s: reports and never starts the agent or connector', (_n, env, reason) => {
    const { result, calls } = runBootScript(reverse(), env);
    expect(result.status).toBe(1);
    expect(calls).toContain(`sam-boot-failure ${reason}`);
    expect(calls).not.toContain('systemctl start vm-agent');
    expect(calls).not.toContain('sam-frpc.service');
    if (reason === 'frpc_install') expect(calls).not.toMatch(/^install /m);
  });

  it('reports a connector that cannot start', () => {
    const { result, calls } = runBootScript(reverse(), { FRPC_UNIT_EXIT: '1' });
    expect(result.status).toBe(1);
    expect(calls).toContain('sam-boot-failure tunnel_connector');
  });
});
