/**
 * Tests for cloud-init generation.
 *
 * IMPORTANT: TLS certificate tests MUST parse the YAML output and verify
 * the full PEM content survives intact. String `toContain()` checks are
 * NOT sufficient — they hide YAML indentation bugs that truncate certs.
 * See: docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import type { CloudInitVariables } from '../src/generate';
import {
  generateCloudInit,
  indentForYamlBlock,
  validateCloudInitSize,
  validateCloudInitVariables,
} from '../src/generate';

function baseVariables(overrides?: Partial<CloudInitVariables>): CloudInitVariables {
  return {
    nodeId: 'node-test-123',
    hostname: 'sam-test-node',
    controlPlaneUrl: 'https://api.test.example.com',
    jwksUrl: 'https://api.test.example.com/.well-known/jwks.json',
    callbackToken: 'cb-token-abc',
    ...overrides,
  };
}

function runCaddySetupRuncmd(role: 'workspace' | 'deployment') {
  const config = generateCloudInit(baseVariables({ role }), { validateSize: false });
  const parsed = YAML.parse(config) as { runcmd: unknown[] };
  const command = parsed.runcmd.find(
    (entry) => typeof entry === 'string' && entry.includes('Preparing Caddy paths'),
  );
  if (typeof command !== 'string') {
    throw new Error('Rendered cloud-init is missing the Caddy setup runcmd entry');
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'sam-cloud-init-runcmd-'));
  const binDir = join(scratchDir, 'bin');
  const commandLog = join(scratchDir, 'commands.log');
  mkdirSync(binDir);

  for (const executable of ['logger', 'mkdir']) {
    writeFileSync(
      join(binDir, executable),
      `#!/bin/sh\nprintf '%s\\n' "${executable} $*" >> "$COMMAND_LOG"\n`,
      { mode: 0o755 },
    );
  }

  try {
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, COMMAND_LOG: commandLog, PATH: binDir },
    });
    const calls = existsSync(commandLog)
      ? readFileSync(commandLog, 'utf8').trim().split('\n')
      : [];
    return { calls, command, result };
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

/**
 * Realistic multi-line PEM certificate (20 lines of base64, matching real Origin CA output).
 * This catches YAML indentation bugs that single-line test data misses.
 */
const REALISTIC_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIEojCCA4qgAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4wDQYJKoZIhvcNAQEL',
  'BQAwgYsxCzAJBgNVBAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMTQw',
  'MgYDVQQLEytDbG91ZEZsYXJlIE9yaWdpbiBTU0wgQ2VydGlmaWNhdGUgQXV0aG9y',
  'aXR5MRYwFAYDVQQHEw1TYW4gRnJhbmNpc2NvMRMwEQYDVQQIEwpDYWxpZm9ybmlh',
  'MB4XDTI2MDMxMjAwMDAwMFoXDTQxMDMxMjAwMDAwMFowYjEZMBcGA1UEChMQQ2xv',
  'dWRGbGFyZSwgSW5jLjEdMBsGA1UECxMUT3JpZ2luIFB1bGwgQ2VydGlmaWNhdGUx',
  'JjAkBgNVBAMTHSouc2ltcGxlLWFnZW50LW1hbmFnZXIub3JnMIIBIjANBgkqhkiG',
  '9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxvFqof1sMB1yt+eiTk7gSMkJaOWJFx7GCQID',
  'fDs3FtQ2VLJmb0xGKHGFqRN6pbO7SMZP1FQ7kS8pT4oXjqypCkrN0VdFMYqBL7h',
  'T0sBNq3GlC5MIE2AMDDX3BFHL9WYJ8B8U6OV3W5KF6gTQF1wMPn8k3hC+XnRN1a',
  'sL7ceOW4FH7eMvhx8gvFr6RfIZ6XHQD8s0G1xFQS5gJOPUBE1TGZ7K/qf+B4rvy',
  'Q7KR9fGYPIFDY+8uCMNPgSGJzB2mK7Zf3RkR7hZeG0yFQZ3HWOH1bRU8w0xnTPO',
  'J3CKbU8XZjNqMOBz+yz8BDf7lTSGFsNQOgS/8dRFJ8TkM+SjwIDAQABo4IBIjCC',
  'AR4wDgYDVR0PAQH/BAQDAgWgMB0GA1UdJQQWMBQGCCsGAQUFBwMCBggrBgEFBQcD',
  'ATAMBgNVHRMBAf8EAjAAMB0GA1UdDgQWBBT+VRqXXauFSfaEJMOv7oBJl/qzYTAf',
  'BgNVHSMEGDAWgBQk6FNXXXw0QIep65TbuuEWePwppDBABggrBgEFBQcBAQQ0MDIw',
  'MAYIKwYBBQUHMAGGJGh0dHA6Ly9vY3NwLmNsb3VkZmxhcmUuY29tL29yaWdpbl9l',
  'Y2MwJQYDVR0RBB4wHIIaKi5zaW1wbGUtYWdlbnQtbWFuYWdlci5vcmcwOgYDVR0f',
  'BDMwMTAvoC2gK4YpaHR0cDovL2NybC5jbG91ZGZsYXJlLmNvbS9vcmlnaW5fZWNj',
  '-----END CERTIFICATE-----',
].join('\n');

const REALISTIC_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEAxvFqof1sMB1yt+eiTk7gSMkJaOWJFx7GCQIDfDs3FtQ2VLJM',
  'b0xGKHGFqRN6pbO7SMZP1FQ7kS8pT4oXjqypCkrN0VdFMYqBL7hT0sBNq3GlC5M',
  'IE2AMDDX3BFHL9WYJ8B8U6OV3W5KF6gTQF1wMPn8k3hC+XnRN1asL7ceOW4FH7e',
  'MvhxQgvFr6RfIZ6XHQD8s0G1xFQS5gJOPUBE1TGZ7K/qf+B4rvyQ7KR9fGYPIFD',
  'Y+8uCMNPgSGJzB2mK7Zf3RkR7hZeG0yFQZ3HWOH1bRU8w0xnTPOJ3CKbU8XZjNq',
  'MobyHyz8BDf7lTSGFsNQOgS/8dRFJ8TkM+SjwIDAQABAoIBAQCJr7bGFaFmsPlN',
  'F0hIVBjW8dN3VbS4NlD5eHsOWLh7SJFG3FFtxD4ghVk9qZB0XH7H3d/rKL/xxaR',
  'UQgz7DLZKi9q1J6wJpA8+oRNfBq0aGLXFM3KEe+GiPCGq7bDC4pEZ6k+F01MFYQ',
  'Dqm/NBGZB+PsAeKbs+R7iL+qHFNYXHGFax7w7T6B/QfBM7a2Eq7Q1ZDON/Q6Tlx',
  'JGRNfZm0SB0F8YP0cxQ7xVPYWB4j1R7A8OX8yYnP1oFcj5fB7VQTRGFx5WVF7zT',
  '7GVFYJ3p8kqVjGRFqL/6AG8zNn8O0SBN5BLH0ZCMO2NZJ3ReC+O2DwLEiQpLPcj',
  'hGVL7qhBAoGBAPWFx1OB3m2t6sMDOjQY2z4JyJAtp7E1r3hbQ0VEMIhj3pYBXwVG',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const ORIGIN_CA_CERTIFICATE_URL =
  'https://api.test.example.com/api/nodes/node-test-123/origin-ca-certificate';

describe('indentForYamlBlock', () => {
  it('returns empty string unchanged', () => {
    expect(indentForYamlBlock('', 6)).toBe('');
  });

  it('returns single-line string unchanged', () => {
    expect(indentForYamlBlock('hello', 6)).toBe('hello');
  });

  it('indents all lines after the first', () => {
    const input = 'line1\nline2\nline3';
    const result = indentForYamlBlock(input, 4);
    expect(result).toBe('line1\n    line2\n    line3');
  });

  it('preserves existing indentation on subsequent lines', () => {
    const input = 'line1\n  line2';
    const result = indentForYamlBlock(input, 4);
    expect(result).toBe('line1\n      line2');
  });

  it('handles trailing newline', () => {
    const input = 'line1\nline2\n';
    const result = indentForYamlBlock(input, 6);
    expect(result).toBe('line1\n      line2\n      ');
  });
});

