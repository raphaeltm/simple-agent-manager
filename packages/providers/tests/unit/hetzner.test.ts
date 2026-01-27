import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HetznerProvider } from '../../src/hetzner';
import type { VMConfig } from '../../src/types';

describe('HetznerProvider', () => {
  const mockConfig = {
    apiToken: 'test-token',
    datacenter: 'fsn1',
  };

  let provider: HetznerProvider;

  beforeEach(() => {
    provider = new HetznerProvider(mockConfig);
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should set provider name to hetzner', () => {
      expect(provider.name).toBe('hetzner');
    });

    it('should use default datacenter if not provided', () => {
      const providerWithDefaults = new HetznerProvider({ apiToken: 'test' });
      expect(providerWithDefaults.name).toBe('hetzner');
    });
  });

  describe('getSizeConfig', () => {
    it('should return small size config', () => {
      const config = provider.getSizeConfig('small');
      expect(config).toEqual({
        type: 'cx11',
        price: '€3.49/mo',
        vcpu: 1,
        ramGb: 2,
        storageGb: 20,
      });
    });

    it('should return medium size config', () => {
      const config = provider.getSizeConfig('medium');
      expect(config).toEqual({
        type: 'cx22',
        price: '€5.39/mo',
        vcpu: 2,
        ramGb: 4,
        storageGb: 40,
      });
    });

    it('should return large size config', () => {
      const config = provider.getSizeConfig('large');
      expect(config).toEqual({
        type: 'cx32',
        price: '€10.49/mo',
        vcpu: 4,
        ramGb: 8,
        storageGb: 80,
      });
    });
  });

  describe('generateCloudInit', () => {
    // Note: anthropicApiKey removed (2026-01-25)
    // Users authenticate via 'claude login' in CloudCLI terminal
    const vmConfig: VMConfig = {
      workspaceId: 'ws-abc123',
      name: 'test-project',
      repoUrl: 'https://github.com/user/repo',
      size: 'medium',
      authPassword: 'generated-password',
      apiToken: 'api-token',
      baseDomain: 'example.com',
      apiUrl: 'https://api.example.com',
    };

    it('should generate valid cloud-init with #cloud-config header', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('#cloud-config');
    });

    it('should include workspace configuration', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain(`WORKSPACE_ID=${vmConfig.workspaceId}`);
      expect(cloudInit).toContain(`REPO_URL=${vmConfig.repoUrl}`);
      expect(cloudInit).toContain(`BASE_DOMAIN=${vmConfig.baseDomain}`);
    });

    it('should include idle check script', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('/usr/local/bin/idle-check.sh');
      expect(cloudInit).toContain('IDLE_THRESHOLD=30');
    });

    it('should include docker installation', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('docker.io');
      expect(cloudInit).toContain('systemctl enable docker');
    });

    it('should include devcontainer CLI installation', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('@devcontainers/cli');
    });

    it('should include CloudCLI installation', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('@siteboon/claude-code-ui');
    });

    it('should include Caddy configuration', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('/etc/caddy/Caddyfile');
      expect(cloudInit).toContain('reverse_proxy localhost:3001');
    });

    it('should setup cron for idle check', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('*/5 * * * * root /usr/local/bin/idle-check.sh');
    });

    it('should NOT include ANTHROPIC_API_KEY (users use claude login)', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).not.toMatch(/ANTHROPIC_API_KEY=sk-/);
      expect(cloudInit).toContain("users authenticate via 'claude login'");
    });

    it('should include GitHub token when provided', () => {
      const configWithGithub: VMConfig = {
        ...vmConfig,
        githubToken: 'ghs_testaccesstoken123',
      };
      const cloudInit = provider.generateCloudInit(configWithGithub);
      expect(cloudInit).toContain('GITHUB_TOKEN=ghs_testaccesstoken123');
      expect(cloudInit).toContain('git config --global credential.helper store');
    });

    it('should not include GitHub token when not provided', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('# No GitHub token (public repo)');
      expect(cloudInit).not.toContain('ghs_');
    });

    it('should include instructions for claude login', () => {
      const cloudInit = provider.generateCloudInit(vmConfig);
      expect(cloudInit).toContain('Run claude login to authenticate');
    });
  });

  describe('createVM', () => {
    // Note: anthropicApiKey removed (2026-01-25)
    // Users authenticate via 'claude login' in CloudCLI terminal
    const vmConfig: VMConfig = {
      workspaceId: 'ws-abc123',
      name: 'test-project',
      repoUrl: 'https://github.com/user/repo',
      size: 'medium',
      authPassword: 'generated-password',
      apiToken: 'api-token',
      baseDomain: 'example.com',
      apiUrl: 'https://api.example.com',
    };

    it('should call Hetzner API with correct parameters', async () => {
      const mockResponse = {
        server: {
          id: 12345,
          name: 'test-project-ws-abc123',
          status: 'initializing',
          public_net: { ipv4: { ip: '1.2.3.4' } },
          server_type: { name: 'cx22' },
          created: '2024-01-24T12:00:00Z',
          labels: { 'workspace-id': 'ws-abc123' },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provider.createVM(vmConfig);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );

      expect(result).toEqual({
        id: '12345',
        name: 'test-project-ws-abc123',
        ip: '1.2.3.4',
        status: 'initializing',
        serverType: 'cx22',
        createdAt: '2024-01-24T12:00:00Z',
        labels: { 'workspace-id': 'ws-abc123' },
      });
    });

    it('should throw error on API failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('API Error'),
      });

      await expect(provider.createVM(vmConfig)).rejects.toThrow('Failed to create VM: API Error');
    });
  });

  describe('deleteVM', () => {
    it('should call Hetzner API to delete server', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      await provider.deleteVM('12345');

      expect(fetch).toHaveBeenCalledWith('https://api.hetzner.cloud/v1/servers/12345', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-token' },
      });
    });

    it('should not throw on 404 (already deleted)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(provider.deleteVM('12345')).resolves.not.toThrow();
    });

    it('should throw on other errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });

      await expect(provider.deleteVM('12345')).rejects.toThrow('Failed to delete VM');
    });
  });

  describe('listVMs', () => {
    it('should return list of managed VMs', async () => {
      const mockResponse = {
        servers: [
          {
            id: 12345,
            name: 'test-ws-abc123',
            status: 'running',
            public_net: { ipv4: { ip: '1.2.3.4' } },
            server_type: { name: 'cx22' },
            created: '2024-01-24T12:00:00Z',
            labels: { 'workspace-id': 'ws-abc123' },
          },
          {
            id: 12346,
            name: 'test-ws-def456',
            status: 'running',
            public_net: { ipv4: { ip: '5.6.7.8' } },
            server_type: { name: 'cx11' },
            created: '2024-01-24T13:00:00Z',
            labels: { 'workspace-id': 'ws-def456' },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provider.listVMs();

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('label_selector=managed-by=cloud-ai-workspaces'),
        expect.any(Object)
      );

      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('12345');
      expect(result[1]!.id).toBe('12346');
    });
  });

  describe('getVM', () => {
    it('should return VM instance if found', async () => {
      const mockResponse = {
        server: {
          id: 12345,
          name: 'test-ws-abc123',
          status: 'running',
          public_net: { ipv4: { ip: '1.2.3.4' } },
          server_type: { name: 'cx22' },
          created: '2024-01-24T12:00:00Z',
          labels: { 'workspace-id': 'ws-abc123' },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provider.getVM('12345');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('12345');
      expect(result!.status).toBe('running');
    });

    it('should return null if VM not found', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await provider.getVM('99999');

      expect(result).toBeNull();
    });
  });
});
