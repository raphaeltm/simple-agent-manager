/**
 * Tests for cloud-init generation.
 *
 * IMPORTANT: TLS certificate tests MUST parse the YAML output and verify
 * the full PEM content survives intact. String `toContain()` checks are
 * NOT sufficient — they hide YAML indentation bugs that truncate certs.
 * See: docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md
 */
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { generateCloudInit, validateCloudInitSize, validateCloudInitVariables, indentForYamlBlock } from '../src/generate';
import type { CloudInitVariables } from '../src/generate';

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
      expect(config).toContain('Environment=CALLBACK_TOKEN=cb-token-abc');
      expect(config).toContain('hostname: sam-test-node');
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

  describe('TLS certificate injection', () => {
    it('sets VM_AGENT_PORT=8443 and TLS paths when cert provided', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
      }));

      expect(config).toContain('Environment=VM_AGENT_PORT=8443');
      expect(config).toContain('Environment=TLS_CERT_PATH=/etc/sam/tls/origin-ca.pem');
      expect(config).toContain('Environment=TLS_KEY_PATH=/etc/sam/tls/origin-ca-key.pem');
    });

    it('sets VM_AGENT_PORT=8080 and empty TLS paths when no cert', () => {
      const config = generateCloudInit(baseVariables());

      expect(config).toContain('Environment=VM_AGENT_PORT=8080');
      expect(config).toContain('Environment=TLS_CERT_PATH=');
      expect(config).toContain('Environment=TLS_KEY_PATH=');
    });

    it('key file has restricted permissions (0600)', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
      }));

      expect(config).toMatch(/origin-ca-key\.pem[\s\S]*?permissions:\s*'0600'/);
    });

    /**
     * CRITICAL REGRESSION TEST: Parse the YAML output and verify full PEM content survives.
     *
     * This test would have caught the bug introduced in PR #320, where plain string
     * replacement of multi-line PEM content broke YAML block scalar indentation,
     * truncating certs to just the first line.
     *
     * See: docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md
     */
    it('full multi-line cert PEM survives YAML generation intact', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
      }));

      // Parse the generated YAML — this is the critical test.
      // If indentation is wrong, YAML.parse() will either throw or
      // produce truncated content.
      const parsed = YAML.parse(config);

      const certEntry = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/tls/origin-ca.pem'
      );
      expect(certEntry).toBeDefined();

      const parsedCert = certEntry.content.trim();
      expect(parsedCert).toBe(REALISTIC_CERT);
    });

    it('full multi-line key PEM survives YAML generation intact', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
      }));

      const parsed = YAML.parse(config);

      const keyEntry = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/tls/origin-ca-key.pem'
      );
      expect(keyEntry).toBeDefined();

      const parsedKey = keyEntry.content.trim();
      expect(parsedKey).toBe(REALISTIC_KEY);
    });

    it('generated YAML is valid and parseable with realistic certs', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
        taskId: 'task-789',
      }));

      const parsed = YAML.parse(config);
      expect(parsed.hostname).toBe('sam-test-node');
      expect(parsed.write_files).toBeDefined();
      expect(parsed.write_files.length).toBeGreaterThanOrEqual(5);
    });

    it('config with realistic TLS certs stays within 32KB limit', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
      }));

      expect(validateCloudInitSize(config)).toBe(true);
    });

    it('handles empty cert/key gracefully (no TLS mode)', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: '',
        originCaKey: '',
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
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
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
      expect(content).toContain('iptables -A INPUT -i lo -j ACCEPT');
      expect(content).toContain('iptables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      expect(content).toContain('iptables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      // No conntrack ESTABLISHED,RELATED dependency — policy ACCEPT means
      // outbound reply packets don't need a state entry to come back.
      expect(content).not.toContain('conntrack --ctstate ESTABLISHED,RELATED');
    });

    it('firewall script ends with a targeted DROP rule for VM_AGENT_PORT', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // Final catch-all drops non-CF traffic to the VM agent port only.
      expect(content).toContain('iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      expect(content).toContain('ip6tables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      // The targeted DROP must come AFTER the CF ACCEPT rules. Find positions
      // in the script to verify ordering for at least one CF fallback CIDR.
      const acceptIdx = content.indexOf('iptables -A INPUT -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      const dropIdx = content.indexOf('iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP');
      expect(acceptIdx).toBeGreaterThan(-1);
      expect(dropIdx).toBeGreaterThan(acceptIdx);
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
      expect(firewallScript.content).toContain('ip6tables-save > /etc/iptables/rules.v6');
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
      // No explicit SSH allowance
      expect(content).not.toMatch(/--dport 22\b/);
      expect(content).not.toMatch(/--dport ssh\b/);
    });

    it('IPv6 firewall rules mirror IPv4 structure', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      expect(content).toContain('ip6tables -A INPUT -i lo -j ACCEPT');
      expect(content).toContain('ip6tables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
      expect(content).toContain('ip6tables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT');
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
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
        taskId: 'task-789',
      }));

      expect(validateCloudInitSize(config)).toBe(true);
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

    it('firewall script delegates to apply-metadata-block.sh with Docker readiness wait', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      // Waits for DOCKER-USER chain to be available
      expect(content).toContain('iptables -L DOCKER-USER -n');
      // Delegates to the dedicated script
      expect(content).toContain('/etc/sam/firewall/apply-metadata-block.sh');
    });

    it('metadata block delegation appears before iptables-save (rules are persisted)', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      const content: string = firewallScript.content;
      const metadataIdx = content.indexOf('apply-metadata-block.sh');
      const saveIdx = content.indexOf('iptables-save');
      expect(metadataIdx).toBeGreaterThan(-1);
      expect(saveIdx).toBeGreaterThan(-1);
      expect(metadataIdx).toBeLessThan(saveIdx);
    });

    it('firewall log message mentions metadata API blocking', () => {
      const config = generateCloudInit(baseVariables());
      const parsed = YAML.parse(config);

      const firewallScript = parsed.write_files.find(
        (f: { path: string }) => f.path === '/etc/sam/firewall/setup-firewall.sh'
      );
      expect(firewallScript.content).toContain('metadata API blocked');
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

  describe('PEM format validation', () => {
    it('accepts valid certificate PEM', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: REALISTIC_CERT,
        originCaKey: REALISTIC_KEY,
      }))).not.toThrow();
    });

    it('accepts empty string for originCaCert (no TLS mode)', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: '',
      }))).not.toThrow();
    });

    it('accepts undefined originCaCert', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: undefined,
      }))).not.toThrow();
    });

    it('rejects originCaCert without BEGIN marker', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: 'MIIEojCCA4qgAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4w',
      }))).toThrow('originCaCert');
    });

    it('rejects originCaCert with YAML injection between markers', () => {
      const malicious = [
        '-----BEGIN CERTIFICATE-----',
        'valid_base64==',
        'key: value',
        '-----END CERTIFICATE-----',
      ].join('\n');
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: malicious,
      }))).toThrow('originCaCert');
    });

    it('rejects originCaKey with shell injection between markers', () => {
      const malicious = [
        '-----BEGIN RSA PRIVATE KEY-----',
        '$(rm -rf /)',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      expect(() => validateCloudInitVariables(baseVariables({
        originCaKey: malicious,
      }))).toThrow('originCaKey');
    });

    it('rejects originCaCert that is just random text', () => {
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: 'this is not a certificate',
      }))).toThrow('originCaCert');
    });

    it('rejects originCaKey without END marker', () => {
      const incomplete = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEpAIBAAKCAQEAxvFqof1sMB1yt+eiTk7gSMkJaOWJFx7GCQIDfDs3FtQ2VLJM',
      ].join('\n');
      expect(() => validateCloudInitVariables(baseVariables({
        originCaKey: incomplete,
      }))).toThrow('originCaKey');
    });

    it('rejects PEM with mismatched BEGIN/END labels', () => {
      const mismatched = [
        '-----BEGIN CERTIFICATE-----',
        'MIIEojCCA4qgAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4wDQYJKoZIhvcNAQEL',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: mismatched,
      }))).toThrow('originCaCert');
    });

    it('rejects PEM with tab characters in body', () => {
      const withTab = [
        '-----BEGIN CERTIFICATE-----',
        'MIIEojCCA4qg\tAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4wDQYJKoZIhvcNAQEL',
        '-----END CERTIFICATE-----',
      ].join('\n');
      expect(() => validateCloudInitVariables(baseVariables({
        originCaCert: withTab,
      }))).toThrow('originCaCert');
    });
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
   * and by verifying PEM content survives the full replacement pipeline intact.
   */

  it('realistic PEM cert survives full replacement pipeline intact', () => {
    const config = generateCloudInit(baseVariables({
      originCaCert: REALISTIC_CERT,
      originCaKey: REALISTIC_KEY,
    }));

    const parsed = YAML.parse(config);
    const certEntry = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sam/tls/origin-ca.pem'
    );
    expect(certEntry).toBeDefined();
    expect(certEntry.content.trim()).toBe(REALISTIC_CERT);

    const keyEntry = parsed.write_files.find(
      (f: { path: string }) => f.path === '/etc/sam/tls/origin-ca-key.pem'
    );
    expect(keyEntry).toBeDefined();
    expect(keyEntry.content.trim()).toBe(REALISTIC_KEY);
  });

  it('docker_name_tag template {{.Name}} survives replacement', () => {
    const config = generateCloudInit(baseVariables());
    expect(config).toContain('"tag": "docker/{{.Name}}"');
  });
});

