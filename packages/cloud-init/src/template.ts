/**
 * Cloud-init template for VM provisioning.
 * Uses mustache-style {{ variable }} placeholders.
 *
 * SECURITY: No sensitive tokens are embedded in this template.
 * The VM agent redeems a bootstrap token on startup to receive credentials.
 *
 * ORDERING: VM Agent download + start is placed BEFORE optional npm installs
 * so the agent can redeem the bootstrap token before it expires (15min TTL).
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

# Enable and start Docker, then download and start VM Agent ASAP
runcmd:
  # Enable Docker
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker workspace

  # Download and install VM Agent (do this early, before optional npm installs)
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}"
    chmod +x /usr/local/bin/vm-agent

  # Create and start VM Agent systemd service immediately
  # The agent redeems the bootstrap token to get credentials on startup.
  # This MUST happen before the bootstrap token expires (15min TTL).
  - |
    cat > /etc/systemd/system/vm-agent.service << 'UNIT'
    [Unit]
    Description=VM Agent
    After=network.target docker.service
    Requires=docker.service

    [Service]
    Type=simple
    User=root
    Environment=WORKSPACE_ID={{ workspace_id }}
    Environment=CONTROL_PLANE_URL={{ control_plane_url }}
    Environment=JWKS_ENDPOINT={{ jwks_url }}
    Environment=BOOTSTRAP_TOKEN={{ bootstrap_token }}
    Environment=REPOSITORY={{ repository }}
    Environment=BRANCH={{ branch }}
    Environment=IDLE_TIMEOUT={{ idle_timeout }}
    ExecStart=/usr/local/bin/vm-agent
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    UNIT
    systemctl daemon-reload
    systemctl enable vm-agent
    systemctl start vm-agent

  # Install Node.js (required for devcontainers CLI and ACP adapters)
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs

  # Install devcontainers CLI (optional, VM agent handles devcontainer setup)
  - npm install -g @devcontainers/cli || true

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
