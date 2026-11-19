/**
 * Cloudflare Tunnel ingress mode. Rendered scripts are executed under their
 * declared interpreters (/bin/sh is Dash here, as on the Ubuntu VM images) with
 * stubbed system commands, so these tests observe boot ordering, fail-closed
 * exits and firewall rules rather than the presence of strings.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  generateCloudInit,
  HETZNER_USER_DATA_MAX_BYTES,
  validateCloudInitSize,
  validateCloudInitVariables,
} from '../src/generate';
import { CLOUDFLARED_RELEASES, DEFAULT_CLOUDFLARED_VERSION } from '../src/tunnel';
import type { CloudInitVariables } from '../src/variables';

// Explicit synthetic identities preserve connector-token format without a secret-like literal.
const TUNNEL_TOKEN = Buffer.from(
  JSON.stringify({ a: 'fixture-account', t: 'fixture-tunnel', s: 'fixture-secret' })
).toString('base64');
const CALLBACK_TOKEN = 'CALLBACK-CANARY';
const AMD64_SHA = CLOUDFLARED_RELEASES[DEFAULT_CLOUDFLARED_VERSION]!.amd64;

function variables(overrides?: Partial<CloudInitVariables>): CloudInitVariables {
  return {
    nodeId: 'node-tunnel-1',
    hostname: 'sam-tunnel-node',
    controlPlaneUrl: 'https://api.example.com',
    jwksUrl: 'https://api.example.com/.well-known/jwks.json',
    callbackToken: CALLBACK_TOKEN,
    swapSizeMb: '0',
    ...overrides,
  };
}

const tunnel = (overrides?: Partial<CloudInitVariables>) =>
  variables({ cloudflareTunnelToken: TUNNEL_TOKEN, ...overrides });

type Parsed = {
  runcmd: string[];
  write_files: Array<{ path: string; content: string; permissions?: string }>;
};

function parse(vars: CloudInitVariables): Parsed {
  return YAML.parse(generateCloudInit(vars)) as Parsed;
}

function file(parsed: Parsed, path: string): { content: string; permissions?: string } {
  const entry = parsed.write_files.find((f) => f.path === path);
  if (!entry) throw new Error(`missing write_files entry ${path}`);
  return entry;
}

function runcmdIndex(parsed: Parsed, needle: string): number {
  return parsed.runcmd.findIndex((entry) => typeof entry === 'string' && entry.includes(needle));
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sandbox with stub commands on PATH that append their argv to calls.log. */
function sandbox(stubs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-tunnel-test-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'calls.log'), '');
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$TEST_DIR/calls.log"\n${body}\n`,
      { mode: 0o755 }
    );
  }
  const run = (interpreter: string, script: string, env: Record<string, string> = {}) =>
    spawnSync(interpreter, ['-c', script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DIR: dir, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8');
  return { dir, bin, run, calls };
}

describe('tunnel variable validation', () => {
  it('accepts a connector token with defaults', () => {
    expect(() => validateCloudInitVariables(tunnel())).not.toThrow();
  });

  it.each([
    ['token with shell metacharacters', { cloudflareTunnelToken: `${'a'.repeat(40)}';reboot` }],
    ['token too short', { cloudflareTunnelToken: 'abc' }],
    ['tunnel port collides with default agent port', { cloudflareTunnelPort: '8080' }],
    [
      'tunnel port collides with explicit agent port',
      { vmAgentPort: '9000', cloudflareTunnelPort: '9000' },
    ],
    ['tunnel port out of range', { cloudflareTunnelPort: '70000' }],
    ['unpinned cloudflared version', { cloudflaredVersion: '2099.1.1' }],
    ['Origin CA in tunnel mode', { originCaCertificateUrl: 'https://api.example.com/cert' }],
    ['wait seconds out of range', { tunnelListenerWaitSeconds: '0' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => validateCloudInitVariables(tunnel(overrides))).toThrow(/validation failed/);
  });

  it('never echoes the connector token in validation errors', () => {
    const secret = `${'S'.repeat(40)}$(id)`;
    let message = '';
    try {
      validateCloudInitVariables(tunnel({ cloudflareTunnelToken: secret }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('cloudflareTunnelToken');
    expect(message).not.toContain('SSSS');
  });

  it.each([
    'cloudflareTunnelPort',
    'cloudflaredVersion',
    'tunnelListenerWaitSeconds',
    'tunnelListenerProbeTimeoutSeconds',
    'tunnelListenerProbeIntervalSeconds',
    'tunnelConnectorRestartSeconds',
  ] as const)('rejects %s without a token instead of booting a direct-ingress node', (name) => {
    expect(() => validateCloudInitVariables(variables({ [name]: '8444' }))).toThrow(
      `${name}: requires cloudflareTunnelToken`
    );
  });
});

describe('rendered tunnel-mode user-data', () => {
  it('runs the agent on plain loopback-protected HTTP with the tunnel listener enabled', () => {
    const unit = file(parse(tunnel()), '/etc/systemd/system/vm-agent.service').content;
    expect(unit).toContain('Environment=VM_AGENT_PORT=8080\n');
    expect(unit).toContain('Environment=TLS_CERT_PATH=\n');
    expect(unit).toContain('Environment=VM_AGENT_TUNNEL_ENABLED=true\n');
    expect(unit).toContain('Environment=VM_AGENT_TUNNEL_PORT=8444\n');
  });

  it('has no Origin CA bootstrap and carries no certificate request', () => {
    const output = generateCloudInit(tunnel());
    expect(output).not.toContain('ORIGIN_CA_CERTIFICATE_URL');
    expect(output).not.toContain('openssl');
    expect(output).not.toContain('origin-ca');
  });

  it('orders bootstrap: agent download, connector+firewall, agent start, connector start', () => {
    const parsed = parse(tunnel());
    const download = runcmdIndex(parsed, '/api/agent/download');
    const bootstrap = runcmdIndex(parsed, 'setup-firewall.sh');
    const agentStart = runcmdIndex(parsed, 'systemctl start vm-agent');
    const connector = runcmdIndex(parsed, 'systemctl enable --now sam-cloudflared.service');
    expect(download).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(download);
    expect(agentStart).toBeGreaterThan(bootstrap);
    expect(connector).toBeGreaterThan(agentStart);
  });

  it('supervises the connector with a token file, pinned binary and readiness gate', () => {
    const parsed = parse(tunnel());
    const unit = file(parsed, '/etc/systemd/system/sam-cloudflared.service').content;
    expect(unit).toContain('User=sam-cloudflared\n');
    expect(unit).toContain('ExecStartPre=/usr/local/sbin/sam-wait-tunnel-listener\n');
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/sam/cloudflared/tunnel-token\n'
    );
    expect(unit).toContain('Restart=always\n');
    expect(unit).toContain('StartLimitIntervalSec=0\n');
    expect(unit).not.toContain(TUNNEL_TOKEN);
    const wait = file(parsed, '/usr/local/sbin/sam-wait-tunnel-listener').content;
    expect(wait).toContain('http://127.0.0.1:8444/health');
  });

  it('carries each secret exactly once, outside any unit file or log line', () => {
    const output = generateCloudInit(tunnel());
    expect(output.split(TUNNEL_TOKEN)).toHaveLength(2);
    expect(output.split(CALLBACK_TOKEN)).toHaveLength(2);
    const parsed = parse(tunnel());
    expect(file(parsed, '/etc/sam/callback-token').content.trim()).toBe(CALLBACK_TOKEN);
  });

  it('pins the release URL and checksum for both architectures', () => {
    const block = parse(tunnel()).runcmd[runcmdIndex(parse(tunnel()), 'CF_SHA256')]!;
    const release = CLOUDFLARED_RELEASES[DEFAULT_CLOUDFLARED_VERSION]!;
    expect(block).toContain(`CF_SHA256=${release.amd64}`);
    expect(block).toContain(`CF_SHA256=${release.arm64}`);
    expect(block).toContain(
      `https://github.com/cloudflare/cloudflared/releases/download/${DEFAULT_CLOUDFLARED_VERSION}/cloudflared-linux-$CF_ARCH`
    );
  });

  it('stays under the Hetzner limit with production-sized secrets and identifiers', () => {
    const output = generateCloudInit(
      tunnel({
        callbackToken: 'c'.repeat(900),
        cloudflareTunnelToken: 't'.repeat(400),
        nodeUserId: 'u'.repeat(32),
        nodeRuntimeIncarnationId: 'i'.repeat(26),
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
});

describe('rendered direct (legacy) user-data', () => {
  it('keeps Origin CA bootstrap and the Cloudflare allowlist, and renders no connector', () => {
    const parsed = parse(variables({ originCaCertificateUrl: 'https://api.example.com/cert' }));
    expect(runcmdIndex(parsed, 'ORIGIN_CA_CERTIFICATE_URL=')).toBeGreaterThan(-1);
    expect(runcmdIndex(parsed, 'sam-cloudflared')).toBe(-1);
    expect(parsed.write_files.map((f) => f.path)).not.toContain(
      '/etc/systemd/system/sam-cloudflared.service'
    );
    const unit = file(parsed, '/etc/systemd/system/vm-agent.service').content;
    expect(unit).toContain('Environment=VM_AGENT_TUNNEL_ENABLED=false\n');
    expect(unit).toContain('Environment=VM_AGENT_PORT=8443\n');
  });

  it('stays under the Hetzner limit with production-sized secrets and identifiers', () => {
    const output = generateCloudInit(
      variables({
        callbackToken: 'c'.repeat(900),
        originCaCertificateUrl:
          'https://api.example.com/api/nodes/node-tunnel-1/origin-ca-certificate',
        nodeUserId: 'u'.repeat(32),
        nodeRuntimeIncarnationId: 'i'.repeat(26),
        projectId: 'p'.repeat(26),
        chatSessionId: 's'.repeat(36),
        taskId: 'k'.repeat(26),
        vmAgentRequiredVersion: 'a'.repeat(40),
        provider: 'hetzner',
      }),
      { validateSize: false }
    );
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(
      HETZNER_USER_DATA_MAX_BYTES
    );
  });
});

/**
 * cloud-init writes every runcmd entry into one /bin/sh script, so an `exit` in
 * one entry stops all later entries. This runs that script with absolute paths
 * redirected into a sandbox.
 */
function runBootScript(vars: CloudInitVariables, stubs: Record<string, string>) {
  const box = sandbox({
    logger: 'cat >/dev/null 2>&1; true',
    systemctl: 'true',
    chage: 'true',
    sysctl: 'true',
    uname: 'echo "${FAKE_ARCH:-x86_64}"',
    curl: `case "$*" in *cloudflared-linux*) [ -z "\${CF_CURL_EXIT:-}" ] || exit "$CF_CURL_EXIT" ;; esac
while [ "$#" -gt 0 ]; do if [ "$1" = -fLo ] || [ "$1" = -fsSLo ]; then shift; printf 'binary' > "$1"; fi; shift; done`,
    sha256sum: `echo "\${FAKE_SHA:-${AMD64_SHA}}  $1"`,
    install: 'true',
    id: 'exit 1',
    useradd: 'true',
    chown: 'true',
    'sam-boot-failure': 'true',
    'sam-configure-docker-memory.sh': 'true',
    ...stubs,
  });
  const root = join(box.dir, 'root');
  mkdirSync(join(root, 'etc-sam', 'firewall'), { recursive: true });
  writeFileSync(
    join(root, 'etc-sam', 'firewall', 'setup-firewall.sh'),
    `#!/bin/sh\nprintf 'firewall\\n' >> "$TEST_DIR/calls.log"\nexit "\${FIREWALL_EXIT:-0}"\n`,
    { mode: 0o755 }
  );
  const script = parse(vars)
    .runcmd.join('\n')
    .replaceAll('/usr/local/sbin/', `${box.bin}/`)
    .replaceAll('/usr/local/bin/', `${root}/usr-local-bin/`)
    .replaceAll('/etc/sam/', `${root}/etc-sam/`)
    .replaceAll('/var/lib/vm-agent', `${root}/var-lib-vm-agent`);
  mkdirSync(join(root, 'usr-local-bin'), { recursive: true });
  return {
    ...box,
    root,
    exec: (env: Record<string, string> = {}) => box.run('/bin/sh', script, env),
  };
}

const lineIndex = (calls: string, needle: string) =>
  calls.split('\n').findIndex((line) => line.includes(needle));

describe('executed tunnel boot sequence', () => {
  it('verifies the connector, writes its token privately and closes ingress before the agent starts', () => {
    const boot = runBootScript(tunnel(), {});
    const result = boot.exec();
    const calls = boot.calls();

    expect(result.status).toBe(0);
    expect(calls).toContain('sha256sum ');
    expect(calls).toMatch(/install -m 0755 .* \S+\/usr-local-bin\/cloudflared/);
    expect(calls).toContain(
      'useradd --system --no-create-home --shell /usr/sbin/nologin sam-cloudflared'
    );
    expect(calls).not.toContain('sam-boot-failure');

    const firewall = lineIndex(calls, 'firewall');
    const agentStart = lineIndex(calls, 'systemctl start vm-agent');
    const connector = lineIndex(calls, 'systemctl enable --now sam-cloudflared.service');
    expect(firewall).toBeGreaterThan(-1);
    expect(agentStart).toBeGreaterThan(firewall);
    expect(connector).toBeGreaterThan(agentStart);

    const tokenPath = join(boot.root, 'etc-sam', 'cloudflared', 'tunnel-token');
    expect(readFileSync(tokenPath, 'utf8')).toBe(TUNNEL_TOKEN);
    expect(statSync(tokenPath).mode & 0o077).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(TUNNEL_TOKEN);
  });

  it.each([
    ['checksum mismatch', { FAKE_SHA: '0'.repeat(64) }, 'cloudflared_install'],
    ['download failure', { CF_CURL_EXIT: '22' }, 'cloudflared_install'],
    ['unsupported architecture', { FAKE_ARCH: 'riscv64' }, 'cloudflared_install'],
    ['firewall failure', { FIREWALL_EXIT: '1' }, 'tunnel_firewall'],
  ])('fails closed on %s: reports and never starts the agent or connector', (_n, env, reason) => {
    const boot = runBootScript(tunnel(), {});
    const result = boot.exec(env);
    const calls = boot.calls();

    expect(result.status).toBe(1);
    expect(calls).toContain(`sam-boot-failure ${reason}`);
    expect(calls).not.toContain('systemctl start vm-agent');
    expect(calls).not.toContain('sam-cloudflared.service');
    if (reason === 'cloudflared_install') {
      expect(calls).not.toMatch(/^install /m);
      expect(calls).not.toContain('firewall');
    }
  });

  it('reports a connector that cannot start', () => {
    const boot = runBootScript(tunnel(), {
      systemctl: 'case "$*" in *sam-cloudflared*) exit 1 ;; esac',
    });
    const result = boot.exec();
    expect(result.status).toBe(1);
    expect(boot.calls()).toContain('sam-boot-failure tunnel_connector');
  });

  it('control: a direct node never installs a connector or touches the tunnel', () => {
    const boot = runBootScript(variables(), {});
    const result = boot.exec();
    const calls = boot.calls();
    expect(result.status).toBe(0);
    expect(calls).toContain('systemctl start vm-agent');
    expect(calls).not.toContain('cloudflared');
    expect(calls).not.toContain('firewall');
  });
});

/** Runs setup-firewall.sh under bash with iptables tooling stubbed. */
function runFirewall(vars: CloudInitVariables, env: Record<string, string> = {}) {
  const box = sandbox({
    // `-C INPUT -j SAM-TUNNEL-INGRESS` reports whether the jump already exists.
    iptables: 'case "$1" in -C) exit "${JUMP_EXIT:-1}" ;; esac',
    ip6tables: 'case "$1" in -C) exit "${JUMP_EXIT:-1}" ;; -L) exit "${IP6_LIST_EXIT:-0}" ;; esac',
    'iptables-restore': 'cat > "$TEST_DIR/restore-v4"; exit "${RESTORE_EXIT:-0}"',
    'ip6tables-restore': 'cat > "$TEST_DIR/restore-v6"',
    'iptables-save': 'true',
    'ip6tables-save': 'true',
    modprobe: 'exit "${MODPROBE_EXIT:-0}"',
    ip: 'printf "%s" "${GLOBAL_IPV6:-}"',
    logger: 'true',
    curl: 'printf "203.0.113.0/24\\n198.51.100.0/24"',
  });
  const script = file(parse(vars), '/etc/sam/firewall/setup-firewall.sh').content.replaceAll(
    '/etc/iptables',
    join(box.dir, 'iptables')
  );
  const result = box.run('/bin/bash', script, env);
  const restored = (family: 'v4' | 'v6') => {
    try {
      return readFileSync(join(box.dir, `restore-${family}`), 'utf8');
    } catch {
      return '';
    }
  };
  return { result, lines: box.calls().split('\n'), calls: box.calls(), restored };
}

const TUNNEL_CHAIN_RULES = [
  '-A SAM-TUNNEL-INGRESS -i lo -j RETURN',
  '-A SAM-TUNNEL-INGRESS -i docker0 -p tcp --dport 8080 -j RETURN',
  '-A SAM-TUNNEL-INGRESS -i br-+ -p tcp --dport 8080 -j RETURN',
  '-A SAM-TUNNEL-INGRESS -p tcp --dport 8080 -j DROP',
  '-A SAM-TUNNEL-INGRESS -p udp --dport 8080 -j DROP',
  '-A SAM-TUNNEL-INGRESS -p tcp --dport 8444 -j DROP',
  '-A SAM-TUNNEL-INGRESS -p udp --dport 8444 -j DROP',
  '-A SAM-TUNNEL-INGRESS -p tcp --dport 22 -j DROP',
];

describe('executed tunnel firewall script', () => {
  it('replaces one chain in a single restore transaction per family, never flushing INPUT', () => {
    const { result, calls, restored } = runFirewall(tunnel());
    expect(result.status).toBe(0);
    for (const family of ['v4', 'v6'] as const) {
      expect(restored(family)).toBe(
        [
          '*filter',
          ':SAM-TUNNEL-INGRESS - [0:0]',
          '-I INPUT 1 -j SAM-TUNNEL-INGRESS',
          ...TUNNEL_CHAIN_RULES,
          'COMMIT',
          '',
        ].join('\n')
      );
    }
    expect(calls).toContain('iptables-restore --noflush');
    expect(calls).toContain('ip6tables-restore --noflush');
    // No flush, policy change or one-by-one rule edits that could open a gap.
    expect(calls).not.toMatch(/ -F| -P| -A | -I | -D /);
    // No public allowlist.
    expect(calls).not.toContain('curl');
  });

  it('re-applies idempotently: an existing INPUT jump is not duplicated', () => {
    const { result, restored } = runFirewall(tunnel(), { JUMP_EXIT: '0' });
    expect(result.status).toBe(0);
    expect(restored('v4')).not.toContain('-I INPUT');
    expect(restored('v4')).toContain(':SAM-TUNNEL-INGRESS - [0:0]');
  });

  it('fails (so the vm-agent cannot start) when the restore transaction fails', () => {
    const { result } = runFirewall(tunnel(), { RESTORE_EXIT: '1' });
    expect(result.status).not.toBe(0);
  });

  it('fails closed when IPv6 is routable but ip6tables is unavailable', () => {
    const { result, calls } = runFirewall(tunnel(), {
      IP6_LIST_EXIT: '1',
      GLOBAL_IPV6: 'inet6 2001:db8::5/64 scope global',
    });
    expect(result.status).toBe(1);
    expect(calls).toContain('refusing');
  });

  it('protects IPv6 when ip6tables works even though modprobe is missing', () => {
    const { result, restored } = runFirewall(tunnel(), { MODPROBE_EXIT: '127' });
    expect(result.status).toBe(0);
    expect(restored('v6')).toContain('-A SAM-TUNNEL-INGRESS -p tcp --dport 8080 -j DROP');
  });

  it('tolerates missing ip6tables on an IPv4-only host', () => {
    const { result, restored } = runFirewall(tunnel(), { IP6_LIST_EXIT: '1' });
    expect(result.status).toBe(0);
    expect(restored('v4')).toContain('-A SAM-TUNNEL-INGRESS -p tcp --dport 8080 -j DROP');
  });

  it('gates every vm-agent start on the firewall in tunnel mode only', () => {
    const tunnelUnit = file(parse(tunnel()), '/etc/systemd/system/vm-agent.service').content;
    expect(tunnelUnit).toContain(
      'ExecStartPre=/etc/sam/firewall/setup-firewall.sh\nExecStart=/usr/local/bin/vm-agent\n'
    );
    const directUnit = file(parse(variables()), '/etc/systemd/system/vm-agent.service').content;
    expect(directUnit).not.toContain('ExecStartPre');
  });

  it('control: direct mode keeps the Cloudflare allowlist and has no tunnel chain', () => {
    const { result, lines, calls } = runFirewall(variables());
    expect(result.status).toBe(0);
    expect(calls).toContain('curl ');
    expect(lines).toContain('iptables -I INPUT 1 -s 203.0.113.0/24 -p tcp --dport 8080 -j ACCEPT');
    expect(calls).not.toContain('SAM-TUNNEL-INGRESS');
    expect(calls).not.toContain('8444');
  });
});

const canUseNetns =
  spawnSync('sudo', ['-n', 'unshare', '-n', 'iptables', '-w', '-L', 'INPUT', '-n'], {
    stdio: 'ignore',
  }).status === 0;

const canUseLegacyNetns =
  canUseNetns &&
  spawnSync('sudo', ['-n', 'unshare', '-n', 'iptables-legacy', '-w', '-L', 'INPUT', '-n'], {
    stdio: 'ignore',
  }).status === 0;

/**
 * iptables-legacy holds the global xtables lock (/run/xtables.lock, shared across network
 * namespaces) for the whole of an `iptables-restore`, including while it reads stdin. A lock
 * taking `iptables` call inside the restore's producer therefore deadlocks. Every call runs
 * under `timeout -s KILL` so a regression fails fast and leaves no process holding the
 * host's lock (which would also hang Docker).
 */
if (!canUseLegacyNetns) {
  console.warn('SKIPPED: tunnel firewall iptables-legacy test needs passwordless sudo + netns');
}
describe.skipIf(!canUseLegacyNetns)('tunnel firewall under iptables-legacy', () => {
  it('applies and re-applies without deadlocking on the xtables lock', () => {
    const box = sandbox({ logger: 'true' });
    for (const [name, target] of [
      ['iptables', 'iptables-legacy'],
      ['iptables-restore', 'iptables-legacy-restore'],
      ['iptables-save', 'iptables-legacy-save'],
      ['ip6tables', 'ip6tables-legacy'],
      ['ip6tables-restore', 'ip6tables-legacy-restore'],
      ['ip6tables-save', 'ip6tables-legacy-save'],
    ]) {
      writeFileSync(join(box.bin, name), `#!/bin/sh\nexec ${target} "$@"\n`, { mode: 0o755 });
    }
    const script = file(parse(tunnel()), '/etc/sam/firewall/setup-firewall.sh').content.replaceAll(
      '/etc/iptables',
      join(box.dir, 'iptables')
    );
    const fw = join(box.dir, 'fw.sh');
    writeFileSync(fw, script, { mode: 0o755 });
    const d = box.dir;
    const driver = `set -e
timeout -s KILL 15 bash ${fw}
timeout -s KILL 15 bash ${fw}
iptables-legacy -w -S > ${d}/v4
ip6tables-legacy -w -S > ${d}/v6 2>/dev/null || true
chown -R ${process.getuid?.() ?? 0} ${d}`;
    const result = spawnSync(
      'sudo',
      ['-n', 'unshare', '-n', 'env', `PATH=${box.bin}:${process.env.PATH}`, 'bash', '-c', driver],
      { encoding: 'utf8', timeout: 45_000 }
    );
    expect(result.status, result.stderr).toBe(0);
    const v4 = readFileSync(join(d, 'v4'), 'utf8');
    expect(v4).toContain('-A INPUT -j SAM-TUNNEL-INGRESS');
    // Re-applied once: the jump is not duplicated.
    expect(v4.match(/-A INPUT -j SAM-TUNNEL-INGRESS/g)).toHaveLength(1);
    expect(v4).toContain('-A SAM-TUNNEL-INGRESS -p tcp -m tcp --dport 8080 -j DROP');
    const v6 = readFileSync(join(d, 'v6'), 'utf8');
    if (v6.includes('SAM-TUNNEL-INGRESS')) {
      expect(v6.match(/-A INPUT -j SAM-TUNNEL-INGRESS/g)).toHaveLength(1);
    }
  }, 60_000);
});

/**
 * Real netfilter in a private network namespace (needs passwordless sudo;
 * skipped elsewhere). A checker loop watches the DROP rule and the INPUT jump
 * while the script is re-applied repeatedly: an atomic replacement never shows
 * a gap, where the previous flush-and-re-add approach would.
 */
describe.skipIf(!canUseNetns)('tunnel firewall against real netfilter', () => {
  it('re-applies without any window where the agent port is unprotected', () => {
    const box = sandbox({ logger: 'true' });
    const script = file(parse(tunnel()), '/etc/sam/firewall/setup-firewall.sh').content.replaceAll(
      '/etc/iptables',
      join(box.dir, 'iptables')
    );
    const fw = join(box.dir, 'fw.sh');
    writeFileSync(fw, script, { mode: 0o755 });
    const d = box.dir;
    const driver = `set -e
bash ${fw}
( while [ ! -e ${d}/stop ]; do
    { iptables -w -C SAM-TUNNEL-INGRESS -p tcp --dport 8080 -j DROP && iptables -w -C INPUT -j SAM-TUNNEL-INGRESS; } 2>/dev/null || echo gap >> ${d}/gaps
  done ) &
for i in $(seq 25); do bash ${fw}; done
touch ${d}/stop; wait
iptables -w -S > ${d}/v4
ip6tables -w -S > ${d}/v6 2>/dev/null || true
chown -R ${process.getuid?.() ?? 0} ${d}`;
    const result = spawnSync(
      'sudo',
      [
        '-n',
        'unshare',
        '-n',
        'env',
        `PATH=${box.bin}:${process.env.PATH}`,
        `TEST_DIR=${d}`,
        'bash',
        '-c',
        driver,
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    expect(result.status, result.stderr).toBe(0);
    let gaps = '';
    try {
      gaps = readFileSync(join(d, 'gaps'), 'utf8');
    } catch {
      gaps = '';
    }
    expect(gaps).toBe('');
    // iptables -S spells the implicit protocol match out; normalize it away.
    const listed = (family: string) =>
      readFileSync(join(d, family), 'utf8')
        .replace(/ -m (tcp|udp)/g, '')
        .split('\n');
    const v4 = listed('v4');
    expect(v4.filter((l) => l === '-A INPUT -j SAM-TUNNEL-INGRESS')).toHaveLength(1);
    for (const rule of TUNNEL_CHAIN_RULES) expect(v4).toContain(rule);
    const v6 = listed('v6');
    for (const rule of TUNNEL_CHAIN_RULES) expect(v6).toContain(rule);
    // This integration check starts real shell/netfilter processes 25 times. Its
    // subprocess has a 60s deadline; Vitest must allow it to finish under CI load.
  }, 75_000);
});

/**
 * Fake clock for the readiness gate: `date +%s` starts at 1000 and every
 * probe (curl) or pause (sleep) advances it by its own duration, so the test
 * observes elapsed-time behaviour without waiting.
 */
function readinessSandbox(curlBody: string) {
  const advance = (seconds: string) =>
    `t=$(cat "$TEST_DIR/clock" 2>/dev/null || echo 1000); echo $((t + ${seconds})) > "$TEST_DIR/clock"`;
  return sandbox({
    date: 'cat "$TEST_DIR/clock" 2>/dev/null || echo 1000',
    // A failing probe spends its whole --max-time ($3).
    curl: `${advance('$3')}\n${curlBody}`,
    sleep: advance('$1'),
    logger: 'true',
  });
}

const waitScript = (overrides?: Partial<CloudInitVariables>) =>
  file(parse(tunnel(overrides)), '/usr/local/sbin/sam-wait-tunnel-listener').content;

describe('executed connector readiness gate', () => {
  it('waits for the loopback tunnel listener before allowing the connector to start', () => {
    const box = readinessSandbox(
      'n=$(cat "$TEST_DIR/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$TEST_DIR/n"; [ "$n" -ge 3 ]'
    );
    const result = box.run('/bin/sh', waitScript());
    expect(result.status).toBe(0);
    expect(box.calls()).toContain(
      'curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8444/health'
    );
    expect(box.calls().match(/^curl /gm)).toHaveLength(3);
    expect(box.calls().match(/^sleep 1$/gm)).toHaveLength(2);
  });

  it('gives up at the elapsed-time deadline, not after a number of attempts', () => {
    // 20s budget; each failed round costs a 5s probe plus a 3s pause, so the
    // deadline passes after the third probe. An attempt counter would make 20.
    const box = readinessSandbox('exit 7');
    const result = box.run(
      '/bin/sh',
      waitScript({
        tunnelListenerWaitSeconds: '20',
        tunnelListenerProbeTimeoutSeconds: '5',
        tunnelListenerProbeIntervalSeconds: '3',
      })
    );
    expect(result.status).toBe(1);
    expect(box.calls().match(/^curl -fsS --max-time 5 /gm)).toHaveLength(3);
    expect(box.calls().match(/^sleep 3$/gm)).toHaveLength(2);
    expect(Number(readFileSync(join(box.dir, 'clock'), 'utf8'))).toBeLessThanOrEqual(1000 + 20 + 5);
  });
});

describe('connector timing settings', () => {
  it('renders the default and configured connector restart delay', () => {
    const unit = (o?: Partial<CloudInitVariables>) =>
      file(parse(tunnel(o)), '/etc/systemd/system/sam-cloudflared.service').content;
    expect(unit()).toContain('RestartSec=5\n');
    expect(unit({ tunnelConnectorRestartSeconds: '17' })).toContain('RestartSec=17\n');
  });

  it('treats empty strings as unset, as env-derived callers pass them', () => {
    const vars = tunnel({
      cloudflareTunnelPort: '',
      cloudflaredVersion: '',
      tunnelListenerWaitSeconds: '',
      tunnelListenerProbeTimeoutSeconds: '',
      tunnelListenerProbeIntervalSeconds: '',
      tunnelConnectorRestartSeconds: '',
    });
    expect(() => validateCloudInitVariables(vars)).not.toThrow();
    const parsed = parse(vars);
    expect(file(parsed, '/etc/systemd/system/sam-cloudflared.service').content).toContain(
      'RestartSec=5\n'
    );
    expect(file(parsed, '/usr/local/sbin/sam-wait-tunnel-listener').content).toContain(
      'http://127.0.0.1:8444/health'
    );
    expect(parsed.runcmd.join('\n')).toContain(`/${DEFAULT_CLOUDFLARED_VERSION}/cloudflared-linux`);
  });

  it.each([
    ['tunnelListenerProbeTimeoutSeconds', '61'],
    ['tunnelListenerProbeIntervalSeconds', '0'],
    ['tunnelConnectorRestartSeconds', '3601'],
    ['tunnelConnectorRestartSeconds', '5s'],
  ] as const)('rejects %s=%s', (name, value) => {
    expect(() => validateCloudInitVariables(tunnel({ [name]: value }))).toThrow(name);
  });
});

describe('executed boot failure helper', () => {
  it('reads the callback token from its file and never logs it', () => {
    const box = sandbox({ curl: 'true', logger: 'true' });
    const tokenFile = join(box.dir, 'callback-token');
    writeFileSync(tokenFile, `${CALLBACK_TOKEN}\n`);
    const script = file(parse(tunnel()), '/usr/local/sbin/sam-boot-failure').content.replaceAll(
      '/etc/sam/callback-token',
      tokenFile
    );
    const result = spawnSync('/bin/sh', ['-c', script, 'sam-boot-failure', 'cloudflared_install'], {
      env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, TEST_DIR: box.dir },
      encoding: 'utf8',
    });
    const calls = box.calls();
    expect(result.status).toBe(0);
    expect(calls).toContain(`Authorization: Bearer ${CALLBACK_TOKEN} `);
    expect(calls).toContain('{"reason":"cloudflared_install"}');
    expect(calls).toContain('https://api.example.com/api/nodes/node-tunnel-1/boot-failure');
    expect(
      calls
        .split('\n')
        .filter((l) => l.startsWith('logger'))
        .join('\n')
    ).not.toContain(CALLBACK_TOKEN);
  });
});
