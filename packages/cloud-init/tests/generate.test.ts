/**
 * Tests for cloud-init generation with projectId and chatSessionId variables.
 */
import { describe, it, expect } from 'vitest';
import { generateCloudInit, validateCloudInitSize } from '../src/generate';
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
      // Must NOT contain the literal string "undefined"
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

      // Verify they're within the [Service] section (between Environment=CALLBACK_TOKEN and ExecStart)
      const serviceSection = config.split('[Service]')[1]?.split('[Install]')[0];
      expect(serviceSection).toBeDefined();
      expect(serviceSection).toContain('Environment=PROJECT_ID=proj-123');
      expect(serviceSection).toContain('Environment=CHAT_SESSION_ID=sess-456');
    });
  });

  describe('TLS certificate injection', () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW...\n-----END CERTIFICATE-----';
    const fakeKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----';

    it('writes cert and key files when originCaCert/Key provided', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: fakeCert,
        originCaKey: fakeKey,
      }));

      expect(config).toContain('/etc/sam/tls/origin-ca.pem');
      expect(config).toContain('/etc/sam/tls/origin-ca-key.pem');
      expect(config).toContain('BEGIN CERTIFICATE');
      expect(config).toContain('BEGIN RSA PRIVATE KEY');
    });

    it('sets VM_AGENT_PORT=8443 and TLS paths when cert provided', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: fakeCert,
        originCaKey: fakeKey,
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

    it('config with TLS cert stays within 32KB limit', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: fakeCert,
        originCaKey: fakeKey,
        projectId: 'proj-123',
        chatSessionId: 'sess-456',
      }));

      expect(validateCloudInitSize(config)).toBe(true);
    });

    it('key file has restricted permissions (0600)', () => {
      const config = generateCloudInit(baseVariables({
        originCaCert: fakeCert,
        originCaKey: fakeKey,
      }));

      // Verify the key file write_files entry has 0600 permissions
      // Match the YAML block: path line followed eventually by permissions line
      expect(config).toMatch(/origin-ca-key\.pem[\s\S]*?permissions:\s*'0600'/);
    });
  });

  describe('no template placeholders remain', () => {
    it('all {{ ... }} placeholders are replaced', () => {
      const config = generateCloudInit(baseVariables({
        projectId: 'proj-test',
        chatSessionId: 'sess-test',
      }));

      // The only {{ }} pattern remaining should be the docker tag {{.Name}}
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
