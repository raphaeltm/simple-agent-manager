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
  # =====================================================================
  # Minimal cloud-init: Docker + VM Agent only.
  # All other provisioning (firewall, Node.js, devcontainer CLI, image
  # pulls, Docker restart) is handled by the vm-agent's provision package.
  # This gets the agent heartbeating in ~60s instead of 8-12 minutes.
  # =====================================================================

  - logger -t sam-boot "PHASE START: docker"
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker workspace
  - logger -t sam-boot "PHASE END: docker"

  - logger -t sam-boot "PHASE START: vm-agent-download"
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}"
    chmod +x /usr/local/bin/vm-agent
  - logger -t sam-boot "PHASE END: vm-agent-download"

  - logger -t sam-boot "PHASE START: vm-agent-start"
  - |
    cat > /etc/systemd/system/vm-agent.service << 'UNIT'
    [Unit]
    Description=VM Agent
    After=network.target docker.service

    [Service]
    Type=simple
    User=root
    Environment=NODE_ID={{ node_id }}
    Environment=CONTROL_PLANE_URL={{ control_plane_url }}
    Environment=JWKS_ENDPOINT={{ jwks_url }}
    Environment=CALLBACK_TOKEN={{ callback_token }}
    Environment=PROJECT_ID={{ project_id }}
    Environment=CHAT_SESSION_ID={{ chat_session_id }}
    Environment=TASK_ID={{ task_id }}
    Environment=TASK_MODE={{ task_mode }}
    Environment=VM_AGENT_PORT={{ vm_agent_port }}
    Environment=TLS_CERT_PATH={{ tls_cert_path }}
    Environment=TLS_KEY_PATH={{ tls_key_path }}
    ExecStart=/usr/local/bin/vm-agent
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    UNIT
    systemctl daemon-reload
    systemctl enable vm-agent
    systemctl start vm-agent
  - logger -t sam-boot "PHASE END: vm-agent-start"
  - logger -t sam-boot "ALL PHASES COMPLETE"