describe('generateCloudInit', () => {
  describe('existing variable substitution (regression)', () => {
    it('substitutes all required variables', () => {
      const config = generateCloudInit(baseVariables());

      expect(config).toContain('Environment=NODE_ID=node-test-123');
      expect(config).toContain('Environment=CONTROL_PLANE_URL=https://api.test.example.com');
      expect(config).toContain('Environment=JWKS_ENDPOINT=https://api.test.example.com/.well-known/jwks.json');
      expect(config).toContain('Environment=CALLBACK_TOKEN_FILE=/etc/sam/callback-token');
      expect(config).not.toContain('Environment=CALLBACK_TOKEN=cb-token-abc');
      expect(config).toContain('hostname: sam-test-node');
    });

    it('does not emit empty SSH authorized keys for the workspace user', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const workspaceUser = parsed.users.find((user: { name: string }) => user.name === 'workspace');
      expect(workspaceUser).toBeDefined();
      expect(workspaceUser).not.toHaveProperty('ssh_authorized_keys');
    });

    it('substitutes journald defaults when not provided', () => {
      const config = generateCloudInit(baseVariables());

      expect(config).toContain('SystemMaxUse=500M');
      expect(config).toContain('SystemKeepFree=1G');
      expect(config).toContain('MaxRetentionSec=7day');
    });

    it('substitutes custom journald values', () => {
      const config = generateCloudInit(baseVariables({
        logJournalMaxUse: '1G',
        logJournalKeepFree: '2G',
        logJournalMaxRetention: '14day',
      }));

      expect(config).toContain('SystemMaxUse=1G');
      expect(config).toContain('SystemKeepFree=2G');
      expect(config).toContain('MaxRetentionSec=14day');
    });

    it('preserves docker name tag template syntax', () => {
      const config = generateCloudInit(baseVariables());
      expect(config).toContain('"tag": "docker/{{.Name}}"');
    });

    it('configures default Docker DNS servers for container name resolution', () => {
      const config = generateCloudInit(baseVariables());
      expect(config).toContain('"dns": ["1.1.1.1", "8.8.8.8"]');
    });

    it('substitutes custom Docker DNS servers when provided', () => {
      const config = generateCloudInit(baseVariables({
        dockerDnsServers: '"10.0.0.1", "10.0.0.2"',
      }));
      expect(config).toContain('"dns": ["10.0.0.1", "10.0.0.2"]');
      expect(config).not.toContain('1.1.1.1');
    });
  });

  describe('projectId and chatSessionId substitution', () => {
    it('substitutes projectId and chatSessionId when provided', () => {
      const config = generateCloudInit(baseVariables({
        projectId: 'proj-abc-123',
        chatSessionId: 'sess-def-456',
      }));

      expect(config).toContain('Environment=PROJECT_ID=proj-abc-123');
      expect(config).toContain('Environment=CHAT_SESSION_ID=sess-def-456');
    });

    it('produces empty values when projectId is undefined', () => {
      const config = generateCloudInit(baseVariables());

      expect(config).toContain('Environment=PROJECT_ID=');
      expect(config).toContain('Environment=CHAT_SESSION_ID=');
      expect(config).not.toContain('PROJECT_ID=undefined');
      expect(config).not.toContain('CHAT_SESSION_ID=undefined');
    });

    it('produces empty values when projectId is explicitly undefined', () => {
      const config = generateCloudInit(baseVariables({
        projectId: undefined,
        chatSessionId: undefined,
      }));

      expect(config).toContain('Environment=PROJECT_ID=');
      expect(config).toContain('Environment=CHAT_SESSION_ID=');
      expect(config).not.toContain('undefined');
    });

    it('handles projectId without chatSessionId', () => {
      const config = generateCloudInit(baseVariables({
        projectId: 'proj-only',
      }));

      expect(config).toContain('Environment=PROJECT_ID=proj-only');
      expect(config).toContain('Environment=CHAT_SESSION_ID=');
    });

    it('env vars appear in systemd service section', () => {
      const config = generateCloudInit(baseVariables({
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
      }));

      const serviceSection = config.split('[Service]')[1]?.split('[Install]')[0];
      expect(serviceSection).toBeDefined();
      expect(serviceSection).toContain('Environment=PROJECT_ID=proj-123');
      expect(serviceSection).toContain('Environment=CHAT_SESSION_ID=sess-456');
    });


    it('stores callback token in a root-only file instead of systemd environment', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config.replace(/^#cloud-config\n/, ''));
      const unitFile = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/systemd/system/vm-agent.service'
      );
      const tokenFile = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/callback-token'
      );

      expect(unitFile.content).toContain('Environment=CALLBACK_TOKEN_FILE=/etc/sam/callback-token');
      expect(unitFile.content).not.toContain('CALLBACK_TOKEN=cb-token-abc');
      expect(tokenFile).toMatchObject({
        path: '/etc/sam/callback-token',
        permissions: '0600',
        owner: 'root:root',
      });
      expect(tokenFile.content.trim()).toBe('cb-token-abc');
    });

    it('systemd unit file is in write_files, not a heredoc in runcmd', () => {
      // Regression test: the systemd unit file MUST be in write_files, not created
      // via a bash heredoc in runcmd. Heredocs inside cloud-init YAML block scalars
      // have indented closing delimiters, which bash treats as content (not terminators).
      // This caused the agent to never start on real VMs.
      const config = generateCloudInit(baseVariables());
      const yamlContent = config.replace(/^#cloud-config\n/, '');
      const parsed = YAML.parse(yamlContent);

      // Unit file must exist in write_files
      const unitFile = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/systemd/system/vm-agent.service'
      );
      expect(unitFile).toBeDefined();
      expect(unitFile.content).toContain('[Unit]');
      expect(unitFile.content).toContain('[Service]');
      expect(unitFile.content).toContain('ExecStart=/usr/local/bin/vm-agent');

      // Unit file content must NOT have leading spaces on section headers
      // (cloud-init strips YAML block indentation, so the content should be clean)
      const lines = unitFile.content.split('\n');
      const sectionHeaders = lines.filter((l: string) => l.match(/^\s*\[/));
      for (const header of sectionHeaders) {
        expect(header).toBe(header.trimStart());
      }

      // runcmd must NOT contain any heredoc (cat << or cat <<-)
      const runcmdSection = config.split('runcmd:')[1]?.split('write_files:')[0] ?? '';
      expect(runcmdSection).not.toContain('<<');
      expect(runcmdSection).not.toContain('cat >');

      // runcmd MUST contain systemctl start
      expect(runcmdSection).toContain('systemctl start vm-agent');
    });
  });

  describe('TLS certificate bootstrap', () => {
    it('sets VM_AGENT_PORT=8443 and TLS paths when certificate URL provided', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
      }));

      expect(config).toContain('Environment=VM_AGENT_PORT=8443');
      expect(config).toContain('Environment=TLS_CERT_PATH=/etc/sam/tls/origin-ca.pem');
      expect(config).toContain('Environment=TLS_KEY_PATH=/etc/sam/tls/origin-ca-key.pem');
    });

    it('sets VM_AGENT_PORT=8080 and empty TLS paths when no certificate URL', () => {
      const config = generateCloudInit(baseVariables());

      expect(config).toContain('Environment=VM_AGENT_PORT=8080');
      expect(config).toContain('Environment=TLS_CERT_PATH=');
      expect(config).toContain('Environment=TLS_KEY_PATH=');
    });

    it('generates node-local key with restricted permissions before starting vm-agent', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
      }));
      const parsed = YAML.parse(config);

      const originCaBlock = parsed.runcmd.find(
        (entry: string) => typeof entry === 'string' && entry.includes('ORIGIN_CA_CERTIFICATE_URL=')
      );
      expect(originCaBlock).toContain(`ORIGIN_CA_CERTIFICATE_URL="${ORIGIN_CA_CERTIFICATE_URL}"`);
      expect(originCaBlock).toContain('openssl genrsa -out "$TLS_KEY_PATH" 2048');
      expect(originCaBlock).toContain('chmod 600 "$TLS_KEY_PATH"');
      expect(originCaBlock).toContain('openssl req -new -key "$TLS_KEY_PATH"');
      expect(originCaBlock).toContain('Authorization: Bearer cb-token-abc');
      expect(originCaBlock).toContain('--data-binary "@$TLS_CSR_PATH"');
      expect(parsed.runcmd.indexOf(originCaBlock)).toBeLessThan(
        parsed.runcmd.findIndex(
          (entry: string) => typeof entry === 'string' && entry.includes('systemctl start vm-agent')
        )
      );
    });

    it('fails closed instead of rewriting vm-agent to plaintext when Origin CA bootstrap fails', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
      }));
      const parsed = YAML.parse(config);

      const originCaBlock = parsed.runcmd.find(
        (entry: string) => typeof entry === 'string' && entry.includes('ORIGIN_CA_CERTIFICATE_URL=')
      );
      expect(originCaBlock).toContain('refusing to start vm-agent without TLS');
      expect(originCaBlock).toContain('rm -f "$TLS_CERT_PATH" "$TLS_KEY_PATH" "$TLS_CSR_PATH"');
      expect(originCaBlock).toContain('exit 1');
      expect(originCaBlock).not.toContain('falling back to plaintext mode');
      expect(originCaBlock).not.toContain("sed -i '/^Environment=TLS_CERT_PATH=/d'");
      expect(originCaBlock).not.toContain("sed -i '/^Environment=TLS_KEY_PATH=/d'");
      expect(originCaBlock).not.toContain('Environment=VM_AGENT_PORT=8080');
    });

    it('does not embed static Origin CA cert or private key files in parsed user-data', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
      }));
      const parsed = YAML.parse(config);
      const paths = parsed.write_files.map((f: { path: string }) => f.path);
      expect(paths).not.toContain('/etc/sam/tls/origin-ca.pem');
      expect(paths).not.toContain('/etc/sam/tls/origin-ca-key.pem');
      const keyEntry = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/tls/origin-ca-key.pem'
      );
      expect(keyEntry).toBeUndefined();
      expect(JSON.stringify(parsed)).not.toContain(REALISTIC_KEY);
      expect(JSON.stringify(parsed)).not.toContain(REALISTIC_CERT);
    });

    it('generated YAML is valid and parseable with certificate bootstrap', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
        taskId: 'task-789',
      }));

      const parsed = YAML.parse(config);
      expect(parsed.hostname).toBe('sam-test-node');
      expect(parsed.write_files).toBeDefined();
      expect(parsed.write_files.length).toBeGreaterThanOrEqual(5);
    });

    it('config with TLS bootstrap stays within 32KB limit', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
      }));

      expect(validateCloudInitSize(config)).toBe(true);
    });

    it('handles empty certificate URL gracefully (no TLS mode)', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: '',
      }));

      const parsed = YAML.parse(config);
      expect(parsed.write_files).toBeDefined();
      expect(config).toContain('Environment=VM_AGENT_PORT=8080');
    });
  });

  describe('OS-level firewall configuration', () => {
    it('includes firewall setup script in write_files', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript).toBeDefined();
      expect(firewallScript.permissions).toBe('0755');
      expect(firewallScript.content).toContain('#!/bin/bash');
      // Policy stays ACCEPT — we rely on explicit per-port DROP rules so
      // outbound reply packets never depend on conntrack state.
      expect(firewallScript.content).toContain('iptables -P INPUT ACCEPT');
      expect(firewallScript.content).toContain('ip6tables -P INPUT ACCEPT');
      expect(firewallScript.content).not.toContain('iptables -P INPUT DROP');
      expect(firewallScript.content).not.toContain('ip6tables -P INPUT DROP');
    });

    it('firewall script contains correct VM agent port (TLS mode)', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
      }));
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('VM_AGENT_PORT="8443"');
    });

    it('firewall script contains correct VM agent port (no TLS mode)', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('VM_AGENT_PORT="8080"');
    });

    it('firewall script allows loopback and Docker bridge traffic', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content = firewallScript.content;
      // Trusted interfaces are INSERTed (-I) at position 1 so they take priority
      // over the port-level DROP rules.
      expect(content).toContain('iptables -I INPUT 1 -i lo -j ACCEPT');
      expect(content).toContain('iptables -I INPUT 1 -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      expect(content).toContain('iptables -I INPUT 1 -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      // No conntrack ESTABLISHED,RELATED dependency — policy ACCEPT means
      // outbound reply packets don't need a state entry to come back.
      expect(content).not.toContain('conntrack --ctstate ESTABLISHED,RELATED');
    });

    it('firewall script installs targeted DROP rules for VM_AGENT_PORT (TCP and UDP) and SSH', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // TCP drop on agent port (primary rule)
      expect(content).toContain('iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      expect(content).toContain('ip6tables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      // UDP drop on agent port (blocks ICMP-unreachable-based port fingerprinting)
      expect(content).toContain('iptables -A INPUT -p udp --dport "$VM_AGENT_PORT" -j DROP');
      expect(content).toContain('ip6tables -A INPUT -p udp --dport "$VM_AGENT_PORT" -j DROP');
      // SSH defense-in-depth — Hetzner cloud firewall is primary gate, but
      // explicit DROP protects against Hetzner-firewall misconfig.
      expect(content).toContain('iptables -A INPUT -p tcp --dport 22 -j DROP');
      expect(content).toContain('ip6tables -A INPUT -p tcp --dport 22 -j DROP');
    });

    it('firewall script installs DROP rules before ACCEPT inserts (race-window eliminated)', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // After -F INPUT flush, the DROP on the agent port must appear before
      // any CF ACCEPT INSERTs. This closes the window where the port would
      // be reachable between policy-ACCEPT and final DROP rule installation.
      const flushIdx = content.indexOf('iptables -F INPUT');
      const dropIdx = content.indexOf('iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      const cfInsertIdx = content.indexOf(
        'iptables -I INPUT 1 -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT'
      );
      expect(flushIdx).toBeGreaterThan(-1);
      expect(dropIdx).toBeGreaterThan(flushIdx);
      expect(cfInsertIdx).toBeGreaterThan(dropIdx);
    });

    it('firewall script carries no OCI receiver port plumbing', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;

      // The host-side build flow replaced the in-VM OCI receiver entirely, so no
      // firewall rules or port variable for it should remain.
      expect(content).not.toContain('OCI_RECEIVER_PORT');
    });

    it('firewall script fetches Cloudflare IPs with fallback defaults', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content = firewallScript.content;
      // Dynamic fetch URLs
      expect(content).toContain('https://www.cloudflare.com/ips-v4');
      expect(content).toContain('https://www.cloudflare.com/ips-v6');
      // Fallback IPv4 ranges
      expect(content).toContain('173.245.48.0/20');
      expect(content).toContain('104.16.0.0/13');
      // Fallback IPv6 ranges
      expect(content).toContain('2400:cb00::/32');
      expect(content).toContain('2606:4700::/32');
    });

    it('firewall script persists rules across reboots', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('iptables-save > /etc/iptables/rules.v4');
      expect(firewallScript.content).toContain('ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true');
    });

    it('writes valid placeholder iptables persistence files before firewall setup runs', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      for (const path of ['/etc/iptables/rules.v4', '/etc/iptables/rules.v6']) {
        const rulesFile = parsed.write_files.find((f: { path: string }) => f.path === path);
        expect(rulesFile).toBeDefined();
        expect(rulesFile.permissions).toBe('0644');
        expect(rulesFile.content).toContain('*filter');
        expect(rulesFile.content).toContain(':INPUT ACCEPT [0:0]');
        expect(rulesFile.content).toContain('COMMIT');
      }
    });

    it('includes daily cron job for Cloudflare IP refresh', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const cronJob = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/cron.daily/update-cloudflare-firewall'
      );
      expect(cronJob).toBeDefined();
      expect(cronJob.permissions).toBe('0755');
      expect(cronJob.content).toContain('/etc/sam/firewall/setup-firewall.sh');
    });

    // NOTE: Firewall install and setup are now handled by the vm-agent's
    // provision package, not cloud-init runcmd. The firewall script is still
    // written to disk via write_files for the agent to execute.

    it('firewall script uses custom vmAgentPort override', () => {
      const config = generateCloudInit(baseVariables({ vmAgentPort: '9999' }));
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('VM_AGENT_PORT="9999"');
    });

    it('firewall script does not allow SSH or unrestricted inbound access', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // No unrestricted ACCEPT rules
      expect(content).not.toMatch(/iptables -A INPUT -j ACCEPT/);
      expect(content).not.toMatch(/ip6tables -A INPUT -j ACCEPT/);
      // No ACCEPT rule for SSH (port 22) — Hetzner cloud firewall gates SSH.
      // The host firewall DROPs port 22 as defense-in-depth, so `--dport 22`
      // DOES appear in a DROP rule; the forbidden pattern is an ACCEPT on 22.
      expect(content).not.toMatch(/--dport 22\b[^\n]*-j ACCEPT/);
      expect(content).not.toMatch(/--dport ssh\b[^\n]*-j ACCEPT/);
      // Defense-in-depth DROP for SSH must be present on both families.
      expect(content).toMatch(/iptables -A INPUT -p tcp --dport 22 -j DROP/);
      expect(content).toMatch(/ip6tables -A INPUT -p tcp --dport 22 -j DROP/);
    });

    it('IPv6 firewall rules mirror IPv4 structure', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // Trusted-interface ACCEPTs are INSERTED at position 1 so they take
      // priority over the targeted DROP rules appended earlier.
      expect(content).toContain('ip6tables -I INPUT 1 -i lo -j ACCEPT');
      expect(content).toContain('ip6tables -I INPUT 1 -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      expect(content).toContain('ip6tables -I INPUT 1 -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      // Policy stays ACCEPT; targeted DROP on VM_AGENT_PORT does the restriction.
      expect(content).toContain('ip6tables -P INPUT ACCEPT');
      expect(content).toContain('ip6tables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      expect(content).not.toContain('ip6tables -P INPUT DROP');
    });

    it('firewall script uses set -euo pipefail and does NOT clamp policy to DROP on exit', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      expect(content).toContain('set -euo pipefail');
      // The previous implementation had `trap 'iptables -P INPUT DROP ...' EXIT`
      // which could leave the box in total blackout if the script errored
      // before ACCEPT rules were added. That landmine MUST not be present.
      expect(content).not.toMatch(/trap\s+'[^']*iptables[^']*-P\s+INPUT\s+DROP/);
      expect(content).not.toMatch(/trap\s+'[^']*ip6tables[^']*-P\s+INPUT\s+DROP/);
    });

    // NOTE: debconf preseed is now handled by vm-agent provision package.

    it('config with firewall stays within 32KB Hetzner limit', () => {
      const config = generateCloudInit(baseVariables({
        originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
        taskId: 'task-789',
      }));

      expect(validateCloudInitSize(config)).toBe(true);
    });
  });

  describe('ephemeral VM stability', () => {
    it('disables apt-daily and unattended-upgrades timers in runcmd before vm-agent start', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);
      const runcmd: string[] = parsed.runcmd;

      // Timer disables must be present
      const timerDisableIdx = runcmd.findIndex(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('apt-daily.timer')
      );
      const agentStartIdx = runcmd.findIndex(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('systemctl start vm-agent')
      );
      expect(timerDisableIdx).toBeGreaterThan(-1);
      expect(agentStartIdx).toBeGreaterThan(-1);
      expect(timerDisableIdx).toBeLessThan(agentStartIdx);

      // Both timer commands must be present
      expect(runcmd[timerDisableIdx]).toContain('apt-daily.timer apt-daily-upgrade.timer');
      const unattendedIdx = runcmd.findIndex(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('unattended-upgrades')
      );
      expect(unattendedIdx).toBeGreaterThan(-1);
      expect(unattendedIdx).toBeLessThan(agentStartIdx);
    });

    it('timer disables use || true to not fail if services are already absent', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);
      const runcmd: string[] = parsed.runcmd;

      // Both commands should have || true fallback
      const timerCmd = runcmd.find(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('apt-daily.timer')
      );
      const unattendedCmd = runcmd.find(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('unattended-upgrades')
      );
      expect(timerCmd).toContain('|| true');
      expect(unattendedCmd).toContain('|| true');
    });

    it('clears root password expiry before vm-agent start so root cron can run', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);
      const runcmd: string[] = parsed.runcmd;

      const rootExpiryIdx = runcmd.findIndex(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('chage') && cmd.includes('root')
      );
      const agentStartIdx = runcmd.findIndex(
        (cmd: string) => typeof cmd === 'string' && cmd.includes('systemctl start vm-agent')
      );

      expect(rootExpiryIdx).toBeGreaterThan(-1);
      expect(agentStartIdx).toBeGreaterThan(-1);
      expect(rootExpiryIdx).toBeLessThan(agentStartIdx);
      expect(runcmd[rootExpiryIdx]).toContain('-E -1');
      expect(runcmd[rootExpiryIdx]).toContain('-M -1');
      expect(runcmd[rootExpiryIdx]).toContain('|| true');
    });
  });

  describe('IPv6 firewall module loading', () => {
    it('firewall script loads ip6_tables kernel module before ip6tables commands', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;

      // Must load the kernel module
      expect(content).toContain('modprobe ip6_tables');

      // modprobe must appear before ip6tables commands
      const modprobeIdx = content.indexOf('modprobe ip6_tables');
      const ip6tablesIdx = content.indexOf('ip6tables -P INPUT ACCEPT');
      expect(modprobeIdx).toBeGreaterThan(-1);
      expect(ip6tablesIdx).toBeGreaterThan(-1);
      expect(modprobeIdx).toBeLessThan(ip6tablesIdx);
    });

    it('firewall script gracefully skips IPv6 when kernel module is unavailable', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;

      // IPv6 block must be conditional
      expect(content).toContain('if modprobe ip6_tables');
      // Fallback log message when IPv6 is unavailable
      expect(content).toContain('ip6tables unavailable');
    });

    it('ip6tables DROP/ACCEPT rules are inside the modprobe conditional, not unconditional', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;

      // All ip6tables rules must appear between the 'if modprobe' guard and the 'else' branch
      const ifStart = content.indexOf('if modprobe ip6_tables');
      const elseIdx = content.indexOf('ip6tables unavailable');
      expect(ifStart).toBeGreaterThan(-1);
      expect(elseIdx).toBeGreaterThan(ifStart);

      // IPv6 DROP rules must be inside the conditional block (between if and else)
      const dropIdx = content.indexOf('ip6tables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      expect(dropIdx).toBeGreaterThan(ifStart);
      expect(dropIdx).toBeLessThan(elseIdx);

      // IPv6 ACCEPT rules must also be inside the conditional block
      const acceptIdx = content.indexOf('ip6tables -I INPUT 1 -i lo -j ACCEPT');
      expect(acceptIdx).toBeGreaterThan(ifStart);
      expect(acceptIdx).toBeLessThan(elseIdx);
    });

    it('ip6tables-save handles missing IPv6 support gracefully', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;

      // ip6tables-save should have error suppression
      expect(content).toContain('ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true');
    });
  });

  describe('cloud metadata API blocking', () => {
    it('dedicated metadata block script contains IPv4 DOCKER-USER chain rules', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const metadataScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/apply-metadata-block.sh'
      );
      expect(metadataScript).toBeDefined();
      expect(metadataScript.permissions).toBe('0755');
      const content: string = metadataScript.content;
      // IPv4 only — metadata API is 169.254.169.254, ip6tables rejects IPv4 addresses
      expect(content).toContain('iptables -I DOCKER-USER 1 -d "$METADATA_IP" -j DROP');
      // No ip6tables commands (only comments may mention it)
      expect(content).not.toMatch(/^\s*ip6tables\s/m);
    });

    it('metadata block script uses delete-then-insert for idempotency', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const metadataScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/apply-metadata-block.sh'
      );
      const content: string = metadataScript.content;
      const deleteIdx = content.indexOf('iptables -D DOCKER-USER -d "$METADATA_IP"');
      const insertIdx = content.indexOf('iptables -I DOCKER-USER 1 -d "$METADATA_IP"');
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(insertIdx).toBeGreaterThan(-1);
      // Delete must come before insert for idempotency
      expect(deleteIdx).toBeLessThan(insertIdx);
      // Delete ignores error if rule doesn't exist yet
      expect(content).toContain('iptables -D DOCKER-USER -d "$METADATA_IP" -j DROP 2>/dev/null || true');
    });

    it('metadata block script uses METADATA_IP variable for the well-known endpoint', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const metadataScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/apply-metadata-block.sh'
      );
      expect(metadataScript.content).toContain('METADATA_IP="169.254.169.254"');
    });

    it('firewall script defers metadata blocking until Docker restart', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      expect(content).not.toContain('DOCKER_USER_WAIT');
      expect(content).not.toContain('/etc/sam/firewall/apply-metadata-block.sh');
      expect(content).toContain('metadata API block deferred until Docker restart');
    });

    it('firewall persistence happens without early metadata block warnings', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      const saveIdx = content.indexOf('iptables-save');
      expect(saveIdx).toBeGreaterThan(-1);
      expect(content).not.toContain('DOCKER-USER chain not available after 30s');
    });

    it('firewall log message mentions metadata API blocking', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('metadata API block deferred until Docker restart');
    });

    it('systemd unit ensures metadata block survives Docker restarts', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const unit = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/systemd/system/sam-metadata-block.service'
      );
      expect(unit).toBeDefined();
      const content: string = unit.content;
      expect(content).toContain('After=docker.service');
      expect(content).toContain('Requires=docker.service');
      expect(content).toContain('PartOf=docker.service');
      expect(content).toContain('ExecStart=/etc/sam/firewall/apply-metadata-block.sh');
      expect(content).toContain('Type=oneshot');
      expect(content).toContain('RemainAfterExit=yes');
    });

    // NOTE: metadata block service enable is now handled by vm-agent provision package.
  });

  // TLS key permission hardening is now handled by vm-agent provision package.

  describe('no template placeholders remain', () => {
    it('all {{ ... }} placeholders are replaced', () => {
      const config = generateCloudInit(baseVariables({
        projectId: 'proj-test',
        chatSessionId: 'sess-test',
      }));

      const remaining = config.match(/\{\{[^.][^}]*\}\}/g);
      expect(remaining).toBeNull();
    });
  });
});

