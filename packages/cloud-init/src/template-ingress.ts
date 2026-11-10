/**
 * Ingress-mode fragments of the cloud-init template. A node uses exactly one
 * ingress mode, and user-data must stay under the 32 KB Hetzner limit, so each
 * mode's blocks are rendered only for that mode (see `ingressFragments`).
 *
 * - Direct (legacy): Origin CA bootstrap; the agent serves TLS on its public
 *   port, restricted to Cloudflare IPs by the firewall.
 * - Tunnel: pinned cloudflared connector; no public agent ingress at all.
 */

/** Direct mode: node-local Origin CA key/CSR, signed by the control plane. */
export const ORIGIN_CA_BOOTSTRAP_RUNCMD = `  - 'logger -t sam-boot "PHASE START: origin-ca-bootstrap"'
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
        ATTEMPT=1
        DELAY={{ cert_base_delay_seconds }}
        ORIGIN_CA_OK=false
        while [ "$ATTEMPT" -le {{ cert_max_attempts }} ]; do
          CURL_EXIT=0
          HTTP_CODE=$(curl -sS --max-time {{ cert_request_timeout_seconds }} -o "$TLS_CERT_PATH" -w '%{http_code}' -X POST \\
            -H "Authorization: Bearer $(cat /etc/sam/callback-token)" \\
            -H "Content-Type: text/plain" \\
            --data-binary "@$TLS_CSR_PATH" \\
            "$ORIGIN_CA_CERTIFICATE_URL" 2>/dev/null) || CURL_EXIT=$?
          logger -t sam-boot "Origin CA cert request: attempt=$ATTEMPT HTTP=$HTTP_CODE curl_exit=$CURL_EXIT"
          if [ "$CURL_EXIT" -eq 0 ] && { [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; }; then
            if openssl x509 -in "$TLS_CERT_PATH" -noout >/dev/null 2>&1; then
              ORIGIN_CA_OK=true
              break
            fi
            logger -t sam-boot "ERROR: Origin CA response was not a certificate"
            break
          fi
          # Auth/input failures cannot heal through retries. Transport/429/5xx can.
          if [ "$CURL_EXIT" -eq 0 ]; then
            case "$HTTP_CODE" in 429|5??) ;; *) break ;; esac
          fi
          if [ "$ATTEMPT" -ge {{ cert_max_attempts }} ]; then break; fi
          if [ "$DELAY" -gt {{ cert_max_delay_seconds }} ]; then DELAY={{ cert_max_delay_seconds }}; fi
          sleep "$DELAY"
          DELAY=$((DELAY * 2))
          ATTEMPT=$((ATTEMPT + 1))
        done
      fi
      rm -f "$TLS_CSR_PATH"
      if [ "$ORIGIN_CA_OK" = true ] && [ -s "$TLS_CERT_PATH" ]; then
        chmod 0644 "$TLS_CERT_PATH"
        logger -t sam-boot "Node-local Origin CA certificate installed"
      else
        logger -t sam-boot "ERROR: Origin CA bootstrap failed — refusing to start vm-agent without TLS"
        rm -f "$TLS_CERT_PATH" "$TLS_KEY_PATH" "$TLS_CSR_PATH"
        /usr/local/sbin/sam-boot-failure origin_ca_bootstrap
        exit 1
      fi
    else
      logger -t sam-boot "Skipping Origin CA bootstrap; TLS disabled"
    fi
  - 'logger -t sam-boot "PHASE END: origin-ca-bootstrap"'`;

/**
 * Tunnel mode: install the pinned connector, write its token, and close public
 * ingress BEFORE the vm-agent listens.
 */
export const TUNNEL_BOOTSTRAP_RUNCMD = `  - 'logger -t sam-boot "PHASE START: tunnel-bootstrap"'
  - |
    case $(uname -m) in
      x86_64) CF_ARCH=amd64 CF_SHA256={{ cloudflared_sha256_amd64 }} ;;
      aarch64) CF_ARCH=arm64 CF_SHA256={{ cloudflared_sha256_arm64 }} ;;
      *) CF_ARCH="" ;;
    esac
    CF_TMP=$(mktemp)
    if [ -z "$CF_ARCH" ] || ! curl --max-time {{ agent_download_timeout_seconds }} -fsSLo "$CF_TMP" "{{ cloudflared_url }}-$CF_ARCH" ||
      [ "$(sha256sum "$CF_TMP" | cut -d' ' -f1)" != "$CF_SHA256" ]; then
      rm -f "$CF_TMP"
      /usr/local/sbin/sam-boot-failure cloudflared_install
      exit 1
    fi
    install -m 0755 "$CF_TMP" /usr/local/bin/cloudflared
    rm -f "$CF_TMP"
    id sam-cloudflared >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin sam-cloudflared
    (umask 077; printf '%s' '{{ tunnel_token }}' > /etc/sam/cloudflared/tunnel-token)
    chown sam-cloudflared /etc/sam/cloudflared/tunnel-token
    chmod 0400 /etc/sam/cloudflared/tunnel-token
    if ! /etc/sam/firewall/setup-firewall.sh; then
      /usr/local/sbin/sam-boot-failure tunnel_firewall
      exit 1
    fi
    logger -t sam-boot "cloudflared installed (sha256 verified); public agent/SSH ingress closed"
  - 'logger -t sam-boot "PHASE END: tunnel-bootstrap"'`;