describe('integrated size validation in generateCloudInit', () => {
  it('throws when output exceeds 32KB (default behavior)', () => {
    // Create variables that will produce a config exceeding 32KB
    // by providing very large PEM content
    const largePemLines = ['-----BEGIN CERTIFICATE-----'];
    // Each base64 line is ~64 chars; need enough to push past 32KB
    for (let i = 0; i < 500; i++) {
      largePemLines.push('MIIEojCCA4qgAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4wDQYJKoZIhvcNAQEL');
    }
    largePemLines.push('-----END CERTIFICATE-----');
    const largeCert = largePemLines.join('\n');

    const largeKeyLines = ['-----BEGIN RSA PRIVATE KEY-----'];
    for (let i = 0; i < 500; i++) {
      largeKeyLines.push('MIIEpAIBAAKCAQEAxvFqof1sMB1yt+eiTk7gSMkJaOWJFx7GCQIDfDs3FtQ2VLJM');
    }
    largeKeyLines.push('-----END RSA PRIVATE KEY-----');
    const largeKey = largeKeyLines.join('\n');

    expect(() => generateCloudInit(baseVariables({
      originCaCert: largeCert,
      originCaKey: largeKey,
    }))).toThrow('32KB');
  });

  it('skips size validation when validateSize is false', () => {
    const largePemLines = ['-----BEGIN CERTIFICATE-----'];
    for (let i = 0; i < 500; i++) {
      largePemLines.push('MIIEojCCA4qgAwIBAgIUP5m7GZWdRHSJRzMPQx8sTOBZjR4wDQYJKoZIhvcNAQEL');
    }
    largePemLines.push('-----END CERTIFICATE-----');
    const largeCert = largePemLines.join('\n');

    const largeKeyLines = ['-----BEGIN RSA PRIVATE KEY-----'];
    for (let i = 0; i < 500; i++) {
      largeKeyLines.push('MIIEpAIBAAKCAQEAxvFqof1sMB1yt+eiTk7gSMkJaOWJFx7GCQIDfDs3FtQ2VLJM');
    }
    largeKeyLines.push('-----END RSA PRIVATE KEY-----');
    const largeKey = largeKeyLines.join('\n');

    // Should not throw with validateSize: false
    expect(() => generateCloudInit(baseVariables({
      originCaCert: largeCert,
      originCaKey: largeKey,
    }), { validateSize: false })).not.toThrow();
  });

  it('does not throw for normal-sized configs (default behavior)', () => {
    expect(() => generateCloudInit(baseVariables({
      originCaCert: REALISTIC_CERT,
      originCaKey: REALISTIC_KEY,
    }))).not.toThrow();
  });
});

