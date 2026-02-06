import type { VMConfig } from '@simple-agent-manager/providers';

/**
 * Service for generating cloud-init scripts
 *
 * Note: ANTHROPIC_API_KEY is NOT set on VMs.
 * Users authenticate via 'claude login' in the terminal.
 * Claude Max subscription is required.
 */
export class CloudInitService {
  /**
   * Generate a cloud-init script for a workspace VM
   */
  generate(config: VMConfig): string {
    const githubTokenConfig = config.githubToken
      ? `GITHUB_TOKEN=${config.githubToken}`
      : '# No GitHub token (public repo)';

    return `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose
  - jq
  - curl
  - git

write_files:
  - path: /etc/workspace/config
    permissions: '0600'
    content: |
      WORKSPACE_ID=${config.workspaceId}
      REPO_URL=${config.repoUrl}
      BASE_DOMAIN=${config.baseDomain}
      API_URL=${config.apiUrl}
      API_TOKEN=${config.apiToken}
      # Note: ANTHROPIC_API_KEY is NOT set - users authenticate via 'claude login'
      ${githubTokenConfig}

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
        docker exec $(docker ps -q --filter "label=devcontainer.local_folder=/workspace" | head -1) pgrep -f "claude|node" >/dev/null 2>&1 && return 0
        [ "$(ss -tnp 2>/dev/null | grep -c ':8080.*ESTAB')" -gt 0 ] && return 0
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
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker ubuntu
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - npm install -g @devcontainers/cli

  # Configure git credentials if GitHub token provided (for private repos)
  - |
    source /etc/workspace/config
    if [ -n "$GITHUB_TOKEN" ]; then
      git config --global credential.helper store
      echo "https://x-access-token:$GITHUB_TOKEN@github.com" > ~/.git-credentials
      chmod 600 ~/.git-credentials
    fi

  # Clone repository (uses git credentials if GITHUB_TOKEN is set)
  - |
    source /etc/workspace/config
    if [ -n "$GITHUB_TOKEN" ]; then
      REPO_URL_WITH_TOKEN=$(echo "${config.repoUrl}" | sed "s|https://github.com|https://x-access-token:$GITHUB_TOKEN@github.com|")
      git clone "$REPO_URL_WITH_TOKEN" /workspace || mkdir -p /workspace
    else
      git clone ${config.repoUrl} /workspace || mkdir -p /workspace
    fi

  # Setup devcontainer if exists, otherwise use default
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
  - cd /workspace && devcontainer up --workspace-folder .
  - echo "*/5 * * * * root /usr/local/bin/idle-check.sh" > /etc/cron.d/idle-check
`;
  }
}
