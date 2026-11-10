/**
 * Reverse-tunnel ingress fragments (self-hosted control plane). The node's frpc dials the
 * control-plane box over wss on 443 and exposes ONLY the vm-agent's loopback tunnel
 * listener as one TCP proxy bound to a SAM-leased loopback port on the box. It reuses the
 * Cloudflare tunnel's firewall (no public ingress at all) and listener wait gate.
 *
 * The per-node credential lives in a root-only systemd EnvironmentFile; frpc.toml refers to
 * it through frp's own `{{ .Envs.* }}` template (not a cloud-init placeholder), so the
 * world-readable config never contains it.
 */
import { TUNNEL_LISTENER_WAIT_WRITE_FILE } from './template-ingress';

/** Install the pinned frpc and close public ingress BEFORE the vm-agent listens. */
export const REVERSE_TUNNEL_BOOTSTRAP_RUNCMD = `  - 'logger -t sam-boot "PHASE START: tunnel-bootstrap"'
  - |
    case $(uname -m) in
      x86_64) FRP_ARCH=amd64 FRP_SHA256={{ frpc_sha256_amd64 }} ;;
      aarch64) FRP_ARCH=arm64 FRP_SHA256={{ frpc_sha256_arm64 }} ;;
      *) FRP_ARCH="" ;;
    esac
    FRP_TMP=$(mktemp)
    FRP_DIR=$(mktemp -d)
    FRP_NAME="frp_{{ frpc_version }}_linux_$FRP_ARCH"
    if [ -z "$FRP_ARCH" ] || ! curl --max-time {{ agent_download_timeout_seconds }} -fsSLo "$FRP_TMP" "{{ frpc_url }}/$FRP_NAME.tar.gz" ||
      [ "$(sha256sum "$FRP_TMP" | cut -d' ' -f1)" != "$FRP_SHA256" ] ||
      ! tar -xzf "$FRP_TMP" -C "$FRP_DIR" "$FRP_NAME/frpc"; then
      rm -rf "$FRP_TMP" "$FRP_DIR"
      /usr/local/sbin/sam-boot-failure frpc_install
      exit 1
    fi
    install -m 0755 "$FRP_DIR/$FRP_NAME/frpc" /usr/local/bin/frpc
    rm -rf "$FRP_TMP" "$FRP_DIR"
    id sam-frpc >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin sam-frpc
    if ! /etc/sam/firewall/setup-firewall.sh; then
      /usr/local/sbin/sam-boot-failure tunnel_firewall
      exit 1
    fi
    logger -t sam-boot "frpc installed (sha256 verified); public agent/SSH ingress closed"
  - 'logger -t sam-boot "PHASE END: tunnel-bootstrap"'`;

/** Start the connector once the agent runs; ExecStartPre waits for its loopback listener. */
export const REVERSE_TUNNEL_CONNECTOR_RUNCMD = `  - 'logger -t sam-boot "PHASE START: tunnel-connector"'
  - |
    if ! systemctl enable --now sam-frpc.service; then
      /usr/local/sbin/sam-boot-failure tunnel_connector
      exit 1
    fi
  - 'logger -t sam-boot "PHASE END: tunnel-connector"'`;

/**
 * frpc config, credential file and unit. loginFailExit=false + Restart=always: frpc keeps
 * retrying (an frps restart, a Caddy restart, an authz rejection while the lease is being
 * fixed) instead of exiting. useSystemCa: frpc verifies the box's public certificate; without
 * it frpc would accept any certificate.
 */
export const REVERSE_TUNNEL_WRITE_FILES = `${TUNNEL_LISTENER_WAIT_WRITE_FILE}

  - path: /etc/sam/frpc/credential.env
    permissions: '0400'
    owner: root:root
    content: |
      SAM_REVERSE_TUNNEL_CREDENTIAL={{ reverse_tunnel_credential }}

  - path: /etc/sam/frpc/frpc.toml
    permissions: '0644'
    content: |
      serverAddr = "{{ reverse_tunnel_server_addr }}"
      serverPort = {{ reverse_tunnel_server_port }}
      loginFailExit = false
      user = "{{ node_id }}"
      metadatas.node_id = "{{ node_id }}"
      metadatas.incarnation = "{{ node_runtime_incarnation_id }}"
      metadatas.credential = "{{ .Envs.SAM_REVERSE_TUNNEL_CREDENTIAL }}"
      transport.protocol = "wss"
      transport.tls.enable = true
      transport.tls.serverName = "{{ reverse_tunnel_server_addr }}"
      transport.tls.useSystemCa = true
      transport.heartbeatInterval = {{ reverse_tunnel_heartbeat_interval_seconds }}
      transport.heartbeatTimeout = {{ reverse_tunnel_heartbeat_timeout_seconds }}
      log.to = "console"

      [[proxies]]
      name = "{{ reverse_tunnel_proxy_name }}"
      type = "tcp"
      localIP = "127.0.0.1"
      localPort = {{ tunnel_port }}
      remotePort = {{ reverse_tunnel_remote_port }}

  - path: /etc/systemd/system/sam-frpc.service
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM reverse tunnel connector (frpc)
      After=network-online.target vm-agent.service
      Wants=network-online.target
      StartLimitIntervalSec=0

      [Service]
      User=sam-frpc
      EnvironmentFile=/etc/sam/frpc/credential.env
      ExecStartPre=/usr/local/sbin/sam-wait-tunnel-listener
      ExecStart=/usr/local/bin/frpc -c /etc/sam/frpc/frpc.toml
      TimeoutStartSec=infinity
      Restart=always
      RestartSec={{ tunnel_connector_restart_seconds }}
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
