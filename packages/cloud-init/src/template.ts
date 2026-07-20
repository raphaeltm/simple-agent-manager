/**
 * Cloud-init template for node provisioning.
 *
 * ULTRA-MINIMAL: Cloud-init downloads and starts the VM agent, then performs
 * role-specific bootstrap. For deployment nodes, that includes installing and
 * enabling Caddy. Starting the agent first keeps provisioning observable while
 * release-apply retry semantics handle dependencies that are still converging.
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

runcmd:
  # =====================================================================
  # Cloud-init keeps bootstrap minimal: download vm-agent, perform
  # start vm-agent, then perform role-specific service setup required before
  # traffic can be served. The agent handles Docker, firewall, Node.js, release
  # apply, and heartbeats; release apply remains retryable while role-specific
  # dependencies are still converging.
  # =====================================================================

  # Disable automatic OS upgrades — ephemeral VMs gain nothing from them
  # and unattended-upgrades can trigger systemd daemon-reexec which kills
  # the vm-agent mid-work. Must run before vm-agent starts.
  - systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true
  - systemctl disable --now unattended-upgrades || true
  - chage -E -1 -M -1 -d "$(date +%Y-%m-%d)" root || true

  - 'logger -t sam-boot "PHASE START: swap-setup"'
  - |
    SWAP_SIZE_MB="{{ swap_size_mb }}"
    SWAP_SWAPPINESS="{{ swap_swappiness }}"
    if [ "$SWAP_SIZE_MB" -gt 0 ] 2>/dev/null; then
      logger -t sam-boot "Configuring \${SWAP_SIZE_MB}MB swap file"
      fallocate -l "\${SWAP_SIZE_MB}M" /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
      sysctl -w "vm.swappiness=\${SWAP_SWAPPINESS}"
      logger -t sam-boot "Swap configured: \${SWAP_SIZE_MB}MB, swappiness=\${SWAP_SWAPPINESS}"
    else
      logger -t sam-boot "Swap disabled (SWAP_SIZE_MB=0)"
    fi
  - 'logger -t sam-boot "PHASE END: swap-setup"'

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

  - 'logger -t sam-boot "PHASE START: origin-ca-bootstrap"'
  - |
    ORIGIN_CA_CERTIFICATE_URL="{{ origin_ca_certificate_url }}"
    TLS_CERT_PATH="/etc/sam/tls/origin-ca.pem"
    TLS_KEY_PATH="/etc/sam/tls/origin-ca-key.pem"
    TLS_CSR_PATH="/etc/sam/tls/origin-ca.csr"
    if [ -n "$ORIGIN_CA_CERTIFICATE_URL" ]; then
      logger -t sam-boot "Generating node-local Origin CA private key and CSR"
      ORIGIN_CA_OK=true
      if [ ! -s "$TLS_KEY_PATH" ]; then
        if openssl genrsa -out "$TLS_KEY_PATH" 2048 >/dev/null 2>&1; then
          chmod 600 "$TLS_KEY_PATH"
          logger -t sam-boot "RSA key generated"
        else
          logger -t sam-boot "ERROR: openssl genrsa failed"
          ORIGIN_CA_OK=false
        fi
      fi
      if [ "$ORIGIN_CA_OK" = true ]; then
        if openssl req -new -key "$TLS_KEY_PATH" -out "$TLS_CSR_PATH" -subj "/CN={{ node_id }}" >/dev/null 2>&1; then
          logger -t sam-boot "CSR generated"
        else
          logger -t sam-boot "ERROR: openssl req (CSR generation) failed"
          ORIGIN_CA_OK=false
        fi
      fi
      if [ "$ORIGIN_CA_OK" = true ]; then
        CURL_EXIT=0
        HTTP_CODE=$(curl -sS -o "$TLS_CERT_PATH" -w '%{http_code}' -X POST \
          -H "Authorization: Bearer {{ callback_token }}" \
          -H "Content-Type: text/plain" \
          --data-binary "@$TLS_CSR_PATH" \
          "$ORIGIN_CA_CERTIFICATE_URL" 2>/tmp/origin-ca-curl-err) || {
          CURL_EXIT=$?
          HTTP_CODE="000"
        }
        CURL_ERR=$(cat /tmp/origin-ca-curl-err 2>/dev/null)
        rm -f /tmp/origin-ca-curl-err
        logger -t sam-boot "Origin CA cert request: HTTP=$HTTP_CODE curl_exit=$CURL_EXIT"
        if [ -n "$CURL_ERR" ]; then
          logger -t sam-boot "Origin CA curl stderr: $CURL_ERR"
        fi
        if [ "$CURL_EXIT" -ne 0 ] || { [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; }; then
          logger -t sam-boot "ERROR: Origin CA certificate request failed (HTTP $HTTP_CODE curl_exit=$CURL_EXIT)"
          ORIGIN_CA_OK=false
        fi
      fi
      rm -f "$TLS_CSR_PATH"
      if [ "$ORIGIN_CA_OK" = true ] && [ -s "$TLS_CERT_PATH" ]; then
        chmod 0644 "$TLS_CERT_PATH"
        logger -t sam-boot "Node-local Origin CA certificate installed"
      else
        logger -t sam-boot "ERROR: Origin CA bootstrap failed — refusing to start vm-agent without TLS"
        rm -f "$TLS_CERT_PATH" "$TLS_KEY_PATH" "$TLS_CSR_PATH"
        exit 1
      fi
    else
      logger -t sam-boot "Skipping Origin CA bootstrap; TLS disabled"
    fi
  - 'logger -t sam-boot "PHASE END: origin-ca-bootstrap"'

  - 'logger -t sam-boot "PHASE START: vm-agent-start"'
  - systemctl daemon-reload
  - systemctl enable vm-agent
  - systemctl start vm-agent
  - 'logger -t sam-boot "PHASE END: vm-agent-start"'

  - 'logger -t sam-boot "PHASE START: caddy-setup"'
  - |
    set -eu
    ROLE="{{ role }}"
    if [ "$ROLE" = "deployment" ]; then
      logger -t sam-boot "Preparing Caddy paths for deployment node routing"
      mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
      logger -t sam-boot "Caddy paths ready; vm-agent owns Caddy install/start"
    else
      logger -t sam-boot "Skipping Caddy setup for ROLE=$ROLE"
    fi
  - 'logger -t sam-boot "PHASE END: caddy-setup"'
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
      Environment=CALLBACK_TOKEN_FILE=/etc/sam/callback-token
      Environment=PROJECT_ID={{ project_id }}
      Environment=CHAT_SESSION_ID={{ chat_session_id }}
      Environment=TASK_ID={{ task_id }}
      Environment=TASK_MODE={{ task_mode }}
      Environment=VM_AGENT_PORT={{ vm_agent_port }}
      Environment=TLS_CERT_PATH={{ tls_cert_path }}
      Environment=TLS_KEY_PATH={{ tls_key_path }}
      Environment=PROVIDER={{ provider }}
      Environment=DEVCONTAINER_CACHE_ENABLED={{ devcontainer_cache_enabled }}
      Environment=ROLE={{ role }}
      Environment=NODE_ROLE={{ role }}
      Environment=ENVIRONMENT_ID={{ environment_id }}
      Environment=DEPLOY_SIGNING_PUB_KEY={{ deploy_signing_pub_key }}
      Environment=DEPLOY_ACME_EMAIL={{ deploy_acme_email }}
      Environment=DEPLOY_ACME_CA={{ deploy_acme_ca }}
      Environment="DEPLOY_COMPOSE_CMD={{ deploy_compose_cmd }}"
      Environment=DEPLOY_HEALTH_TIMEOUT={{ deploy_health_timeout }}
      ExecStart=/usr/local/bin/vm-agent
      Restart=always
      RestartSec=5

      [Install]
      WantedBy=multi-user.target

  - path: /etc/caddy/Caddyfile
    permissions: '0644'
    content: |
      # Managed by SAM deployment agent.
      # Release applies replace this file and run caddy reload.
      {
        auto_https off
      }

      :80 {
        respond "SAM deployment node awaiting release" 200
      }

  - path: /etc/sam/callback-token
    permissions: '0600'
    owner: root:root
    content: |
      {{ callback_token }}

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
      #
      # Policy: INPUT chain stays ACCEPT. A single targeted DROP rule is
      # appended LAST for tcp dport VM_AGENT_PORT so only the explicit CF
      # ACCEPT rules (and loopback / docker bridges) can reach the agent port.
      # Outbound connections and their replies are unaffected — we do NOT rely
      # on conntrack to let reply packets back in, because conntrack state is
      # invalidated by Docker install + restart + veth churn and the resulting
      # silent drops caused a sustained ~6-minute "Cloudflare API unreachable"
      # window on every fresh boot.
      set -euo pipefail
      # NOTE: intentionally no EXIT trap that clamps policy to DROP. A failed
      # script must not lock the box out — the previous trap caused total
      # blackouts when any earlier step errored before ACCEPT rules were added.

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

      # IPv4: policy ACCEPT so outbound reply packets are never dropped when
      # conntrack state is invalidated (the root cause of the 6-minute Cloudflare
      # blackout after Docker install + restart). Restriction is via targeted
      # DROP rules on specific ports. The Hetzner cloud firewall remains the
      # primary ingress gate; iptables is defense in depth against misconfig.
      #
      # Rule installation order (critical): install DROPs FIRST (so the agent
      # port is never unprotected during a re-apply), then INSERT ACCEPT rules
      # at position 1 so they take precedence. INSERT order is reverse of
      # final priority — last -I becomes rule #1.
      iptables -P INPUT ACCEPT
      iptables -F INPUT

      # Catch-all DROPs installed FIRST. TCP+UDP on the agent port blocks both
      # service traffic and port-fingerprinting via ICMP unreachable replies.
      # TCP :22 defense-in-depth against sshd exposure — Hetzner console works
      # without iptables SSH access for operator emergencies.
      iptables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP
      iptables -A INPUT -p udp --dport "$VM_AGENT_PORT" -j DROP
      iptables -A INPUT -p tcp --dport 22 -j DROP

      # INSERT CF ACCEPT rules for VM_AGENT_PORT at top of chain.
      while IFS= read -r cidr; do
        [ -n "$cidr" ] && iptables -I INPUT 1 -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      done <<< "$CF_IPV4"

      # INSERT trusted-interface ACCEPTs (lo last so it is rule #1 — loopback
      # traffic, including localhost-to-sshd for operator tooling, is never
      # filtered by the port-22 DROP above).
      iptables -I INPUT 1 -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      iptables -I INPUT 1 -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
      iptables -I INPUT 1 -i lo -j ACCEPT

      # IPv6: same pattern. Load the kernel module first — some Hetzner
      # images ship without ip6_tables loaded, causing all ip6tables
      # commands to fail ("ip6tables: No chain/target/match by that name").
      if modprobe ip6_tables 2>/dev/null && ip6tables -L -n >/dev/null 2>&1; then
        ip6tables -P INPUT ACCEPT
        ip6tables -F INPUT

        ip6tables -A INPUT -p tcp --dport "$VM_AGENT_PORT" -j DROP
        ip6tables -A INPUT -p udp --dport "$VM_AGENT_PORT" -j DROP
        ip6tables -A INPUT -p tcp --dport 22 -j DROP

        while IFS= read -r cidr; do
          [ -n "$cidr" ] && ip6tables -I INPUT 1 -s "$cidr" -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
        done <<< "$CF_IPV6"

        ip6tables -I INPUT 1 -i br-+ -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
        ip6tables -I INPUT 1 -i docker0 -p tcp --dport "$VM_AGENT_PORT" -j ACCEPT
        ip6tables -I INPUT 1 -i lo -j ACCEPT
      else
        logger -t sam-firewall "WARNING: ip6tables unavailable (kernel module not loaded), skipping IPv6 firewall rules"
      fi

      mkdir -p /etc/iptables
      iptables-save > /etc/iptables/rules.v4
      ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true

      logger -t sam-firewall "Firewall configured: port $VM_AGENT_PORT restricted to Cloudflare IPs; metadata API block deferred until Docker restart"

  - path: /etc/iptables/rules.v4
    permissions: '0644'
    content: |
      *filter
      :INPUT ACCEPT [0:0]
      :FORWARD ACCEPT [0:0]
      :OUTPUT ACCEPT [0:0]
      COMMIT

  - path: /etc/iptables/rules.v6
    permissions: '0644'
    content: |
      *filter
      :INPUT ACCEPT [0:0]
      :FORWARD ACCEPT [0:0]
      :OUTPUT ACCEPT [0:0]
      COMMIT

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

  - path: /etc/sysctl.d/99-sam-swap.conf
    content: |
      vm.swappiness={{ swap_swappiness }}
    permissions: '0644'

  - path: /etc/docker/daemon.json
    content: |
      {
        "log-driver": "journald",
        "log-opts": {
          "tag": "docker/{{ docker_name_tag }}"
        },
        "dns": [{{ docker_dns_servers }}],
        "live-restore": true
      }
    permissions: '0644'

  - path: /etc/apt/apt.conf.d/80-retries
    content: |
      Acquire::Retries "3";
      Acquire::http::Timeout "30";
      Acquire::https::Timeout "30";
    permissions: '0644'

  - path: /etc/sam/apt-mirror-config.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Provider-specific apt mirror configuration for Docker containers.
      # Sourced by the VM agent bootstrap to inject fast mirrors into containers.
      # Only overrides for providers with known fast local mirrors.
      PROVIDER="{{ provider }}"
      case "$PROVIDER" in
        hetzner)
          APT_MIRROR="mirror.hetzner.com"
          ;;
        *)
          APT_MIRROR=""
          ;;
      esac
      export APT_MIRROR

final_message: "Simple Agent Manager node {{ node_id }} provisioning started!"
`;
