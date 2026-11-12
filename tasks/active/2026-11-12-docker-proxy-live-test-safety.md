# Docker proxy live test: safe on a real install, green in CI

## Problem

`scripts/selfhost/live/docker-proxy.live.test.ts` (PR #2676):

1. Its cleanup ran `docker network rm celld celld-internal`, the real network names of the
   self-hosted stack. Run on the live test box it deleted the stack's networks and guided login
   failed with "network celld not found" until celld was restarted.
2. In CI (job "Validate Deploy Scripts", run 43154456748) it failed with "timed out waiting for
   the proxy socket" while passing on the box.

## Findings

- CI root cause: the proxy logged `listening` inside its container, so the image, uid and group
  were fine; the host side could not connect. The socket path on the runner was
  `/home/runner/work/simple-agent-manager/simple-agent-manager/.tmp/selfhost-live/docker-proxy-<8hex>/sock/docker.sock`,
  117 bytes, over the 107-byte Unix socket path limit. The `.catch(() => null)` swallowed the
  connect error. On the box the checkout path is shorter, so it fit.
- The proxy's network table is fixed (`CELLD_NETWORKS` in `deploy/selfhost/docker-proxy/shapes.ts`):
  `celld`/`celld0` and `celld-internal`/`celld1`. Run-scoping those names would change what the
  proxy allows, which this task forbids, so the suite refuses to start when they exist and removes
  only networks it created, by id.
- Other files under `scripts/selfhost/live/` already use random per-run container names and
  run-scoped temp dirs / netns names; no fixed production names are removed.

## Checklist

- [x] Socket and policy dir moved to `<tmpdir>/sam-dp-<run>` (short), with a byte-length check
- [x] Ping wait reports the last connect error and the proxy log on timeout
- [x] `refuseIfNotThrowaway()`: refuses when celld's networks/bridges, the run's container names,
      image tags or directory already exist
- [x] Cleanup removes only container ids and network ids this run created, and the run's image tags;
      does nothing if the guard refused
- [x] Proxy image tag run-scoped and removed
- [ ] CI Validate Deploy Scripts green on the branch