describe('validateCloudInitSize', () => {
  it('accepts config within 32KB limit', () => {
    const config = generateCloudInit(baseVariables({
      projectId: 'proj-abc-123',
      chatSessionId: 'sess-def-456',
    }));

    expect(validateCloudInitSize(config)).toBe(true);
  });

  it('rejects config exceeding 32KB limit', () => {
    const hugeConfig = 'x'.repeat(33 * 1024);
    expect(validateCloudInitSize(hugeConfig)).toBe(false);
  });

  it('config with all variables set stays within 32KB', () => {
    const config = generateCloudInit(baseVariables({
      projectId: 'proj-' + 'a'.repeat(100),
      chatSessionId: 'sess-' + 'b'.repeat(100),
      logJournalMaxUse: '2G',
      logJournalKeepFree: '4G',
      logJournalMaxRetention: '30day',
    }));

    expect(validateCloudInitSize(config)).toBe(true);
  });
});

describe('validateCloudInitVariables', () => {
  describe('accepts valid inputs', () => {
    it('accepts realistic production values', () => {
      expect(() => validateCloudInitVariables(baseVariables())).not.toThrow();
    });

    it('accepts ULID-style nodeId (uppercase alphanumeric)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: '01HXYZ9ABC123DEF456',
      }))).not.toThrow();
    });

    it('accepts lowercase nodeId with hyphens', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: 'node-abc-123',
      }))).not.toThrow();
    });

    it('accepts hostname with dots (FQDN style)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'node-abc.sammy.party',
      }))).not.toThrow();
    });

    it('accepts all optional fields with valid values', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        projectId: 'proj-abc-123',
        chatSessionId: 'sess-def-456',
        taskId: 'task-ghi-789',
        taskMode: 'conversation',
        vmAgentPort: '8443',
        cfIpFetchTimeout: '30',
        logJournalMaxUse: '1G',
        logJournalKeepFree: '2G',
        logJournalMaxRetention: '14day',
        dockerDnsServers: '"10.0.0.1", "10.0.0.2"',
        devcontainerCacheEnabled: 'true',
        deployAcmeEmail: 'ops@example.com',
        deployAcmeCa: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        deployComposeCmd: '/usr/local/bin/docker compose',
        deployHealthTimeout: '1m30s',
      }))).not.toThrow();
    });

    it('accepts omitted optional fields', () => {
      expect(() => validateCloudInitVariables(baseVariables())).not.toThrow();
    });

    it('accepts empty string for optional ID fields', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        projectId: '',
        chatSessionId: '',
        taskId: '',
      }))).not.toThrow();
    });

    it('accepts valid port numbers at boundaries', () => {
      expect(() => validateCloudInitVariables(baseVariables({ vmAgentPort: '1' }))).not.toThrow();
      expect(() => validateCloudInitVariables(baseVariables({ vmAgentPort: '65535' }))).not.toThrow();
      expect(() => validateCloudInitVariables(baseVariables({ vmAgentPort: '8080' }))).not.toThrow();
      expect(() => validateCloudInitVariables(baseVariables({ vmAgentPort: '8443' }))).not.toThrow();
    });

    it('accepts all valid journald time units', () => {
      for (const unit of ['us', 'ms', 's', 'min', 'h', 'day', 'week', 'month', 'year']) {
        expect(() => validateCloudInitVariables(baseVariables({
          logJournalMaxRetention: `7${unit}`,
        }))).not.toThrow();
      }
    });

    it('accepts all valid journald size suffixes', () => {
      for (const suffix of ['K', 'M', 'G', 'T', '']) {
        expect(() => validateCloudInitVariables(baseVariables({
          logJournalMaxUse: `500${suffix}`,
        }))).not.toThrow();
      }
    });

    it('accepts JWT-style callbackToken', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        callbackToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJub2RlLTEyMyJ9.signature_base64',
      }))).not.toThrow();
    });
  });

  describe('rejects shell metacharacters', () => {
    it('rejects nodeId with command substitution', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: '$(rm -rf /)',
      }))).toThrow('nodeId');
    });

    it('rejects nodeId with backtick injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: '`whoami`',
      }))).toThrow('nodeId');
    });

    it('rejects nodeId with semicolon command chaining', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: 'valid; rm -rf /',
      }))).toThrow('nodeId');
    });

    it('rejects nodeId with pipe', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: 'valid|cat /etc/passwd',
      }))).toThrow('nodeId');
    });

    it('rejects hostname with newline injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'valid\nmalicious',
      }))).toThrow('hostname');
    });

    it('rejects hostname with spaces', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'valid host',
      }))).toThrow('hostname');
    });

    it('rejects callbackToken with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        callbackToken: 'token; rm -rf /',
      }))).toThrow('callbackToken');
    });

    it('rejects projectId with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        projectId: 'proj$(cmd)',
      }))).toThrow('projectId');
    });

    it('rejects dockerDnsServers with shell injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"1.1.1.1"; rm -rf /',
      }))).toThrow('dockerDnsServers');
    });

    it('rejects deployment compose command shell injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        deployComposeCmd: 'docker compose; curl https://example.com/x | sh',
      }))).toThrow('deployComposeCmd');
    });

    it('rejects deployment ACME email newline injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        deployAcmeEmail: 'ops@example.com\nEnvironment=DEPLOY_COMPOSE_CMD=sh',
      }))).toThrow('deployAcmeEmail');
    });
  });

  describe('rejects invalid formats', () => {
    it('rejects empty nodeId', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: '',
      }))).toThrow('nodeId');
    });

    it('rejects empty hostname', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: '',
      }))).toThrow('hostname');
    });

    it('rejects empty controlPlaneUrl', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: '',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects HTTP (non-HTTPS) controlPlaneUrl', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'http://api.example.com',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects HTTP (non-HTTPS) deployAcmeCa', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        deployAcmeCa: 'http://acme.example.com/directory',
      }))).toThrow('deployAcmeCa');
    });

    it('rejects invalid deployAcmeEmail', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        deployAcmeEmail: 'not-an-email',
      }))).toThrow('deployAcmeEmail');
    });

    it('rejects invalid deployHealthTimeout', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        deployHealthTimeout: 'five minutes',
      }))).toThrow('deployHealthTimeout');
    });

    it('rejects vmAgentPort of 0', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        vmAgentPort: '0',
      }))).toThrow('vmAgentPort');
    });

    it('rejects vmAgentPort above 65535', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        vmAgentPort: '70000',
      }))).toThrow('vmAgentPort');
    });

    it('rejects non-numeric vmAgentPort', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        vmAgentPort: 'abc',
      }))).toThrow('vmAgentPort');
    });

    it('rejects invalid taskMode', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        taskMode: 'invalid',
      }))).toThrow('taskMode');
    });

    it('rejects invalid logJournalMaxUse format', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalMaxUse: '500MB',
      }))).toThrow('logJournalMaxUse');
    });

    it('rejects invalid logJournalMaxRetention format', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalMaxRetention: '7days',
      }))).toThrow('logJournalMaxRetention');
    });
  });

  describe('edge cases', () => {
    it('rejects nodeId with Unicode characters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: 'node-\u00e9\u00e8',
      }))).toThrow('nodeId');
    });

    it('rejects nodeId with null bytes', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        nodeId: 'node\x00id',
      }))).toThrow('nodeId');
    });

    it('rejects hostname with path traversal', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: '../../../etc/passwd',
      }))).toThrow('hostname');
    });

    it('rejects controlPlaneUrl with YAML injection', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'https://api.example.com\n  malicious_key: value',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects controlPlaneUrl with dollar sign (systemd expansion risk)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'https://api.example.com/$HOME/path',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects controlPlaneUrl with single-quote', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: "https://api.example.com/it's",
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects unquoted DNS server values', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '1.1.1.1',
      }))).toThrow('dockerDnsServers');
    });

    it('rejects DNS server with invalid octet count', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"1.1.1"',
      }))).toThrow('dockerDnsServers');
    });

    it('accepts properly quoted DNS servers', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"10.0.0.1", "10.0.0.2"',
      }))).not.toThrow();
    });

    it('accepts single properly quoted DNS server', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"1.1.1.1"',
      }))).not.toThrow();
    });

    it('rejects DNS server values with invalid IPv4 octets', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"999.999.999.999"',
      }))).toThrow('dockerDnsServers');
    });

    it('rejects non-string JSON values in Docker DNS servers', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        dockerDnsServers: '"1.1.1.1", 8',
      }))).toThrow('dockerDnsServers');
    });

    it('collects multiple validation errors', () => {
      try {
        validateCloudInitVariables({
          nodeId: '',
          hostname: '',
          controlPlaneUrl: '',
          jwksUrl: '',
          callbackToken: '',
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('nodeId');
        expect(msg).toContain('hostname');
        expect(msg).toContain('controlPlaneUrl');
        expect(msg).toContain('jwksUrl');
        expect(msg).toContain('callbackToken');
      }
    });

  });

  describe('generateCloudInit calls validation', () => {
    it('throws on invalid nodeId before generating config', () => {
      expect(() => generateCloudInit(baseVariables({
        nodeId: '$(rm -rf /)',
      }))).toThrow('nodeId');
    });

    it('succeeds with valid variables', () => {
      const config = generateCloudInit(baseVariables());
      expect(config).toContain('hostname: sam-test-node');
    });
  });

  // ---------------------------------------------------------------------------
  // Additional tests for gaps identified during security review
  // ---------------------------------------------------------------------------

  describe('URL field shell injection vectors', () => {
    // control_plane_url is embedded inside a double-quoted shell string in the
    // cloud-init runcmd (template line 45):
    //   curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download..."
    // In bash, $() and $VAR inside double quotes are expanded. SAFE_URL_RE correctly
    // excludes $ from its character class, so these vectors are rejected.

    it('rejects controlPlaneUrl with $ (prevents variable expansion in double-quoted shell arg)', () => {
      // control_plane_url is embedded in: curl ... "{{ control_plane_url }}/api/agent/..."
      // In bash, $VAR inside double quotes is expanded. SAFE_URL_RE has no $ in its
      // character class, so dollar-sign values are correctly rejected.
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'https://api.example.com/$PATH',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects controlPlaneUrl with $() (prevents command substitution in shell context)', () => {
      // $(id) in a double-quoted bash string causes command substitution — RCE.
      // SAFE_URL_RE correctly rejects this because $ is not in the character class.
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'https://api.example.com/$(id)',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects controlPlaneUrl with backtick injection', () => {
      // Backticks are not in SAFE_URL_RE, so this is already rejected.
      expect(() => validateCloudInitVariables(baseVariables({
        controlPlaneUrl: 'https://api.example.com/`id`',
      }))).toThrow('controlPlaneUrl');
    });

    it('rejects jwksUrl with shell metacharacters', () => {
      // jwksUrl is also embedded in the systemd unit (inside single-quoted heredoc,
      // so lower risk there) but the regex is the same as controlPlaneUrl.
      expect(() => validateCloudInitVariables(baseVariables({
        jwksUrl: 'https://api.example.com/path`id`',
      }))).toThrow('jwksUrl');
    });

    it('rejects jwksUrl that is HTTP (non-HTTPS)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        jwksUrl: 'http://api.example.com/.well-known/jwks.json',
      }))).toThrow('jwksUrl');
    });

    it('rejects jwksUrl that is empty', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        jwksUrl: '',
      }))).toThrow('jwksUrl');
    });
  });

  describe('hostname format edge cases', () => {
    // SAFE_HOSTNAME_RE (/^[a-zA-Z0-9.-]+$/) allows leading/trailing dots, which
    // produce invalid hostnames. cloud-init will accept them but the resulting
    // hostname is non-conforming. These tests document the current behaviour.
    it('currently accepts leading-dot hostname (invalid per RFC 1123, documents known gap)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: '.invalid-hostname',
      }))).not.toThrow();
    });

    it('currently accepts trailing-dot hostname (invalid per RFC 1123, documents known gap)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'hostname.',
      }))).not.toThrow();
    });

    it('rejects hostname with shell special characters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'host$(cmd)',
      }))).toThrow('hostname');
    });

    it('rejects hostname with ampersand', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        hostname: 'host&evil',
      }))).toThrow('hostname');
    });
  });

  describe('optional ID fields shell injection coverage', () => {
    // projectId already has a test; these cover the other SAFE_ID_RE fields.
    it('rejects chatSessionId with command substitution', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        chatSessionId: '$(id)',
      }))).toThrow('chatSessionId');
    });

    it('rejects chatSessionId with semicolon chaining', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        chatSessionId: 'sess; rm -rf /',
      }))).toThrow('chatSessionId');
    });

    it('rejects taskId with command substitution', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        taskId: '$(id)',
      }))).toThrow('taskId');
    });

    it('rejects taskId with pipe', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        taskId: 'task|cat /etc/passwd',
      }))).toThrow('taskId');
    });
  });

  describe('journald field coverage', () => {
    it('rejects logJournalKeepFree with invalid format', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalKeepFree: '500MB',
      }))).toThrow('logJournalKeepFree');
    });

    it('rejects logJournalKeepFree with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalKeepFree: '500M; rm -rf /',
      }))).toThrow('logJournalKeepFree');
    });

    it('rejects logJournalMaxUse with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalMaxUse: '1G$(id)',
      }))).toThrow('logJournalMaxUse');
    });

    it('rejects logJournalMaxRetention with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        logJournalMaxRetention: '7day; echo pwned',
      }))).toThrow('logJournalMaxRetention');
    });
  });

  describe('cfIpFetchTimeout edge cases', () => {
    it('rejects cfIpFetchTimeout of zero', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        cfIpFetchTimeout: '0',
      }))).toThrow('cfIpFetchTimeout');
    });

    it('rejects cfIpFetchTimeout with decimal point', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        cfIpFetchTimeout: '30.5',
      }))).toThrow('cfIpFetchTimeout');
    });

    it('rejects cfIpFetchTimeout with shell metacharacters', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        cfIpFetchTimeout: '30; rm -rf /',
      }))).toThrow('cfIpFetchTimeout');
    });
  });

});

