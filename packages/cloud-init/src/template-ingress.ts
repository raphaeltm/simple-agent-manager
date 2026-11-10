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
      CapabilityBoundingSet=

      [Install]
      WantedBy=multi-user.target`;