/**
 * Tunnel mode: start the connector once the agent runs. The unit's
 * ExecStartPre waits for the agent's loopback tunnel listener.
 */
export const TUNNEL_CONNECTOR_RUNCMD = `  - 'logger -t sam-boot "PHASE START: tunnel-connector"'
  - |
    if ! systemctl enable --now sam-cloudflared.service; then
      /usr/local/sbin/sam-boot-failure tunnel_connector
      exit 1
    fi
  - 'logger -t sam-boot "PHASE END: tunnel-connector"'`;

/**
 * Tunnel mode: the connector unit. ExecStartPre gates every start, including
 * restarts and reboots, on the agent's loopback tunnel listener answering.
 */
export const TUNNEL_WRITE_FILES = `  - path: /usr/local/sbin/sam-wait-tunnel-listener
    permissions: '0755'
    content: |
      #!/bin/sh
      # Expose nothing until the vm-agent's loopback tunnel listener answers.
      i=0
      until curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:{{ tunnel_port }}/health"; do
        i=$((i + 1))
        if [ "$i" -ge {{ tunnel_listener_wait_seconds }} ]; then
          logger -t sam-tunnel "tunnel listener 127.0.0.1:{{ tunnel_port }} not ready"
          exit 1
        fi
        sleep 1
      done

  - path: /etc/systemd/system/sam-cloudflared.service
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM Cloudflare Tunnel connector
      After=network-online.target vm-agent.service
      Wants=network-online.target
      StartLimitIntervalSec=0

      [Service]
      User=sam-cloudflared
      ExecStartPre=/usr/local/sbin/sam-wait-tunnel-listener
      ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/sam/cloudflared/tunnel-token
      TimeoutStartSec=infinity
      Restart=always
      RestartSec=5
      Slice=sam-infra.slice
      NoNewPrivileges=yes
      ProtectSystem=strict
      ProtectHome=yes
      PrivateTmp=yes
      PrivateDevices=yes
      ProtectKernelTunables=yes
      ProtectKernelModules=yes
      ProtectControlGroups=yes
      ProtectClock=yes
      ProtectHostname=yes
      RestrictSUIDSGID=yes
      RestrictRealtime=yes
      LockPersonality=yes
      RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
      CapabilityBoundingSet=

      [Install]
      WantedBy=multi-user.target`;

/**
 * Direct mode: restrict the agent port to Cloudflare IPs, refreshed daily.
 * Run by the vm-agent's provisioning after it starts listening.
 */
export const DIRECT_FIREWALL_WRITE_FILE = `  - path: /etc/sam/firewall/setup-firewall.sh
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

      logger -t sam-firewall "Firewall configured: port $VM_AGENT_PORT restricted to Cloudflare IPs; metadata API block deferred until Docker restart"`;

/**
 * Tunnel mode: drop all public ingress to the agent, the tunnel listener and
 * SSH. Run by cloud-init before the agent starts, by every vm-agent start
 * (ExecStartPre), by provisioning, and daily.
 */
export const TUNNEL_FIREWALL_WRITE_FILE = `  - path: /etc/sam/firewall/setup-firewall.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # SAM tunnel-node firewall: no public ingress to the VM agent, its loopback
      # tunnel listener, or SSH, on IPv4 and IPv6. Docker bridges may reach the
      # agent port (Git credential helper). Egress and INPUT policy are untouched.
      # The rules live in one chain replaced by a single iptables-restore
      # transaction, so a re-run (cron, provisioning, every vm-agent start)
      # never opens a gap.
      set -euo pipefail
      VM_AGENT_PORT="{{ vm_agent_port }}"
      TUNNEL_PORT="{{ tunnel_port }}"
      CHAIN=SAM-TUNNEL-INGRESS
      rules() {
        echo '*filter'
        echo ":$CHAIN - [0:0]"
        "$1" -C INPUT -j "$CHAIN" 2>/dev/null || echo "-I INPUT 1 -j $CHAIN"
        echo "-A $CHAIN -i lo -j RETURN"
        echo "-A $CHAIN -i docker0 -p tcp --dport $VM_AGENT_PORT -j RETURN"
        echo "-A $CHAIN -i br-+ -p tcp --dport $VM_AGENT_PORT -j RETURN"
        for port in "$VM_AGENT_PORT" "$TUNNEL_PORT"; do
          echo "-A $CHAIN -p tcp --dport $port -j DROP"
          echo "-A $CHAIN -p udp --dport $port -j DROP"
        done
        echo "-A $CHAIN -p tcp --dport 22 -j DROP"
        echo COMMIT
      }
      rules iptables | iptables-restore --noflush
      # Usability of ip6tables, not modprobe, decides: the module may be built in.
      modprobe ip6_tables 2>/dev/null || true
      if ip6tables -L -n >/dev/null 2>&1; then
        rules ip6tables | ip6tables-restore --noflush
      elif [ -n "$(ip -6 addr show scope global 2>/dev/null)" ]; then
        # Go serves 0.0.0.0 dual-stack: global IPv6 without ip6tables is exposure.
        logger -t sam-firewall "ERROR: ip6tables unavailable on a tunnel node with global IPv6; refusing"
        exit 1
      fi
      mkdir -p /etc/iptables
      iptables-save > /etc/iptables/rules.v4
      ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
      logger -t sam-firewall "Firewall configured: tunnel node, no public agent/SSH ingress"`;