describe('validateCloudInitVariables — devcontainer cache flag', () => {
  it('accepts explicit boolean strings', () => {
    expect(() => validateCloudInitVariables(baseVariables({
      devcontainerCacheEnabled: 'true',
    }))).not.toThrow();
    expect(() => validateCloudInitVariables(baseVariables({
      devcontainerCacheEnabled: 'false',
    }))).not.toThrow();
  });

  it('accepts omitted and empty values', () => {
    expect(() => validateCloudInitVariables(baseVariables({
      devcontainerCacheEnabled: undefined,
    }))).not.toThrow();
    expect(() => validateCloudInitVariables(baseVariables({
      devcontainerCacheEnabled: '',
    }))).not.toThrow();
  });

  it('rejects non-boolean devcontainer cache values before systemd injection', () => {
    expect(() => validateCloudInitVariables(baseVariables({
      devcontainerCacheEnabled: 'yes; systemctl stop vm-agent',
    }))).toThrow('devcontainerCacheEnabled');
  });
});

describe('regex injection prevention ($-pattern in replacement values)', () => {
  /**
   * String.prototype.replace() treats $&, $', $` as special patterns in string
   * replacements. The fix uses function replacement (() => value) to prevent this.
   *
   * Note: PEM base64 content cannot naturally contain $ characters, so the PEM
   * round-trip tests above do not exercise this specific fix. The docker_name_tag
   * replacement '{{.Name}}' doesn't contain $ either. The function replacement
   * fix is a defensive measure against future fields that might contain $.
   *
   * We verify the fix by testing that the replacement function approach is used
   * (checking that known $-pattern-sensitive template text is correctly output)
   * and by verifying generated template literals survive intact.
   */

  it('does not embed static PEM material during replacement', () => {
    const config = generateCloudInit(baseVariables({
      originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
    }));

    const parsed = YAML.parse(config);
    expect(JSON.stringify(parsed)).not.toContain(REALISTIC_CERT);
    expect(JSON.stringify(parsed)).not.toContain(REALISTIC_KEY);
  });

  it('docker_name_tag template {{.Name}} survives replacement', () => {
    const config = generateCloudInit(baseVariables());
    expect(config).toContain('"tag": "docker/{{.Name}}"');
  });
});

