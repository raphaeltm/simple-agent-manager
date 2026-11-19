import { RESOURCE_HEADROOM_WRITE_FILES } from './template-resources';

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
  - mkdir -p /var/lib/vm-agent /etc/sam/tls /etc/sam/firewall /etc/sam/cloudflared
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    logger -t sam-boot "Downloading vm-agent for arch=$ARCH"
    curl_output=$(mktemp)
    if curl --max-time {{ agent_download_timeout_seconds }} -fLo /usr/local/bin/vm-agent "{{ control_plane_url }}/api/agent/download?arch=\${ARCH}{{ vm_agent_release_query }}" >"$curl_output" 2>&1; then
      cat "$curl_output" | logger -t sam-boot
      rm -f "$curl_output"
    else
      curl_status=$?
      cat "$curl_output" | logger -t sam-boot
      rm -f "$curl_output"
      logger -t sam-boot "vm-agent download failed status=$curl_status"
      /usr/local/sbin/sam-boot-failure vm_agent_download
      exit "$curl_status"
    fi
    chmod +x /usr/local/bin/vm-agent
    logger -t sam-boot "vm-agent binary downloaded, size=$(stat -c%s /usr/local/bin/vm-agent 2>/dev/null || echo unknown)"
  - 'logger -t sam-boot "PHASE END: vm-agent-download"'

{{ ingress_bootstrap_runcmd }}

  - 'logger -t sam-boot "PHASE START: resource-headroom"'
  - /usr/local/sbin/sam-configure-docker-memory.sh || exit $?
  - 'logger -t sam-boot "PHASE END: resource-headroom"'

  - 'logger -t sam-boot "PHASE START: vm-agent-start"'
  - systemctl daemon-reload
  - systemctl enable vm-agent
  - systemctl start vm-agent
  - 'logger -t sam-boot "PHASE END: vm-agent-start"'