write_files:
  - path: /etc/systemd/journald.conf.d/sam.conf
    content: |
      [Journal]
      Storage=persistent
      Compress=yes
      SystemMaxUse={{ log_journal_max_use }}
      SystemKeepFree={{ log_journal_keep_free }}
      MaxRetentionSec={{ log_journal_max_retention }}
    permissions: '0644'

  - path: /etc/docker/daemon.json
    content: |
      {
        "log-driver": "journald",
        "log-opts": {
          "tag": "docker/{{ docker_name_tag }}"
        },
        "dns": [{{ docker_dns_servers }}]
      }
    permissions: '0644'

  - path: /etc/workspace/config.json
    content: |
      {
        "node_id": "{{ node_id }}",
        "control_plane_url": "{{ control_plane_url }}"
      }
    permissions: '0644'

  - path: /etc/sam/firewall/setup-firewall.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # SAM Firewall — restricts VM agent port to Cloudflare IPs only.
      # Fetches current Cloudflare IP ranges dynamically; falls back to
      # embedded defaults if the fetch fails. Run at boot via cloud-init
      # and daily via /etc/cron.daily/update-cloudflare-firewall.
      set -euo pipefail

      # Ensure DROP policy is always applied, even if the script exits early
      # due to a malformed CIDR or unexpected error mid-execution.
      trap 'iptables -P INPUT DROP 2>/dev/null; ip6tables -P INPUT DROP 2>/dev/null' EXIT

      VM_AGENT_PORT="{{ vm_agent_port }}"
      CF_IPV4_URL="https://www.cloudflare.com/ips-v4"
      CF_IPV6_URL="https://www.cloudflare.com/ips-v6"

      # Embedded fallback Cloudflare IP ranges (updated 2025-05)
      # Source: https://www.cloudflare.com/ips/
      FALLBACK_IPV4="173.245.48.0/20
      103.21.244.0/22
      103.22.200.0/22
      103.31.4.0/22
      141.101.64.0/18
      108.162.192.0/18
      190.93.240.0/20
      188.114.96.0/20
      197.234.240.0/22
      198.41.128.0/17
      162.158.0.0/15
      104.16.0.0/13
      104.24.0.0/14
      172.64.0.0/13
      131.0.72.0/22"

      FALLBACK_IPV6="2400:cb00::/32
      2606:4700::/32
      2803:f800::/32
      2405:b500::/32
      2405:8100::/32
      2a06:98c0::/29
      2c0f:f248::/32"

      # Fetch Cloudflare IPs (with fallback to embedded defaults)
      CF_IPV4=$(curl -sf --max-time {{ cf_ip_fetch_timeout }} "$CF_IPV4_URL" 2>/dev/null) || {
        logger -t sam-firewall "WARNING: Failed to fetch CF IPv4 ranges, using fallback"
        CF_IPV4="$FALLBACK_IPV4"
      }
      CF_IPV6=$(curl -sf --max-time {{ cf_ip_fetch_timeout }} "$CF_IPV6_URL" 2>/dev/null) || {
        logger -t sam-firewall "WARNING: Failed to fetch CF IPv6 ranges, using fallback"
        CF_IPV6="$FALLBACK_IPV6"
      }

      # --- IPv4 rules ---
      # Flush INPUT chain only (preserves Docker FORWARD/NAT chains)
      iptables -F INPUT

      # Allow loopback
      iptables -A INPUT -i lo -j ACCEPT

      # Allow established/related connections (outbound traffic responses)
      iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

      # Allow Docker bridge traffic to VM agent port (container-to-host communication)
      iptables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      iptables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT

      # Allow Cloudflare IPs on VM agent port
      while IFS= read -r cidr; do
        [ -n "$cidr" ] && iptables -A INPUT -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      done <<< "$CF_IPV4"

      # Drop all other inbound traffic (blocks SSH, direct IP access, etc.)
      iptables -P INPUT DROP

      # --- IPv6 rules ---
      ip6tables -F INPUT
      ip6tables -A INPUT -i lo -j ACCEPT
      ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      ip6tables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      ip6tables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT

      while IFS= read -r cidr; do
        [ -n "$cidr" ] && ip6tables -A INPUT -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      done <<< "$CF_IPV6"

      ip6tables -P INPUT DROP

      # --- Block container access to cloud metadata API ---
      # Delegates to apply-metadata-block.sh which manages the DOCKER-USER chain.
      # Wait for Docker to create DOCKER-USER chain (up to 30s) since there is a
      # brief race window between "systemctl start docker" returning and chain creation.
      DOCKER_USER_WAIT=0
      while ! iptables -L DOCKER-USER -n >/dev/null 2>&1; do
        if [ "$DOCKER_USER_WAIT" -ge 30 ]; then
          logger -t sam-firewall "WARNING: DOCKER-USER chain not available after 30s, skipping metadata block"
          break
        fi
        sleep 1
        DOCKER_USER_WAIT=$((DOCKER_USER_WAIT + 1))
      done
      /etc/sam/firewall/apply-metadata-block.sh || logger -t sam-firewall "WARNING: metadata block script failed"

      # Persist rules across reboots
      mkdir -p /etc/iptables
      iptables-save > /etc/iptables/rules.v4
      ip6tables-save > /etc/iptables/rules.v6

      logger -t sam-firewall "Firewall configured: port $VM_AGENT_PORT restricted to Cloudflare IPs, metadata API blocked"

  - path: /etc/cron.daily/update-cloudflare-firewall
    permissions: '0755'
    content: |
      #!/bin/bash
      # Daily refresh of Cloudflare IP ranges for the SAM firewall.
      /etc/sam/firewall/setup-firewall.sh 2>&1 | logger -t sam-firewall-update

  - path: /etc/sam/firewall/apply-metadata-block.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Applies DOCKER-USER chain rules to block container access to the
      # cloud metadata API. Called by sam-metadata-block.service after Docker
      # starts, and by setup-firewall.sh during initial provisioning / daily cron.
      set -euo pipefail
      # Cloud metadata API is IPv4-only (169.254.169.254). No ip6tables rules needed
      # since ip6tables rejects IPv4 addresses as invalid.
      METADATA_IP="169.254.169.254"
      if iptables -L DOCKER-USER -n >/dev/null 2>&1; then
        iptables -D DOCKER-USER -d "$METADATA_IP" -j DROP 2>/dev/null || true
        iptables -I DOCKER-USER 1 -d "$METADATA_IP" -j DROP
        logger -t sam-firewall "Metadata API blocked for containers (DOCKER-USER chain)"
      else
        logger -t sam-firewall "WARNING: DOCKER-USER chain not found, cannot block metadata API"
      fi

  - path: /etc/systemd/system/sam-metadata-block.service
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM metadata API block for Docker containers
      After=docker.service
      Requires=docker.service
      PartOf=docker.service

      [Service]
      Type=oneshot
      ExecStart=/etc/sam/firewall/apply-metadata-block.sh
      RemainAfterExit=yes

      [Install]
      WantedBy=multi-user.target

  - path: /etc/sam/tls/origin-ca.pem
    content: |
      {{ origin_ca_cert }}
    permissions: '0644'

  - path: /etc/sam/tls/origin-ca-key.pem
    content: |
      {{ origin_ca_key }}
    permissions: '0600'

final_message: "Simple Agent Manager node {{ node_id }} provisioning started!"
`;