describe('provider field and apt mirror configuration', () => {
  it('substitutes PROVIDER env var in systemd service when provider is set', () => {
    const config = generateCloudInit(baseVariables({ provider: 'hetzner' }));
    expect(config).toContain('Environment=PROVIDER=hetzner');
  });

  it('produces empty PROVIDER env var when provider is undefined', () => {
    const config = generateCloudInit(baseVariables());
    expect(config).toContain('Environment=PROVIDER=');
    expect(config).not.toContain('PROVIDER=undefined');
  });

  it('includes apt retry configuration in write_files', () => {
    const config = generateCloudInit(baseVariables());
    const parsed = YAML.parse(config);

    const aptRetry = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/apt/apt.conf.d/80-retries'
    );
    expect(aptRetry).toBeDefined();
    expect(aptRetry.content).toContain('Acquire::Retries "3"');
    expect(aptRetry.content).toContain('Acquire::http::Timeout "30"');
    expect(aptRetry.content).toContain('Acquire::https::Timeout "30"');
  });

  it('includes provider-specific apt mirror script in write_files', () => {
    const config = generateCloudInit(baseVariables({ provider: 'hetzner' }));
    const parsed = YAML.parse(config);

    const mirrorScript = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sam/apt-mirror-config.sh'
    );
    expect(mirrorScript).toBeDefined();
    expect(mirrorScript.permissions).toBe('0755');
    expect(mirrorScript.content).toContain('PROVIDER="hetzner"');
    expect(mirrorScript.content).toContain('APT_MIRROR="mirror.hetzner.com"');
  });

  it('apt mirror script sets empty APT_MIRROR for non-hetzner providers', () => {
    const config = generateCloudInit(baseVariables({ provider: 'scaleway' }));
    const parsed = YAML.parse(config);

    const mirrorScript = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sam/apt-mirror-config.sh'
    );
    expect(mirrorScript).toBeDefined();
    expect(mirrorScript.content).toContain('PROVIDER="scaleway"');
    // The default case sets APT_MIRROR=""
    expect(mirrorScript.content).toContain('APT_MIRROR=""');
  });

  it('apt mirror script sets empty PROVIDER when provider is omitted', () => {
    const config = generateCloudInit(baseVariables());
    const parsed = YAML.parse(config);

    const mirrorScript = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sam/apt-mirror-config.sh'
    );
    expect(mirrorScript).toBeDefined();
    expect(mirrorScript.content).toContain('PROVIDER=""');
  });
});