{{ ingress_connector_runcmd }}

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
      Environment=NODE_USER_ID={{ node_user_id }}
      Environment=NODE_RUNTIME_INCARNATION_ID={{ node_runtime_incarnation_id }}
      Environment=CONTROL_PLANE_URL={{ control_plane_url }}
      Environment=JWKS_ENDPOINT={{ jwks_url }}
      Environment=CALLBACK_TOKEN_FILE=/etc/sam/callback-token
      Environment=PROJECT_ID={{ project_id }}
      Environment=CHAT_SESSION_ID={{ chat_session_id }}
      Environment=TASK_ID={{ task_id }}
      Environment=TASK_MODE={{ task_mode }}
      Environment=VM_AGENT_PORT={{ vm_agent_port }}
      Environment=VM_AGENT_TUNNEL_ENABLED={{ tunnel_mode }}
      Environment=VM_AGENT_TUNNEL_PORT={{ tunnel_port }}
      Environment=TLS_CERT_PATH={{ tls_cert_path }}
      Environment=TLS_KEY_PATH={{ tls_key_path }}
      Environment=PROVIDER={{ provider }}
      Environment=DEVCONTAINER_CACHE_ENABLED={{ devcontainer_cache_enabled }}
      Environment=WORKSPACE_BUILD_QUEUE_DEPTH={{ workspace_build_queue_depth }}
      Environment=ROLE={{ role }}
      Environment=NODE_ROLE={{ role }}
      Environment=ENVIRONMENT_ID={{ environment_id }}
      Environment=DEPLOY_SIGNING_PUB_KEY={{ deploy_signing_pub_key }}
      Environment=DEPLOY_ACME_EMAIL={{ deploy_acme_email }}
      Environment=DEPLOY_ACME_CA={{ deploy_acme_ca }}
      Environment="DEPLOY_COMPOSE_CMD={{ deploy_compose_cmd }}"
      Environment=DEPLOY_HEALTH_TIMEOUT={{ deploy_health_timeout }}
      Environment=SESSION_SNAPSHOT_OPERATION_TIMEOUT={{ session_snapshot_operation_timeout }}
      Environment=SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL={{ session_snapshot_progress_report_interval }}
      Environment=SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT={{ session_snapshot_progress_report_timeout }}
      Environment=ERROR_REPORT_FLUSH_INTERVAL={{ error_report_flush_interval }}
      Environment=ERROR_REPORT_MAX_BATCH_SIZE={{ error_report_max_batch_size }}
      Environment=ERROR_REPORT_MAX_BATCH_BYTES={{ error_report_max_batch_bytes }}
      Environment=ERROR_REPORT_MAX_QUEUE_SIZE={{ error_report_max_queue_size }}
      Environment=ERROR_REPORT_HTTP_TIMEOUT={{ error_report_http_timeout }}
      Environment=ERROR_REPORT_RETRY_INITIAL={{ error_report_retry_initial }}
      Environment=ERROR_REPORT_RETRY_MAX={{ error_report_retry_max }}
      Environment=ERROR_REPORT_MAX_ATTEMPTS={{ error_report_max_attempts }}
      Environment=ERROR_REPORT_DB_PATH={{ error_report_db_path }}
      Environment=ERROR_REPORT_DB_BUSY_TIMEOUT={{ error_report_db_busy_timeout }}
      Environment=ERROR_REPORT_SPOOL_DIR={{ error_report_spool_dir }}
      Environment=ERROR_REPORT_ARTIFACT_MAX_BYTES={{ error_report_artifact_max_bytes }}
      Environment=ERROR_REPORT_SPOOL_MAX_BYTES={{ error_report_spool_max_bytes }}
      Environment=ERROR_REPORT_RETENTION={{ error_report_retention }}
      Environment=ERROR_REPORT_COLLECTOR_TIMEOUT={{ error_report_collector_timeout }}
      Environment=ERROR_REPORT_MAX_COLLECTOR_DOCS={{ error_report_max_collector_docs }}
      Environment=ERROR_REPORT_MAX_DOCUMENT_BYTES={{ error_report_max_document_bytes }}
      Environment=ERROR_REPORT_MAX_VALUE_DEPTH={{ error_report_max_value_depth }}
      Environment=ERROR_REPORT_MAX_VALUE_ITEMS={{ error_report_max_value_items }}
      Environment=ERROR_REPORT_MAX_STRING_BYTES={{ error_report_max_string_bytes }}
      Environment=ERROR_REPORT_EVENT_LIMIT={{ error_report_event_limit }}
      Environment=ERROR_REPORT_RESPONSE_MAX_BYTES={{ error_report_response_max_bytes }}
      Environment=ERROR_REPORT_STORED_ERROR_MAX_BYTES={{ error_report_stored_error_max_bytes }}
      Environment=ERROR_REPORT_COLLECTOR_CONCURRENCY={{ error_report_collector_concurrency }}
      Environment=HEARTBEAT_DOCKER_STATS_TIMEOUT={{ heartbeat_docker_stats_timeout }}
      Environment=HEARTBEAT_WORKSPACE_METRICS_MAX_CONTAINERS={{ heartbeat_workspace_metrics_max_containers }}
      Environment=HEARTBEAT_WORKSPACE_METRICS_MAX_OUTPUT_BYTES={{ heartbeat_workspace_metrics_max_output_bytes }}
      Slice=sam-infra.slice
      MemoryAccounting=yes
      OOMScoreAdjust=-900
      {{ vm_agent_exec_start_pre }}
      ExecStart=/usr/local/bin/vm-agent
      Restart=always
      RestartSec=5

      [Install]
      WantedBy=multi-user.target

${RESOURCE_HEADROOM_WRITE_FILES}

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

  - path: /usr/local/sbin/sam-boot-failure
    permissions: '0700'
    content: |
      #!/bin/sh
      # Best-effort boot failure report while the vm-agent is not running yet.
      # Reads the token file so the callback token is not repeated in user-data.
      logger -t sam-boot "ERROR: boot failed reason=$1"
      curl -sS --max-time {{ cert_request_timeout_seconds }} -o /dev/null -X POST \\
        -H "Authorization: Bearer $(cat /etc/sam/callback-token)" \\
        -H "Content-Type: application/json" --data "{\\"reason\\":\\"$1\\"}" \\
        "{{ control_plane_url }}/api/nodes/{{ node_id }}/boot-failure" 2>/dev/null || true

{{ ingress_write_files }}

  - path: /etc/workspace/config.json
    content: |
      {
        "node_id": "{{ node_id }}",
        "control_plane_url": "{{ control_plane_url }}"
      }
    permissions: '0644'

{{ ingress_firewall_write_file }}

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
        "cgroup-parent": "sam-workload.slice",
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
