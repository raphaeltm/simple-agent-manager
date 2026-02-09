import type { VMSize } from '@simple-agent-manager/shared';
import type { Provider, SizeConfig, VMConfig, VMInstance, ExecResult } from './types';

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'devcontainer-small',
    price: '$0/month',
    vcpu: 1,
    ramGb: 2,
    storageGb: 10,
  },
  medium: {
    type: 'devcontainer-medium',
    price: '$0/month',
    vcpu: 2,
    ramGb: 4,
    storageGb: 20,
  },
  large: {
    type: 'devcontainer-large',
    price: '$0/month',
    vcpu: 4,
    ramGb: 8,
    storageGb: 40,
  },
};

const MANAGED_BY_LABEL = 'simple-agent-manager';
const PROVIDER_LABEL = 'devcontainer';
const WORKSPACE_BASE_DIR = '/tmp/simple-agent-manager';

/**
 * Default devcontainer.json for repositories without one.
 * Provides a standard development environment with Claude Code CLI.
 */
const DEFAULT_DEVCONTAINER_CONFIG = {
  name: 'Simple Agent Manager Workspace',
  image: 'mcr.microsoft.com/devcontainers/base:ubuntu-22.04',
  features: {
    'ghcr.io/devcontainers/features/git:1': {},
    'ghcr.io/devcontainers/features/node:1': { version: '22' },
    'ghcr.io/anthropics/devcontainer-features/claude-code:1.0': {},
  },
  remoteUser: 'vscode',
  postCreateCommand: 'claude --version',
};

/**
 * DevcontainerProvider for local development
 *
 * Uses the @devcontainers/cli to run workspaces as local devcontainers.
 * This provider is for development/testing only - not for production use.
 *
 * Limitations:
 * - Single workspace at a time (FR-012)
 * - No data persistence across API restarts
 * - Requires Docker and devcontainer CLI installed locally
 */
export class DevcontainerProvider implements Provider {
  readonly name = 'devcontainer';