describe('validateCloudInitVariables — provider field', () => {
  it('accepts valid provider values', () => {
    for (const provider of ['hetzner', 'scaleway', 'gcp']) {
      expect(() => validateCloudInitVariables(baseVariables({ provider }))).not.toThrow();
    }
  });

  it('accepts empty string for provider', () => {
    expect(() => validateCloudInitVariables(baseVariables({ provider: '' }))).not.toThrow();
  });

  it('accepts undefined provider', () => {
    expect(() => validateCloudInitVariables(baseVariables({ provider: undefined }))).not.toThrow();
  });

  it('rejects invalid provider', () => {
    expect(() => validateCloudInitVariables(baseVariables({ provider: 'aws' }))).toThrow('provider');
  });

  it('rejects provider with shell metacharacters', () => {
    expect(() => validateCloudInitVariables(baseVariables({ provider: 'hetzner; rm -rf /' }))).toThrow('provider');
  });
});

describe('integrated size validation in generateCloudInit', () => {
  it('throws when output exceeds 32KB (default behavior)', () => {
    expect(() => generateCloudInit(baseVariables({
      callbackToken: 'a'.repeat(40_000),
    }))).toThrow('32KB');
  });

  it('skips size validation when validateSize is false', () => {
    // Should not throw with validateSize: false
    expect(() => generateCloudInit(baseVariables({
      callbackToken: 'a'.repeat(40_000),
    }), { validateSize: false })).not.toThrow();
  });

  it('does not throw for normal-sized configs (default behavior)', () => {
    expect(() => generateCloudInit(baseVariables({
      originCaCertificateUrl: ORIGIN_CA_CERTIFICATE_URL,
    }))).not.toThrow();
  });
});

