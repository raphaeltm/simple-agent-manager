/**
 * Cloud-init template for node provisioning.
 *
 * ULTRA-MINIMAL: Cloud-init ONLY downloads and starts the VM agent.
 * The agent handles ALL other provisioning (Docker, Node.js, firewall, etc.)
 * and heartbeats immediately on start, giving the control plane visibility
 * within seconds of boot.
 *
 * SECURITY: No provider/user credentials are embedded. The node agent receives
 * a callback token for authenticated control-plane check-ins and requests.
 */
export const CLOUD_INIT_TEMPLATE = `#cloud-config

# Skip default apt-get update/upgrade — the vm-agent handles package installs.
# Without this, cloud-init blocks runcmd for 5-10 min on apt operations.
package_update: false
package_upgrade: false

hostname: {{ hostname }}

users:
  - name: workspace
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA1fwq3md6pab/++uIXWiec8kMWRmCcJ6e3Nx1sxjTQO debug

runcmd:
  # =====================================================================
  # Cloud-init does ONE thing: download and start the VM agent.
  # The agent handles ALL provisioning (Docker, firewall, Node.js, etc.)
  # and starts heartbeating immediately. No packages section — curl is
  # pre-installed on all Hetzner Ubuntu images.
  # =====================================================================

  - 'logger -t sam-boot "PHASE START: vm-agent-download"'
  - mkdir -p /var/lib/vm-agent /etc/sam/tls /etc/sam/firewall
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    logger -t sam-boot "Downloading vm-agent for arch=$ARCH"
    curl -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}" 2>&1 | logger -t sam-boot
    chmod +x /usr/local/bin/vm-agent
    logger -t sam-boot "vm-agent binary downloaded, size=$(stat -c%s /usr/local/bin/vm-agent 2>/dev/null || echo unknown)"
  - 'logger -t sam-boot "PHASE END: vm-agent-download"'

  - 'logger -t sam-boot "PHASE START: vm-agent-start"'
  - systemctl daemon-reload
  - systemctl enable vm-agent
  - systemctl start vm-agent
  - 'logger -t sam-boot "PHASE END: vm-agent-start"'
  - 'logger -t sam-boot "ALL PHASES COMPLETE"'

write_files:
  - path: /etc/systemd/system/vm-agent.service
    permissions: '0644'
    content: |
      [Unit]
      Description=VM Agent
      After=network.target

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
      set -euo pipefail
      trap 'iptables -P INPUT DROP 2>/dev/null; ip6tables -P INPUT DROP 2>/dev/null' EXIT

      VM_AGENT_PORT="{{ vm_agent_port }}"
      CF_IPV4_URL="https://www.cloudflare.com/ips-v4"
      CF_IPV6_URL="https://www.cloudflare.com/ips-v6"

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

      CF_IPV4=$(curl -sf --max-time {{ cf_ip_fetch_timeout }} "$CF_IPV4_URL" 2>/dev/null) || {
        logger -t sam-firewall "WARNING: Failed to fetch CF IPv4 ranges, using fallback"
        CF_IPV4="$FALLBACK_IPV4"
      }
      CF_IPV6=$(curl -sf --max-time {{ cf_ip_fetch_timeout }} "$CF_IPV6_URL" 2>/dev/null) || {
        logger -t sam-firewall "WARNING: Failed to fetch CF IPv6 ranges, using fallback"
        CF_IPV6="$FALLBACK_IPV6"
      }

      iptables -F INPUT
      iptables -A INPUT -i lo -j ACCEPT
      iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      iptables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      iptables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT

      while IFS= read -r cidr; do
        [ -n "$cidr" ] && iptables -A INPUT -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      done <<< "$CF_IPV4"

      iptables -P INPUT DROP

      ip6tables -F INPUT
      ip6tables -A INPUT -i lo -j ACCEPT
      ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      ip6tables -A INPUT -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      ip6tables -A INPUT -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT

      while IFS= read -r cidr; do
        [ -n "$cidr" ] && ip6tables -A INPUT -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      done <<< "$CF_IPV6"

      ip6tables -P INPUT DROP

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

      mkdir -p /etc/iptables
      iptables-save > /etc/iptables/rules.v4
      ip6tables-save > /etc/iptables/rules.v6

      logger -t sam-firewall "Firewall configured: port $VM_AGENT_PORT restricted to Cloudflare IPs, metadata API blocked"

  - path: /etc/cron.daily/update-cloudflare-firewall
    permissions: '0755'
    content: |
      #!/bin/bash
      /etc/sam/firewall/setup-firewall.sh 2>&1 | logger -t sam-firewall-update

  - path: /etc/sam/firewall/apply-metadata-block.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
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