  /**
   * Check if Docker is available and running
   */
  private async checkDockerAvailable(): Promise<void> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      await execAsync('docker info');
    } catch {
      throw new Error(
        'Docker is not running. Please start Docker Desktop or the Docker daemon.'
      );
    }
  }

  /**
   * Check if devcontainer CLI is installed
   */
  private async checkDevcontainerCliAvailable(): Promise<void> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      await execAsync('devcontainer --version');
    } catch {
      throw new Error(
        'devcontainer CLI not found. Install it with: npm install -g @devcontainers/cli'
      );
    }
  }

  private log(message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    if (data !== undefined) {
      console.log(`[${timestamp}] [devcontainer] ${message}`, data);
    } else {
      console.log(`[${timestamp}] [devcontainer] ${message}`);
    }
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    this.log(`Creating workspace: ${config.workspaceId}`);
    this.log(`Repository: ${config.repoUrl}`);

    // Check prerequisites
    this.log('Checking Docker availability...');
    await this.checkDockerAvailable();
    this.log('Docker is available');

    this.log('Checking devcontainer CLI availability...');
    await this.checkDevcontainerCliAvailable();
    this.log('devcontainer CLI is available');

    // Enforce single workspace limit (FR-012)
    this.log('Checking for existing workspaces...');
    const existing = await this.listVMs();
    if (existing.length > 0 && existing[0]) {
      const existingWorkspace = existing[0];
      throw new Error(
        `A workspace already exists (ID: ${existingWorkspace.labels['workspace-id']}). Stop it with DELETE /vms/${existingWorkspace.id} before creating a new one.`
      );
    }
    this.log('No existing workspaces found');

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const execAsync = promisify(exec);

    const workspaceFolder = path.join(WORKSPACE_BASE_DIR, config.workspaceId);
    this.log(`Workspace folder: ${workspaceFolder}`);

    // Create workspace directory
    this.log('Creating workspace directory...');
    await fs.mkdir(workspaceFolder, { recursive: true });

    // Clone repository
    this.log(`Cloning repository: ${config.repoUrl}`);
    try {
      const { stdout, stderr } = await execAsync(`git clone ${config.repoUrl} ${workspaceFolder}`);
      if (stdout) this.log('git clone stdout:', stdout);
      if (stderr) this.log('git clone stderr:', stderr);
      this.log('Repository cloned successfully');
    } catch (error) {
      this.log('Failed to clone repository', error);
      await fs.rm(workspaceFolder, { recursive: true, force: true });
      throw new Error(
        `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}. Check the URL is correct and accessible.`
      );
    }

    // Check if devcontainer.json exists, create default if not
    const devcontainerPath = path.join(workspaceFolder, '.devcontainer', 'devcontainer.json');
    try {
      await fs.access(devcontainerPath);
      this.log('Found existing devcontainer.json');
    } catch {
      // No devcontainer.json, create default
      this.log('No devcontainer.json found, creating default configuration');
      await fs.mkdir(path.join(workspaceFolder, '.devcontainer'), { recursive: true });
      await fs.writeFile(devcontainerPath, JSON.stringify(DEFAULT_DEVCONTAINER_CONFIG, null, 2));
      this.log('Default devcontainer.json created');
    }

    // Run devcontainer up
    this.log('Starting devcontainer (this may take a few minutes on first run)...');
    let containerId: string;
    try {
      // Inject ACP agent adapters via --additional-features so they're available
      // regardless of what the repo's devcontainer.json contains.
      const additionalFeatures = JSON.stringify({
        'ghcr.io/devcontainers/features/node:1': { version: '22' },
        'ghcr.io/devcontainers-community/npm-features/npm-package:1': {
          package: '@zed-industries/claude-code-acp',
        },
      });
      const cmd = `devcontainer up --workspace-folder ${workspaceFolder} --id-label managed-by=${MANAGED_BY_LABEL} --id-label provider=${PROVIDER_LABEL} --id-label workspace-id=${config.workspaceId} --id-label repo-url=${encodeURIComponent(config.repoUrl).slice(0, 63)} --additional-features '${additionalFeatures}'`;
      this.log('Running command:', cmd);

      const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
      if (stderr) this.log('devcontainer up stderr:', stderr);
      this.log('devcontainer up stdout:', stdout);

      // Parse the JSON output to get container ID
      const lines = stdout.trim().split('\n');
      const jsonLine = lines.find((line) => line.startsWith('{'));
      if (!jsonLine) {
        throw new Error('No JSON output from devcontainer up');
      }
      const result = JSON.parse(jsonLine);
      containerId = result.containerId;

      if (!containerId) {
        throw new Error('Container ID not found in devcontainer up output');
      }
      this.log(`Container started: ${containerId}`);
    } catch (error) {
      this.log('Failed to start devcontainer', error);
      await fs.rm(workspaceFolder, { recursive: true, force: true });
      throw new Error(
        `Failed to start devcontainer: ${error instanceof Error ? error.message : 'Unknown error'}. Check the repository's devcontainer.json is valid.`
      );
    }

    // Get container IP
    this.log('Getting container IP address...');
    let containerIp: string;
    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`
      );
      containerIp = stdout.trim() || '127.0.0.1';
      this.log(`Container IP: ${containerIp}`);
    } catch {
      containerIp = '127.0.0.1';
      this.log('Could not get container IP, using 127.0.0.1');
    }

    const sizeConfig = this.getSizeConfig(config.size);

    const instance: VMInstance = {
      id: containerId,
      name: `${config.name}-${config.workspaceId}`,
      ip: containerIp,
      status: 'running',
      serverType: sizeConfig.type,
      createdAt: new Date().toISOString(),
      labels: {
        'managed-by': MANAGED_BY_LABEL,
        provider: PROVIDER_LABEL,
        'workspace-id': config.workspaceId,
        'repo-url': encodeURIComponent(config.repoUrl).slice(0, 63),
        size: config.size,
      },
    };

    this.log(`Workspace created successfully!`, {
      workspaceId: config.workspaceId,
      containerId,
      ip: containerIp,
    });

    return instance;
  }

  async deleteVM(id: string): Promise<void> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const execAsync = promisify(exec);

    // Get workspace ID from container labels before stopping
    let workspaceId: string | null = null;
    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{index .Config.Labels "workspace-id"}}' ${id}`
      );
      workspaceId = stdout.trim();
    } catch {
      // Container may already be gone
    }

    // Stop and remove container
    try {
      await execAsync(`docker stop ${id}`);
    } catch {
      // Container may already be stopped
    }

    try {
      await execAsync(`docker rm ${id}`);
    } catch {
      // Container may already be removed
    }

    // Clean up workspace folder
    if (workspaceId) {
      const workspaceFolder = path.join(WORKSPACE_BASE_DIR, workspaceId);
      try {
        await fs.rm(workspaceFolder, { recursive: true, force: true });
      } catch {
        // Folder may not exist
      }
    }
  }

  async listVMs(): Promise<VMInstance[]> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync(
        `docker ps --filter "label=managed-by=${MANAGED_BY_LABEL}" --filter "label=provider=${PROVIDER_LABEL}" --format "{{.ID}}"`
      );

      const containerIds = stdout.trim().split('\n').filter(Boolean);
      const instances: VMInstance[] = [];

      for (const containerId of containerIds) {
        const instance = await this.getVM(containerId);
        if (instance) {
          instances.push(instance);
        }
      }

      return instances;
    } catch {
      return [];
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync(`docker inspect ${id}`);
      const [container] = JSON.parse(stdout);

      if (!container) {
        return null;
      }

      const labels = container.Config.Labels || {};
      const status = this.mapDockerStatus(container.State.Status);
      const ip =
        Object.values(container.NetworkSettings.Networks as Record<string, { IPAddress: string }>)[0]
          ?.IPAddress || '127.0.0.1';

      return {
        id: container.Id.slice(0, 12),
        name: container.Name.replace(/^\//, ''),
        ip,
        status,
        serverType: `devcontainer-${labels.size || 'medium'}`,
        createdAt: container.Created,
        labels,
      };
    } catch {
      return null;
    }
  }

  getSizeConfig(size: VMSize): SizeConfig {
    return SIZE_CONFIGS[size];
  }

  generateCloudInit(_config: VMConfig): string {
    // Not used for devcontainer provider - devcontainers use devcontainer.json
    return '# DevcontainerProvider does not use cloud-init';
  }

  /**
   * Execute a command in a workspace container
   */
  async exec(workspaceId: string, command: string): Promise<ExecResult> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const path = await import('node:path');
    const execAsync = promisify(exec);

    const workspaceFolder = path.join(WORKSPACE_BASE_DIR, workspaceId);

    try {
      const { stdout, stderr } = await execAsync(
        `devcontainer exec --workspace-folder ${workspaceFolder} ${command}`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );

      return {
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: 0,
      };
    } catch (error) {
      // exec throws on non-zero exit code
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execError.stdout || '',
        stderr: execError.stderr || (error instanceof Error ? error.message : 'Unknown error'),
        exitCode: execError.code || 1,
      };
    }
  }

  private mapDockerStatus(
    dockerStatus: string
  ): 'initializing' | 'running' | 'off' | 'starting' | 'stopping' {
    switch (dockerStatus) {
      case 'created':
        return 'initializing';
      case 'running':
        return 'running';
      case 'exited':
      case 'dead':
        return 'off';
      case 'restarting':
        return 'starting';
      case 'paused':
        return 'stopping';
      default:
        return 'initializing';
    }
  }
}
