/**
 * Cloud-init template for VM provisioning.
 * Uses mustache-style {{ variable }} placeholders.
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

  # Clone repository
  - |
    mkdir -p /home/workspace
    cd /home/workspace
    git clone https://x-access-token:{{ github_token }}@github.com/{{ repository }}.git workspace
    cd workspace
    git checkout {{ branch }}
    chown -R workspace:workspace /home/workspace

  # Install devcontainers CLI
  - npm install -g @devcontainers/cli

  # Build and start devcontainer
  - |
    cd /home/workspace/workspace
    if [ -f .devcontainer/devcontainer.json ] || [ -d .devcontainer ]; then
      devcontainer build --workspace-folder .
      devcontainer up --workspace-folder . --remove-existing-container
    fi

  # Create VM Agent systemd service
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
    ExecStart=/usr/local/bin/vm-agent
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF
    systemctl daemon-reload
    systemctl enable vm-agent
    systemctl start vm-agent

  # Signal workspace is ready
  - |
    curl -X POST "{{ control_plane_url }}/api/workspaces/{{ workspace_id }}/ready" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer {{ callback_token }}"

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
final_message: "Cloud AI Workspace {{ workspace_id }} is ready!"
`;
