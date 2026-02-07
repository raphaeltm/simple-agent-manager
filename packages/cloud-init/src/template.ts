/**
 * Cloud-init template for VM provisioning.
 * Uses mustache-style {{ variable }} placeholders.
 *
 * SECURITY: No sensitive tokens are embedded in this template.
 * The VM agent redeems a bootstrap token on startup to receive credentials.
 */
export const CLOUD_INIT_TEMPLATE = `#cloud-config

# Configure hostname
hostname: {{ hostname }}

# Create workspace user
users:
  - name: workspace
    groups: sudo, docker
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: []

# Install packages
packages:
  - docker.io
  - docker-compose
  - git
  - curl
  - wget
  - jq
  - htop
  - vim

# Enable and start Docker
runcmd:
  # Enable Docker
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker workspace

  # Download and install VM Agent
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    curl -Lo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}"
    chmod +x /usr/local/bin/vm-agent

  # Install devcontainers CLI
  - npm install -g @devcontainers/cli

  # Install ACP agent adapters (pre-installed for instant agent switching)
  - npm install -g @zed-industries/claude-code-acp
  - npm install -g @google/gemini-cli
  - npx --yes @zed-industries/codex-acp --version

  # Create VM Agent systemd service with bootstrap token
  # The agent will redeem the bootstrap token to get credentials on startup
  - |
    cat > /etc/systemd/system/vm-agent.service << 'EOF'
    [Unit]
    Description=VM Agent
    After=network.target docker.service
    Requires=docker.service

    [Service]
    Type=simple
    User=root
    Environment=WORKSPACE_ID={{ workspace_id }}
    Environment=CONTROL_PLANE_URL={{ control_plane_url }}
    Environment=JWKS_URL={{ jwks_url }}
    Environment=BOOTSTRAP_TOKEN={{ bootstrap_token }}
    Environment=REPOSITORY={{ repository }}
    Environment=BRANCH={{ branch }}
    ExecStart=/usr/local/bin/vm-agent
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF
    systemctl daemon-reload
    systemctl enable vm-agent
    systemctl start vm-agent

# Write files
write_files:
  - path: /etc/workspace/config.json
    content: |
      {
        "workspace_id": "{{ workspace_id }}",
        "repository": "{{ repository }}",
        "branch": "{{ branch }}",
        "control_plane_url": "{{ control_plane_url }}"
      }
    permissions: '0644'

# Final message
final_message: "Simple Agent Manager workspace {{ workspace_id }} provisioning started!"
`;
