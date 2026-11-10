/**
 * Resource-headroom write_files of the cloud-init template: the SAM systemd
 * slice hierarchy, the Docker workload MemoryMax configurator, and the
 * workload cgroup verification script. Interpolated into CLOUD_INIT_TEMPLATE.
 */
export const RESOURCE_HEADROOM_WRITE_FILES = `  - path: /etc/systemd/system/sam.slice
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM managed services and workload hierarchy
      Before=slices.target

      [Slice]
      MemoryAccounting=yes
      MemoryMin={{ sam_infra_slice_memory_min_mb }}M

  - path: /etc/systemd/system/sam-infra.slice
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM infrastructure services
      Before=slices.target

      [Slice]
      MemoryAccounting=yes
      MemoryMin={{ sam_infra_slice_memory_min_mb }}M
      CPUAccounting=yes
      CPUWeight={{ sam_infra_slice_cpu_weight }}

  - path: /etc/systemd/system/sam-workload.slice
    permissions: '0644'
    content: |
      [Unit]
      Description=SAM Docker workload containers
      Before=slices.target

      [Slice]
      MemoryAccounting=yes
      CPUAccounting=yes
      CPUWeight={{ sam_workload_slice_cpu_weight }}

  - path: /usr/local/sbin/sam-configure-docker-memory.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu

      RESERVE_MB="{{ vm_agent_memory_reserve_mb }}"
      SYSTEMD_SYSTEM_DIR="\${SAM_SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
      if [ "$RESERVE_MB" = "0" ]; then
        rm -f "$SYSTEMD_SYSTEM_DIR/sam-workload.slice.d/50-headroom.conf"
        systemctl daemon-reload
        logger -t sam-headroom "SAM workload MemoryMax reserve disabled"
        exit 0
      fi

      MIN_DOCKER_MB="{{ docker_memory_min_mb }}"
      PROC_MEMINFO="\${SAM_PROC_MEMINFO:-/proc/meminfo}"
      TOTAL_KB="$(awk '/MemTotal:/ { print $2; exit }' "$PROC_MEMINFO")"
      case "$TOTAL_KB" in
        ''|*[!0-9]*)
          echo "cannot determine host memory from $PROC_MEMINFO" >&2
          logger -t sam-headroom "Cannot determine host memory from $PROC_MEMINFO"
          exit 78
          ;;
      esac
      TOTAL_MB="$((TOTAL_KB / 1024))"
      DOCKER_MEMORY_MAX_MB="$((TOTAL_MB - RESERVE_MB))"

      if [ "$DOCKER_MEMORY_MAX_MB" -lt "$MIN_DOCKER_MB" ]; then
        echo "refusing to run without SAM workload MemoryMax: total=\${TOTAL_MB}M reserve=\${RESERVE_MB}M leaves \${DOCKER_MEMORY_MAX_MB}M below minimum \${MIN_DOCKER_MB}M" >&2
        logger -t sam-headroom "Refusing to run without SAM workload MemoryMax: total=\${TOTAL_MB}M reserve=\${RESERVE_MB}M leaves \${DOCKER_MEMORY_MAX_MB}M below minimum \${MIN_DOCKER_MB}M"
        exit 78
      fi

      mkdir -p "$SYSTEMD_SYSTEM_DIR/sam-workload.slice.d"
      cat >"$SYSTEMD_SYSTEM_DIR/sam-workload.slice.d/50-headroom.conf" <<EOF
      [Slice]
      MemoryAccounting=yes
      MemoryMax=\${DOCKER_MEMORY_MAX_MB}M
      EOF
      systemctl daemon-reload
      if systemctl is-active --quiet docker; then
        systemctl restart docker
      fi
      logger -t sam-headroom "Configured sam-workload.slice MemoryMax=\${DOCKER_MEMORY_MAX_MB}M with reserve=\${RESERVE_MB}M"

  - path: /usr/local/sbin/sam-verify-workload-cgroup.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu

      CONTAINER_ID="\${1:-}"
      if [ -z "$CONTAINER_ID" ]; then
        echo "usage: $0 <container-id-or-name>" >&2
        exit 64
      fi

      RESERVE_MB="{{ vm_agent_memory_reserve_mb }}"
      INFRA_MIN_MB="{{ sam_infra_slice_memory_min_mb }}"
      MIN_DOCKER_MB="{{ docker_memory_min_mb }}"
      INFRA_CPU_WEIGHT_EXPECTED="{{ sam_infra_slice_cpu_weight }}"
      WORKLOAD_CPU_WEIGHT_EXPECTED="{{ sam_workload_slice_cpu_weight }}"
      PROC_ROOT="\${SAM_PROC_ROOT:-/proc}"
      CGROUP_ROOT="\${SAM_CGROUP_ROOT:-/sys/fs/cgroup}"
      PROC_MEMINFO="\${SAM_PROC_MEMINFO:-/proc/meminfo}"

      PID="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER_ID")"
      if [ -z "$PID" ] || [ "$PID" = "0" ]; then
        echo "container $CONTAINER_ID is not running" >&2
        exit 65
      fi

      CGROUP_FILE="$PROC_ROOT/$PID/cgroup"
      if [ ! -r "$CGROUP_FILE" ]; then
        echo "cannot read cgroup for container $CONTAINER_ID pid $PID at $CGROUP_FILE" >&2
        exit 66
      fi

      CGROUP="$(cat "$CGROUP_FILE")"
      CGROUP_PATH="$(awk -F: '$1 == "0" && $2 == "" { print $3; found = 1 } END { if (!found) exit 1 }' "$CGROUP_FILE")" || {
        echo "container $CONTAINER_ID pid $PID has no cgroup v2 entry" >&2
        echo "$CGROUP" >&2
        exit 66
      }

      find_cgroup_ancestor() {
        target="$1"
        path="$2"
        while [ "$path" != "/" ] && [ "$path" != "." ] && [ -n "$path" ]; do
          if [ "$(basename "$path")" = "$target" ]; then
            printf '%s\\n' "$path"
            return 0
          fi
          path="$(dirname "$path")"
        done
        return 1
      }

      SAM_CGROUP="$(find_cgroup_ancestor sam.slice "$CGROUP_PATH")" || {
        echo "container $CONTAINER_ID pid $PID is outside sam.slice" >&2
        echo "$CGROUP" >&2
        exit 66
      }
      WORKLOAD_CGROUP="$(find_cgroup_ancestor sam-workload.slice "$CGROUP_PATH")" || {
        echo "container $CONTAINER_ID pid $PID is outside sam-workload.slice" >&2
        echo "$CGROUP" >&2
        exit 66
      }
      if [ "$SAM_CGROUP" != "/sam.slice" ] || [ "$WORKLOAD_CGROUP" != "/sam.slice/sam-workload.slice" ]; then
        echo "container $CONTAINER_ID pid $PID has unexpected SAM cgroup ancestry: $CGROUP_PATH" >&2
        exit 66
      fi

      read_cgroup_value() {
        name="$1"
        rel_path="$2"
        file="$CGROUP_ROOT$rel_path/$name"
        if [ ! -r "$file" ]; then
          echo "missing cgroup $name at $file" >&2
          exit 67
        fi
        tr -d '\\n' < "$file"
      }

      require_bytes_equal() {
        name="$1"
        actual="$2"
        expected="$3"
        case "$actual" in
          ''|*[!0-9]*)
            echo "$name expected $expected bytes, got $actual" >&2
            exit 67
            ;;
        esac
        if [ "$actual" -ne "$expected" ]; then
          echo "$name expected $expected bytes, got $actual" >&2
          exit 67
        fi
      }

      require_bytes_at_least() {
        name="$1"
        actual="$2"
        minimum="$3"
        case "$actual" in
          ''|*[!0-9]*)
            echo "$name expected at least $minimum bytes, got $actual" >&2
            exit 67
            ;;
        esac
        if [ "$actual" -lt "$minimum" ]; then
          echo "$name expected at least $minimum bytes, got $actual" >&2
          exit 67
        fi
      }

      require_int_equal() {
        name="$1"
        actual="$2"
        expected="$3"
        case "$actual" in
          ''|*[!0-9]*)
            echo "$name is not an integer: $actual" >&2
            exit 67
            ;;
        esac
        if [ "$actual" != "$expected" ]; then
          echo "$name expected $expected, got $actual" >&2
          exit 67
        fi
      }

      prop_value() {
        props="$1"
        key="$2"
        printf '%s\\n' "$props" | awk -F= -v key="$key" '$1 == key { print $2; found = 1; exit } END { if (!found) exit 1 }'
      }

      # CPU weights are verified BEFORE the memory-reserve early return on
      # purpose: disabling the memory reserve must not silently disable the CPU
      # check too. Memory starvation kills the agent and CPU starvation only
      # delays its heartbeat, but a delayed heartbeat is what gets a healthy node
      # declared dead, so both are load-bearing.
      INFRA_CPU_WEIGHT="$(read_cgroup_value cpu.weight /sam.slice/sam-infra.slice)"
      WORKLOAD_CPU_WEIGHT="$(read_cgroup_value cpu.weight "$WORKLOAD_CGROUP")"
      require_int_equal "sam-infra.slice cgroup cpu.weight" "$INFRA_CPU_WEIGHT" "$INFRA_CPU_WEIGHT_EXPECTED"
      require_int_equal "sam-workload.slice cgroup cpu.weight" "$WORKLOAD_CPU_WEIGHT" "$WORKLOAD_CPU_WEIGHT_EXPECTED"
      if [ "$INFRA_CPU_WEIGHT" -le "$WORKLOAD_CPU_WEIGHT" ]; then
        echo "vm-agent slice cpu.weight $INFRA_CPU_WEIGHT does not outrank workload $WORKLOAD_CPU_WEIGHT" >&2
        exit 67
      fi

      if [ "$RESERVE_MB" = "0" ]; then
        echo "SAM workload MemoryMax reserve disabled; verified cgroup ancestry and CPU weights only"
        systemctl show sam.slice sam-infra.slice sam-workload.slice \
          -p MemoryMin -p MemoryMax -p EffectiveMemoryMax -p CPUWeight --no-pager
        echo "$CGROUP"
        exit 0
      fi

      TOTAL_KB="$(awk '/MemTotal:/ { print $2; exit }' "$PROC_MEMINFO")"
      case "$TOTAL_KB" in
        ''|*[!0-9]*)
          echo "cannot determine host memory from $PROC_MEMINFO" >&2
          exit 67
          ;;
      esac
      TOTAL_MB="$((TOTAL_KB / 1024))"
      DOCKER_MEMORY_MAX_MB="$((TOTAL_MB - RESERVE_MB))"
      if [ "$DOCKER_MEMORY_MAX_MB" -lt "$MIN_DOCKER_MB" ]; then
        echo "SAM workload MemoryMax is not enforceable: total=\${TOTAL_MB}M reserve=\${RESERVE_MB}M leaves \${DOCKER_MEMORY_MAX_MB}M below minimum \${MIN_DOCKER_MB}M" >&2
        exit 67
      fi

      EXPECTED_WORKLOAD_MAX_BYTES="$((DOCKER_MEMORY_MAX_MB * 1024 * 1024))"
      EXPECTED_INFRA_MIN_BYTES="$((INFRA_MIN_MB * 1024 * 1024))"
      WORKLOAD_MEMORY_MAX="$(read_cgroup_value memory.max "$WORKLOAD_CGROUP")"
      SAM_MEMORY_MIN="$(read_cgroup_value memory.min "$SAM_CGROUP")"
      INFRA_MEMORY_MIN="$(read_cgroup_value memory.min /sam.slice/sam-infra.slice)"

      require_bytes_equal "sam-workload.slice cgroup memory.max" "$WORKLOAD_MEMORY_MAX" "$EXPECTED_WORKLOAD_MAX_BYTES"
      require_bytes_at_least "sam.slice cgroup memory.min" "$SAM_MEMORY_MIN" "$EXPECTED_INFRA_MIN_BYTES"
      require_bytes_at_least "sam-infra.slice cgroup memory.min" "$INFRA_MEMORY_MIN" "$EXPECTED_INFRA_MIN_BYTES"

      WORKLOAD_PROPS="$(systemctl show sam-workload.slice -p MemoryMax -p EffectiveMemoryMax --no-pager)"
      SAM_PROPS="$(systemctl show sam.slice -p MemoryMin --no-pager)"
      INFRA_PROPS="$(systemctl show sam-infra.slice -p MemoryMin --no-pager)"

      require_bytes_equal "sam-workload.slice MemoryMax" "$(prop_value "$WORKLOAD_PROPS" MemoryMax)" "$EXPECTED_WORKLOAD_MAX_BYTES"
      require_bytes_equal "sam-workload.slice EffectiveMemoryMax" "$(prop_value "$WORKLOAD_PROPS" EffectiveMemoryMax)" "$EXPECTED_WORKLOAD_MAX_BYTES"
      require_bytes_at_least "sam.slice MemoryMin" "$(prop_value "$SAM_PROPS" MemoryMin)" "$EXPECTED_INFRA_MIN_BYTES"
      require_bytes_at_least "sam-infra.slice MemoryMin" "$(prop_value "$INFRA_PROPS" MemoryMin)" "$EXPECTED_INFRA_MIN_BYTES"

      printf '%s\\n' "$SAM_PROPS" "$INFRA_PROPS" "$WORKLOAD_PROPS"
      echo "$CGROUP"`;
