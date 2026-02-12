/**
 * Cloud-init template for node provisioning.
 *
 * SECURITY: No provider/user credentials are embedded. The node agent receives
 * a callback token for authenticated control-plane check-ins and requests.
 */
export const CLOUD_INIT_TEMPLATE = `#cloud-config

hostname: {{ hostname }}

users:
  - name: workspace
    groups: sudo, docker
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: []

packages:
  - docker.io
  - docker-compose
  - git
  - curl
  - wget
  - jq
  - htop
  - vim

runcmd:
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker workspace

  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}"
    chmod +x /usr/local/bin/vm-agent

  - |
    cat > /etc/systemd/system/vm-agent.service << 'UNIT'
    [Unit]
    Description=VM Agent
    After=network.target docker.service
    Requires=docker.service

    [Service]
    Type=simple
    User=root
    Environment=NODE_ID={{ node_id }}
    Environment=CONTROL_PLANE_URL={{ control_plane_url }}
    Environment=JWKS_ENDPOINT={{ jwks_url }}
    Environment=CALLBACK_TOKEN={{ callback_token }}
    Environment=IDLE_TIMEOUT=0s
    ExecStart=/usr/local/bin/vm-agent
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    UNIT
    systemctl daemon-reload
    systemctl enable vm-agent
    systemctl start vm-agent

  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - npm install -g @devcontainers/cli || true

write_files:
  - path: /etc/workspace/config.json
    content: |
      {
        "node_id": "{{ node_id }}",
        "control_plane_url": "{{ control_plane_url }}"
      }
    permissions: '0644'

final_message: "Simple Agent Manager node {{ node_id }} provisioning started!"
`;