describe('swap file configuration', () => {
  /** Find the runcmd entry containing the swap setup script block. */
  function findSwapBlock(parsed: { runcmd: (string | unknown)[] }): string {
    const block = parsed.runcmd.find(
      (cmd) => typeof cmd === 'string' && cmd.includes('SWAP_SIZE_MB='),
    );
    return (block as string) ?? '';
  }

  it('uses default swap values (2048 MB, swappiness 60)', () => {
    const config = generateCloudInit(baseVariables(), { validateSize: false });
    const parsed = YAML.parse(config);

    const swapBlock = findSwapBlock(parsed);
    expect(swapBlock).toContain('SWAP_SIZE_MB="2048"');
    expect(swapBlock).toContain('SWAP_SWAPPINESS="60"');

    // Check sysctl.d persistence file
    const sysctlFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sysctl.d/99-sam-swap.conf',
    );
    expect(sysctlFile).toBeDefined();
    expect(sysctlFile.content).toContain('vm.swappiness=60');
  });

  it('accepts custom swap values', () => {
    const config = generateCloudInit(
      baseVariables({ swapSizeMb: '4096', swapSwappiness: '10' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const swapBlock = findSwapBlock(parsed);
    expect(swapBlock).toContain('SWAP_SIZE_MB="4096"');
    expect(swapBlock).toContain('SWAP_SWAPPINESS="10"');

    const sysctlFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sysctl.d/99-sam-swap.conf',
    );
    expect(sysctlFile.content).toContain('vm.swappiness=10');
  });

  it('disables swap when swapSizeMb is "0"', () => {
    const config = generateCloudInit(
      baseVariables({ swapSizeMb: '0' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const swapBlock = findSwapBlock(parsed);
    expect(swapBlock).toContain('SWAP_SIZE_MB="0"');
    // The conditional block means fallocate/mkswap/swapon won't execute
    expect(swapBlock).toContain('Swap disabled (SWAP_SIZE_MB=0)');
  });

  it('generates sysctl persistence file in write_files', () => {
    const config = generateCloudInit(
      baseVariables({ swapSwappiness: '80' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const sysctlFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sysctl.d/99-sam-swap.conf',
    );
    expect(sysctlFile).toBeDefined();
    expect(sysctlFile.permissions).toBe('0644');
    expect(sysctlFile.content.trim()).toBe('vm.swappiness=80');
  });

  it('places swap setup before vm-agent download in runcmd', () => {
    const config = generateCloudInit(baseVariables(), { validateSize: false });
    const parsed = YAML.parse(config);

    const runcmd = parsed.runcmd as string[];
    const swapIdx = runcmd.findIndex(
      (cmd) => typeof cmd === 'string' && cmd.includes('PHASE START: swap-setup'),
    );
    const agentIdx = runcmd.findIndex(
      (cmd) => typeof cmd === 'string' && cmd.includes('PHASE START: vm-agent-download'),
    );
    expect(swapIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);
    expect(swapIdx).toBeLessThan(agentIdx);
  });

  it('rejects non-numeric swapSizeMb', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSizeMb: '2G' })),
    ).toThrow('swapSizeMb');
  });

  it('rejects shell metacharacters in swapSizeMb', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSizeMb: '2048; rm -rf /' })),
    ).toThrow('swapSizeMb');
  });

  it('rejects out-of-range swapSizeMb (>65536)', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSizeMb: '99999' })),
    ).toThrow('swapSizeMb');
  });

  it('rejects out-of-range swapSwappiness (>100)', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSwappiness: '150' })),
    ).toThrow('swapSwappiness');
  });

  it('rejects non-numeric swapSwappiness', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSwappiness: 'high' })),
    ).toThrow('swapSwappiness');
  });

  it('rejects shell metacharacters in swapSwappiness', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSwappiness: '60; rm -rf /' })),
    ).toThrow('swapSwappiness');
  });

  it('accepts boundary values (swapSizeMb=0, swapSwappiness=0 and 100)', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSizeMb: '0', swapSwappiness: '0' })),
    ).not.toThrow();
    expect(() =>
      validateCloudInitVariables(baseVariables({ swapSizeMb: '65536', swapSwappiness: '100' })),
    ).not.toThrow();
  });

  it('still writes sysctl.d with default swappiness when swap is disabled', () => {
    const config = generateCloudInit(
      baseVariables({ swapSizeMb: '0' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const sysctlFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sysctl.d/99-sam-swap.conf',
    );
    expect(sysctlFile).toBeDefined();
    expect(sysctlFile.content.trim()).toBe('vm.swappiness=60');
  });
});

