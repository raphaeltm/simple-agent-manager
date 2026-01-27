import type { VMSize } from '@cloud-ai-workspaces/shared';
import type { Provider, ProviderConfig, SizeConfig, VMConfig, VMInstance } from './types';

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'cx11',
    price: '€3.49/mo',
    vcpu: 1,
    ramGb: 2,
    storageGb: 20,
  },
  medium: {
    type: 'cx22',
    price: '€5.39/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 40,
  },
  large: {
    type: 'cx32',
    price: '€10.49/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 80,
  },
};

const MANAGED_BY_LABEL = 'cloud-ai-workspaces';

interface HetznerServerResponse {
  server: {
    id: number;
    name: string;
    status: string;
    public_net: {
      ipv4: {
        ip: string;
      };
    };
    server_type: {
      name: string;
    };
    created: string;
    labels: Record<string, string>;
  };
}

interface HetznerServersResponse {
  servers: HetznerServerResponse['server'][];
}

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  private readonly apiToken: string;
  private readonly datacenter: string;

  constructor(config: ProviderConfig) {
    this.apiToken = config.apiToken;
    this.datacenter = config.datacenter || 'fsn1'; // Falkenstein, Germany
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.getSizeConfig(config.size);
    const cloudInit = this.generateCloudInit(config);

    const response = await fetch(`${HETZNER_API_URL}/servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${config.name}-${config.workspaceId}`,
        server_type: sizeConfig.type,
        image: 'ubuntu-24.04',
        datacenter: this.datacenter,
        user_data: cloudInit,
        labels: {
          'managed-by': MANAGED_BY_LABEL,
          'workspace-id': config.workspaceId,
          'repo-url': encodeURIComponent(config.repoUrl).slice(0, 63), // Hetzner label limit
          size: config.size,
          'created-at': new Date().toISOString(),
        },
        start_after_create: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create VM: ${error}`);
    }

    const data = (await response.json()) as HetznerServerResponse;
    return this.mapServerToVMInstance(data.server);
  }

  async deleteVM(id: string): Promise<void> {
    const response = await fetch(`${HETZNER_API_URL}/servers/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Failed to delete VM: ${error}`);
    }
  }

  async listVMs(): Promise<VMInstance[]> {
    const response = await fetch(
      `${HETZNER_API_URL}/servers?label_selector=managed-by=${MANAGED_BY_LABEL}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list VMs: ${error}`);
    }

    const data = (await response.json()) as HetznerServersResponse;
    return data.servers.map((server) => this.mapServerToVMInstance(server));
  }

  async getVM(id: string): Promise<VMInstance | null> {
    const response = await fetch(`${HETZNER_API_URL}/servers/${id}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get VM: ${error}`);
    }

    const data = (await response.json()) as HetznerServerResponse;
    return this.mapServerToVMInstance(data.server);
  }

  getSizeConfig(size: VMSize): SizeConfig {
    return SIZE_CONFIGS[size];
  }

  generateCloudInit(config: VMConfig): string {
    return `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose
  - caddy
  - jq
  - curl
  - git

write_files:
  - path: /etc/caddy/Caddyfile
    content: |
      {
        email admin@${config.baseDomain}
      }

      *.${config.workspaceId}.vm.${config.baseDomain} {
        tls {
          dns cloudflare {env.CF_API_TOKEN}
        }

        @ui host ui.${config.workspaceId}.vm.${config.baseDomain}
        handle @ui {
          basicauth {
            admin $HASHED_PASSWORD
          }
          reverse_proxy localhost:3001
        }

        handle {
          respond "Not Found" 404
        }
      }

  - path: /etc/workspace/config
    permissions: '0600'
    content: |
      WORKSPACE_ID=${config.workspaceId}
      REPO_URL=${config.repoUrl}
      BASE_DOMAIN=${config.baseDomain}
      API_URL=${config.apiUrl}
      API_TOKEN=${config.apiToken}
      AUTH_PASSWORD=${config.authPassword}
      # Note: ANTHROPIC_API_KEY is NOT set - users authenticate via 'claude login'
      ${config.githubToken ? `GITHUB_TOKEN=${config.githubToken}` : '# No GitHub token (public repo)'}

  - path: /usr/local/bin/idle-check.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      IDLE_FILE="/var/run/idle-check.state"
      IDLE_THRESHOLD=30
      CHECK_INTERVAL=5

      source /etc/workspace/config

      is_active() {
        [ -n "$(find /workspace -type f -mmin -$CHECK_INTERVAL 2>/dev/null | head -1)" ] && return 0
        pgrep -f "claude|@anthropic-ai|claude-code-ui" >/dev/null && return 0
        [ "$(ss -tnp 2>/dev/null | grep -c ':3001.*ESTAB')" -gt 0 ] && return 0
        [ "$(who | wc -l)" -gt 0 ] && return 0
        return 1
      }

      if is_active; then
        echo "0" > "$IDLE_FILE"
      else
        IDLE_COUNT=$(cat "$IDLE_FILE" 2>/dev/null || echo "0")
        IDLE_COUNT=$((IDLE_COUNT + CHECK_INTERVAL))
        echo "$IDLE_COUNT" > "$IDLE_FILE"

        if [ "$IDLE_COUNT" -ge "$IDLE_THRESHOLD" ]; then
          curl -sX POST "$API_URL/vms/$WORKSPACE_ID/cleanup" \\
            -H "Authorization: Bearer $API_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d '{"reason": "idle_timeout"}'

          SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
          curl -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \\
            -H "Authorization: Bearer $HETZNER_TOKEN"
        fi
      fi

runcmd:
  # Enable Docker
  - systemctl enable docker
  - systemctl start docker

  # Add user to docker group
  - usermod -aG docker ubuntu

  # Install Node.js 22
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs

  # Install devcontainer CLI
  - npm install -g @devcontainers/cli

  # Install CloudCLI
  - npm install -g @siteboon/claude-code-ui

  # Clone repository (uses git credentials if GITHUB_TOKEN is set)
  - |
    source /etc/workspace/config
    if [ -n "$GITHUB_TOKEN" ]; then
      # For private repos, use the token for authentication
      REPO_URL_WITH_TOKEN=$(echo "${config.repoUrl}" | sed "s|https://github.com|https://x-access-token:$GITHUB_TOKEN@github.com|")
      git clone "$REPO_URL_WITH_TOKEN" /workspace || mkdir -p /workspace
    else
      git clone ${config.repoUrl} /workspace || mkdir -p /workspace
    fi

  # Generate hashed password for Caddy
  - export HASHED_PASSWORD=$(caddy hash-password --plaintext '${config.authPassword}')
  - envsubst < /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.tmp && mv /etc/caddy/Caddyfile.tmp /etc/caddy/Caddyfile

  # Start Caddy
  - systemctl enable caddy
  - systemctl start caddy

  # Configure git credentials if GitHub token provided (for private repos)
  - |
    source /etc/workspace/config
    if [ -n "$GITHUB_TOKEN" ]; then
      git config --global credential.helper store
      echo "https://x-access-token:$GITHUB_TOKEN@github.com" > ~/.git-credentials
      chmod 600 ~/.git-credentials
    fi

  # Setup devcontainer if exists, otherwise use default
  # Note: ANTHROPIC_API_KEY is NOT set - users authenticate via 'claude login' in CloudCLI terminal
  - |
    if [ ! -f /workspace/.devcontainer/devcontainer.json ]; then
      mkdir -p /workspace/.devcontainer
      cat > /workspace/.devcontainer/devcontainer.json << 'DEVEOF'
      {
        "name": "Claude Code Workspace",
        "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
        "features": {
          "ghcr.io/devcontainers/features/git:1": {},
          "ghcr.io/devcontainers/features/github-cli:1": {},
          "ghcr.io/devcontainers/features/node:1": { "version": "22" },
          "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {}
        },
        "postCreateCommand": "echo 'Run claude login to authenticate with Claude Max'",
        "remoteUser": "vscode"
      }
      DEVEOF
    fi

  # Start devcontainer
  - cd /workspace && devcontainer up --workspace-folder .

  # Start CloudCLI (in the devcontainer context)
  - claude-code-ui --port 3001 --workspace /workspace &

  # Setup idle check cron
  - echo "*/5 * * * * root /usr/local/bin/idle-check.sh" > /etc/cron.d/idle-check
`;
  }

  private mapServerToVMInstance(server: HetznerServerResponse['server']): VMInstance {
    return {
      id: String(server.id),
      name: server.name,
      ip: server.public_net.ipv4.ip,
      status: this.mapStatus(server.status),
      serverType: server.server_type.name,
      createdAt: server.created,
      labels: server.labels,
    };
  }

  private mapStatus(
    hetznerStatus: string
  ): 'initializing' | 'running' | 'off' | 'starting' | 'stopping' {
    switch (hetznerStatus) {
      case 'initializing':
        return 'initializing';
      case 'running':
        return 'running';
      case 'off':
        return 'off';
      case 'starting':
        return 'starting';
      case 'stopping':
        return 'stopping';
      default:
        return 'initializing';
    }
  }
}
