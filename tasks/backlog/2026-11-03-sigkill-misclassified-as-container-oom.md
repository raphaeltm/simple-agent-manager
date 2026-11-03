# SIGKILL Exit 137 Is Misclassified as a Container OOM

## Problem

`parseDockerOOMEvent` (`packages/vm-agent/internal/resourcemon/docker_events.go`) treats
any `die` event with exit code `137` as an out-of-memory kill:

```go
isOOM := action == "oom" || (action == "die" && exitCode == DockerOOMExitCode)
```

Exit code 137 means only "killed by SIGKILL". `docker rm -f`, `docker kill` and a
`docker stop` that times out all produce it. During workspace deletion the VM agent runs
`docker rm -f`, so every normal stop emits a critical `container_oom` pressure event to
the eviction controller.

## Context

Found 2026-11-03 while investigating slow workspace stops (debug package for node
`01M6H35EAR5TD0VA361PXXFWT5`). About 10 seconds after each workspace stop the agent logged:

```
WARN resourcemon: critical pressure event had no evictable workspace type=container_oom containerName=dazzling_roentgen
```

That case was harmless only because the removed devcontainer had no
`sam.workspace.id` label. A labelled container killed by SIGKILL would be reported as a
critical OOM for that workspace, which can drive eviction. (Resource history OOM counts come
from cgroup `memory.events`, not Docker events, so they are unaffected.)

## Acceptance Criteria

- [ ] A `die` event with exit 137 counts as OOM only when Docker reports `oom` for that
      container, or the container's inspected `State.OOMKilled` is true
- [ ] `docker rm -f` during workspace deletion produces no `container_oom` pressure event
      (test through the real event parser and eviction path)
- [ ] A real `oom` event still reaches the eviction controller (convergence control)