// =============================================================================
// Deployment Role Support
// =============================================================================

describe('deployment role support', () => {
  it('sets deployment role environment in vm-agent systemd unit', () => {
    const config = generateCloudInit(
      baseVariables({
        role: 'deployment',
        environmentId: 'env-abc123',
        deploySigningPubKey: 'deploy-pub-key-abc123+/=',
        deployAcmeEmail: 'ops@example.com',
        deployAcmeCa: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        deployComposeCmd: '/usr/local/bin/docker compose',
        deployHealthTimeout: '7m',
      }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const unitFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/systemd/system/vm-agent.service',
    );
    expect(unitFile).toBeDefined();
    expect(unitFile.content).toContain('Environment=ROLE=deployment');
    expect(unitFile.content).toContain('Environment=NODE_ROLE=deployment');
    expect(unitFile.content).toContain('Environment=ENVIRONMENT_ID=env-abc123');
    expect(unitFile.content).toContain('Environment=DEPLOY_SIGNING_PUB_KEY=deploy-pub-key-abc123+/=');
    expect(unitFile.content).toContain('Environment=DEPLOY_ACME_EMAIL=ops@example.com');
    expect(unitFile.content).toContain('Environment=DEPLOY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory');
    expect(unitFile.content).toContain('Environment="DEPLOY_COMPOSE_CMD=/usr/local/bin/docker compose"');
    expect(unitFile.content).toContain('Environment=DEPLOY_HEALTH_TIMEOUT=7m');
  });

  it('leaves deployment environment empty when not specified', () => {
    const config = generateCloudInit(
      baseVariables(),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const unitFile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/systemd/system/vm-agent.service',
    );
    expect(unitFile).toBeDefined();
    // Empty string values — vm-agent ignores empty env vars
    expect(unitFile.content).toContain('Environment=ROLE=\n');
    expect(unitFile.content).toContain('Environment=NODE_ROLE=\n');
    expect(unitFile.content).toContain('Environment=ENVIRONMENT_ID=\n');
    expect(unitFile.content).toContain('Environment=DEPLOY_SIGNING_PUB_KEY=\n');
    expect(unitFile.content).toContain('Environment=DEPLOY_ACME_EMAIL=\n');
    expect(unitFile.content).toContain('Environment=DEPLOY_ACME_CA=\n');
    expect(unitFile.content).toContain('Environment="DEPLOY_COMPOSE_CMD="\n');
    expect(unitFile.content).toContain('Environment=DEPLOY_HEALTH_TIMEOUT=\n');
  });

  it('generates valid YAML with deployment role set', () => {
    const config = generateCloudInit(
      baseVariables({ role: 'deployment', environmentId: 'env-deploy-xyz' }),
      { validateSize: false },
    );

    // Must parse without error
    const parsed = YAML.parse(config);
    expect(parsed.hostname).toBe('sam-test-node');

    // Verify config stays within 32KB limit
    const sizeBytes = new TextEncoder().encode(config).length;
    expect(sizeBytes).toBeLessThanOrEqual(32 * 1024);
  });

  it('writes an initial managed Caddyfile for deployment routing', () => {
    const config = generateCloudInit(
      baseVariables({ role: 'deployment', environmentId: 'env-deploy-xyz' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);

    const caddyfile = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/caddy/Caddyfile',
    );
    expect(caddyfile).toBeDefined();
    expect(caddyfile.permissions).toBe('0644');
    expect(caddyfile.content).toContain('Managed by SAM deployment agent');
    expect(caddyfile.content).toContain('caddy reload');
    expect(caddyfile.content).toContain('auto_https off');
    expect(caddyfile.content).toContain(':80');
    expect(caddyfile.content).toContain('SAM deployment node awaiting release');
  });

  it('guards Caddy path preparation behind ROLE=deployment', () => {
    const config = generateCloudInit(
      baseVariables({ role: 'deployment', environmentId: 'env-deploy-xyz' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);
    const runcmd = parsed.runcmd.join('\n');

    expect(runcmd).toContain('ROLE="deployment"');
    expect(runcmd).toContain('if [ "$ROLE" = "deployment" ]; then');
    expect(runcmd).toContain('Preparing Caddy paths for deployment node routing');
    expect(runcmd).toContain('vm-agent owns Caddy install/start');
    expect(runcmd).not.toContain('apt-get install -y caddy');
    expect(runcmd).not.toContain('systemctl reload-or-restart caddy');
  });

  it('runs the workspace Caddy setup entry successfully through cloud-init /bin/sh', () => {
    const { calls, command, result } = runCaddySetupRuncmd('workspace');

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(command).not.toContain('pipefail');
    expect(calls).toContain('logger -t sam-boot Skipping Caddy setup for ROLE=workspace');
    expect(calls.some((call) => call.startsWith('mkdir '))).toBe(false);
  });

  it('runs the deployment Caddy setup entry successfully through cloud-init /bin/sh', () => {
    const { calls, command, result } = runCaddySetupRuncmd('deployment');

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(command).not.toContain('pipefail');
    expect(calls).toContain(
      'mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy',
    );
    expect(calls).toContain(
      'logger -t sam-boot Caddy paths ready; vm-agent owns Caddy install/start',
    );
  });

  it('starts vm-agent before non-blocking deployment Caddy path setup', () => {
    const config = generateCloudInit(
      baseVariables({ role: 'deployment', environmentId: 'env-deploy-xyz' }),
      { validateSize: false },
    );
    const parsed = YAML.parse(config);
    const runcmd = parsed.runcmd.join('\n');

    expect(runcmd.indexOf('PHASE START: vm-agent-start')).toBeGreaterThan(-1);
    expect(runcmd.indexOf('PHASE START: caddy-setup')).toBeGreaterThan(-1);
    expect(runcmd.indexOf('PHASE START: vm-agent-start')).toBeLessThan(
      runcmd.indexOf('PHASE START: caddy-setup'),
    );
  });

  it('rejects invalid role values', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ role: 'admin' })),
    ).toThrow('role');

    expect(() =>
      validateCloudInitVariables(baseVariables({ role: 'worker' })),
    ).toThrow('role');
  });

  it('accepts valid role values', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ role: 'workspace' })),
    ).not.toThrow();

    expect(() =>
      validateCloudInitVariables(baseVariables({ role: 'deployment' })),
    ).not.toThrow();
  });

  it('rejects environmentId with shell metacharacters', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ environmentId: 'env-123; rm -rf /' })),
    ).toThrow('environmentId');

    expect(() =>
      validateCloudInitVariables(baseVariables({ environmentId: 'env-$(whoami)' })),
    ).toThrow('environmentId');
  });

  it('accepts valid environmentId values', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ environmentId: 'env-abc123' })),
    ).not.toThrow();

    expect(() =>
      validateCloudInitVariables(baseVariables({ environmentId: 'ENV_TEST-123_abc' })),
    ).not.toThrow();
  });

  it('accepts empty role and environmentId', () => {
    expect(() =>
      validateCloudInitVariables(baseVariables({ role: '', environmentId: '' })),
    ).not.toThrow();
  });
});

describe('Docker daemon.json live-restore', () => {
  it('includes live-restore: true for container survival during daemon restarts', () => {
    const config = generateCloudInit(baseVariables(), { validateSize: false });
    const parsed = YAML.parse(config);
    const daemonJson = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/docker/daemon.json',
    );
    expect(daemonJson).toBeDefined();
    const dockerConfig = JSON.parse(daemonJson.content);
    expect(dockerConfig['live-restore']).toBe(true);
  });
});
