# Cloudflare build executor — phase 0, attempt 2 (2026-11-07)

**GO for DinD/Compose feasibility. NO-GO for an unconditional phase-3 release gate: presigned R2 PUT/GET is still unverified because the available staging credential cannot create R2 resources and the staging S3 secret names were unavailable.** This is a completed bounded experiment with an explicit remaining transport blocker, not a claim that transport failed.

SPIKE ONLY. Branch `spike/cf-build-executor`; no /do, PR or merge. Task `01M6SNCMEF97FGEKR636GMXJRV`; idea `01KZ6V37D1QGDR3WN12PSDB0QD`. The idea's 2026-11-06 implementation plan and attempt-1 report were read first. Managed CF_TOKEN/CF_ACCOUNT_ID via exec_with_secrets; account GET returned **SAM Staging**. No production access. Scratch Worker `sam-build-spike2-a`, application `a031aea6-dbed-4031-b847-b6e9892f5ecc`, standard-4, max_instances=3, default direct internet egress, no outbound handler. Two fresh named instances for cold suites; no Worker redeploy during measurements. A third fresh instance was used only for cancellation.

## Variant and startup

**Variant A worked. B/C were not run**, as instructed. Guide startup recipe: docker:dind, sandbox control binary as PID1, pre-mount /tmp, cgroupfs flag and 60-second docker-version wait. Log redirected to /var/log/dockerd.log. Only instrumentation/fixtures (curl/python/time) were added. SDK and sandbox image both exactly **0.12.14**.

| Observation | Cold suite 1 | Cold suite 2 |
|---|---:|---:|
| dockerd Starting up → completed initialization, daemon timestamps | 0.151 s | 0.221 s |
| First SDK request incl startup | 2.081 s (includes info/log command) | 8.555 s (includes two a builds/saves; exec itself 7.153 s) |
| Storage | overlayfs, io.containerd.snapshotter.v1 | same |
| Cgroup | cgroupfs / v2 | same |

Suite2's ~1.4 s difference between client and exec duration is startup/transport overhead, **not an independently timed docker-version poll**. Readiness was <60 s in both; fixtures share each suite's daemon, so there is no new daemon readiness measurement per fixture.

Docker **29.9.3**, Compose **5.7.0**, Buildx **0.38.2**, Alpine3.24, kernel **6.18.56-cloudflare-microvm-2026.10.9**, 4 CPUs /11.93 GiB. Current docker:dind resolved to `sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121`; sandbox image digest `sha256:6403c4f8ec2123a3dd223a4d3023f3d3d11581d214abc46ef9920e96e1660c10`. Deployed image manifest `sha256:fca672b53e538dcfd61d536fed485ab5dd31ec55e007e1e9f8121caaa44ad5e7`. Do not relabel overlayfs as overlay2 or vfs.

This proves the combined documented recipe works. It does **not** isolate which attempt-1 deviation caused its failure: multiple startup changes and Docker28→29 changed together. Dockerd warnings (no swap limits, IPv4 forwarding disabled, experimental embedded containerd and tini not PID1) did not prevent these builds. Full docker info appears below and in docker-info.txt.

## Fixture measurements

Seconds. Cold1 and Cold2 ran in separate fresh instances with empty image/build caches initially. Each suite ran a→b→c, so later fixtures retain earlier unrelated images; this is not a fresh boot per fixture. Warm is a cached repeat in the same instance. Base pulls timed explicitly before build. Saves are uncompressed Docker archives. C payload is 1500 MiB random data.

| Fixture | Cold1 build | Cold2 build | Warm build | Archive bytes | Save cold1 / cold2 / warm |
|---|---:|---:|---:|---:|---:|
| a: small Node22 Alpine | 1.98 | 1.90 | 0.22 | 61,367,296 | 0.50 / 0.53 / 0.53 |
| b: Node native better-sqlite3 + Python3.12, ignore/override | 86.10 | 89.23 | 0.31 | 246,160,384 | 2.43 / 2.40 / 2.45 |
| c: Alpine +1500 MiB random | 55.29 | 53.17 | 0.25 | 1,577,154,048 | 15.03 / 15.72 / 14.17 |

| Base image | Cold1 pull | Cold2 pull | Warm manifest check |
|---|---:|---:|---:|
| node:22-alpine | 3.21 | 2.44 | 0.69 |
| node:22-bookworm-slim | 3.65 | 3.24 | 0.72 |
| python:3.12-slim | 3.01 | 2.52 | 0.70 |
| alpine:3.22 | 1.47 | 1.48 | 0.72 |

**No Docker Hub rate-limit response observed** in these bounded anonymous CF-egress pulls; this does not establish sustained capacity. Deployment-image pulls on the source machine are excluded. B cold1 bases were pulled during its negative network test; its successful host retry rechecked those cached bases in0.70/0.71s. Thus b cold1 is cold for the successful native RUN steps but some metadata/Python layers had been cached by the failed test; cold2 is the clean comparison.

**Host networking is required for networked build steps.** B default compose build failed in9.81s: `Temporary failure resolving 'deb.debian.org'`, then apt could not locate packages. Adding only per-service `build.network: host` made it pass. Daemon flags alone were insufficient. Original compose.override.yaml's SPIKE_OVERRIDE=present assertion passed; Docker loaded the .dockerignore. The fixture does not COPY ignored.txt, so this is not full ignore-semantics parity proof. No host networking was needed for a/c's non-networked RUN steps. Preserve original compose and override; add host networking to every build definition in the production executor. Reusable compose.host.yaml does this for b.

| Resource observation, GiB | a | b | c |
|---|---:|---:|---:|
| Peak whole-filesystem used, incl retained suite artifacts | 0.95 | 3.10 | 10.17 |
| Max sampled MemTotal−MemAvailable (working pressure estimate) | 0.42 | 0.94 | 0.61 |
| Max sampled MemTotal−MemFree (incl reclaimable cache) | 1.01 | 3.41 | 10.75 |

1-second /proc/meminfo and df sampling, not exact instantaneous process peaks. A cold1's cgroup memory.current lookup was at the root where it is absent; its RAM peak is unmeasured, table a comes from cold2/warm. Suite1 cloudchamber/memory.peak was **9,237,094,400 bytes** (8.60GiB), suite2 **7,931,158,528 bytes** (7.39GiB); these include cache and outer processes and are not a sum of all inner Docker cgroups. Peak whole-VM nonfree memory was10.75GiB. Reclaimable cache dominated c (MemAvailable remained~11GiB). Retained archives inflate disk: suite1 kept a+b and **two** c tars; suite2 kept two a, two b and one c. Do not size from image payload alone or from Docker CLI RSS. measurements.json retains exact byte samples/maxima and timing fields.

## Direct egress / R2

Package downloads (apt/npm), Docker Hub pulls and direct internet networking worked with host build networking. **Presigned >100MiB R2 PUT and context-tar GET: NOT RUN.** The staging token's POST /r2/buckets and GET /tokens/permission_groups returned403 `Authentication error` (code10000). Selecting managed R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY was rejected by exec_with_secrets: `Secret execution unavailable: verify the active session, selected names and VM compatibility`. Only presence was requested; no values printed. An asynchronous request asked for alternative managed staging names; none was available before bounded cleanup.

No scratch bucket, object or token was created. GET /r2/buckets/sam-build-spike2-20261107 subsequently returned404 `The specified bucket does not exist.` (10006). No unverified upload/download throughput or bypass claim is made. Cloudflare documents that the100MiB cap applies to outbound-handler traffic; this attempt did not empirically prove large direct R2 egress. Transport remains the release gate.

## SIGTERM mid-build

Third fresh instance cancel-003: Compose built Alpine, printed `SIGTERM_TEST_RUNNING`, and was observed in RUN sleep120 (live compose/buildx/runc/sleep processes). Authenticated SDK exec sent `kill -TERM 1` at **00:26:16Z**. The request lost its response with Sandbox HTTP500, expected when its server exits. CF instances API recorded outer **exit_code0 at00:26:21.299Z**, about5.3s after signal, and inactive observed by **11.999s** after the request (API state timestamp00:26:26Z). It stopped before the120s RUN could finish. No SIGKILL was sent for this test.

This demonstrates bounded outer termination, not a completed application cancellation callback or a captured Compose child exit status: the final build log disappeared with ephemeral storage. Phase3 must persist job cancellation before stopping and explicitly supervise/forward signals to dockerd/build children. Subsequent SDK destroy on this stopped identity caused an initialization/restart before destruction (the API saw it running again); avoid diagnostic SDK calls against stopped identities when measuring final stop time. Whole application deletion below removed it.

## Recommendation and risks

- **Smallest demonstrated adequate instance: standard-4.** Retain it for phase3 initially. No smaller type was actually run, so claiming a proven minimum would be false. standard-2 (6GiB/12GB) is a plausible later single-job candidate based on working memory/disk, but cache reclaim, CPU slowdown and peak export overlap need a bounded validation before downsizing. standard-1's8GB disk offers insufficient margin for this measured retained-artifact suite. Avoid vfs; it was unnecessary and untested.
- **Builder timeout: keep20min absolute, with a separate60s daemon readiness deadline.** Longest measured cold fixture including pulls/save was~98s;20min leaves room for real apps/registry variance. This is an operational recommendation, not a measured worst-case guarantee. Terminate promptly on terminal job state; use sleepAfter only as backstop. SDK sleepAfter was2min here; active exec calls kept builds alive.
- Pin the working Docker digest/version, SDK and image as a matched pair; do not copy a moving docker:dind tag into production without review. Current SDK1.x is a different API;0.12.14 was chosen to reproduce the user's referenced SDK0.x guide exactly, not as a product migration recommendation.
- Root DinD plus host networking is a strong trust surface. No broad credentials belong in the builder. The probe key authorizes arbitrary root exec and existed only for this scratch Worker. Product job tokens, egress restrictions, extraction safety, callback persistence and hard deadlines remain necessary.
- Two cold samples in one CF region are feasibility evidence, not a distribution or sustained Docker Hub quota test. Native workload and tar export worked, but other app sizes/architectures remain untested.

## Exact successful recipe for phase3's starting point

Keep this startup/control recipe until the production Go supervisor is validated to provide equivalent behavior. Do not reintroduce a custom Python PID1. Instrumentation and fixture COPY lines below are SPIKE ONLY. Phase3 must retain host networking for builds and add its job-scoped control logic.

```dockerfile
# SPIKE ONLY. Exact Cloudflare Sandbox SDK 0.x DinD pattern; never merge.
FROM docker:dind
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /container-server/sandbox /sandbox
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /bin/bash /bin/bash
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2
RUN apk add --no-cache curl python3 time
COPY start-docker.sh /usr/local/bin/start-docker.sh
RUN chmod +x /usr/local/bin/start-docker.sh
COPY fixtures /fixtures
COPY measure.sh /usr/local/bin/measure.sh
ENTRYPOINT ["/bin/sh", "-c", "mountpoint -q /tmp || mount -t tmpfs none /tmp; exec /sandbox \"$@\"", "--"]
CMD ["/usr/local/bin/start-docker.sh"]
```

start-docker.sh:

```sh
#!/bin/sh
# SPIKE ONLY — Variant A, documented flags, persistent-path diagnostic log.
set -eu
dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false --ip-forward=false --exec-opt native.cgroupdriver=cgroupfs > /var/log/dockerd.log 2>&1 &
timeout 60 sh -c 'until docker version >/dev/null 2>&1; do sleep 0.2; done'
echo 'Docker is ready'
wait
```

Compose augmentation (b example):

```yaml
# SPIKE ONLY: required for package-download build steps.
services:
  node:
    build:
      network: host
  python:
    build:
      network: host
```

## Spend and instance-minute ledger

Application created00:21:01Z, deleted00:27:54Z: **6.89min ×3 configured slots =20.65 standard-4 instance-minutes** as a conservative pre-delete bound (only two build instances and a short cancellation run actually ran). Milestone bounds:00:24Z <9min;00:26Z <15min; deletion <21min. Started_at in instance records reflects pool creation, so it was not used as accurate billable activation time.

Current published full-utilization upper rate: (4vCPU×$0.000020 +12GiB×$0.0000025 +20GB×$0.00000007) per second = **$0.006684/min**. CPU is billed on active use, memory/disk on provisioned resources; included allowances ignored. Pre-delete compute upper estimate **$0.138**. Conservatively reserve another15min for each of3slots because deletion says shutdown may lag: total **<66 instance-minutes / <$0.442 compute**. Allowing registry/Worker/DO/log/network overhead, **estimated total under$0.75**, not an invoice. No R2 usage. This stays below this attempt's$5/300min cap and phase0's$10 cap including attempt1's<$0.25. No long-lived resource was left intentionally running.

## Cleanup evidence (SAM Staging API)

| Resource | Mutation and independent verification |
|---|---|
| Container application a031aea6-dbed-4031-b847-b6e9892f5ecc | DELETE200 at00:27:54Z; GET404 code1609 at00:27:55Z; final application list200, zero sam-build-spike2 matches00:28:33Z |
| Worker sam-build-spike2-a, including SPIKE_KEY secret | DELETE200 at00:27:56Z; GET settings404 code10007 at00:27:56Z; final scripts list200, zero matching Workers00:28:34Z |
| Registry sam-build-spike2-a-sandbox:462290ef | delete via Wrangler registry API exit0 at00:28:01Z, digest fca672b5…; subsequent registry API catalog list exit0 at00:28:32Z, zero sam-build-spike2 repositories/tags |
| Scratch R2 bucket/objects | Creation403; no objects uploaded; exact bucket GET404 code10006 at00:28:34Z |
| R2 token | Never created: permission-group listing failed before token POST; no token to revoke |
| Local probe/registry credentials | Throwaway key removed; registry.cloudflare.com login entry removed locally after registry verification |

DELETE confirms control-plane removal; no independent billing stop timestamp was obtained. Evidence job `sx-c0d893263e0a5473d93c9d6cf84f4ac2b25b2d110a6907373acbc911857ae738`, completed exit0. Cancellation evidence job `sx-46037a59b521ae43976e174ddf9b804463925f53f73a3a7f28c7de6d6c6ec8a2`, completed exit0. cleanup-evidence.json contains filtered deletion/status evidence; unrelated registry entries are omitted.

## Attempt1 history (2026-11-06)

Task01M6SKAGQMGFVT94M9R26DNY4Z, commit a68718a70: Docker28.5.2/Compose2.40.3 on standard-4, custom Python PID1, missing explicit cgroupfs flag, log initially hidden by /tmp tmpfs. Port8080 readiness failed after~20s with Network connection lost; later dockerd absent, no recovered fatal log and no successful docker info/build. Existing DOs served old code after redeploy; max_instances1 capacity stayed exhausted after stop/destroy. Thus attempt1 was inconclusive, not proof DinD or overlay storage was impossible. All its scratch resources were deleted; spend estimate<$0.25. Attempt2's successful combined recipe resolves feasibility but cannot identify a single causal fix.

## Full docker info (cold suite1)

```text
Client:
 Version:    29.9.3
 Context:    default
 Debug Mode: false
 Plugins:
  buildx: Docker Buildx (Docker Inc.)
    Version:  v0.38.2
    Path:     /usr/local/libexec/docker/cli-plugins/docker-buildx
  compose: Docker Compose (Docker Inc.)
    Version:  v5.7.0
    Path:     /usr/local/libexec/docker/cli-plugins/docker-compose

Server:
 Containers: 0
  Running: 0
  Paused: 0
  Stopped: 0
 Images: 0
 Server Version: 29.9.3
 Storage Driver: overlayfs
  driver-type: io.containerd.snapshotter.v1
 Logging Driver: json-file
 Cgroup Driver: cgroupfs
 Cgroup Version: 2
 Plugins:
  Volume: local
  Network: bridge host ipvlan macvlan null overlay
  Log: awslogs fluentd gcplogs gelf journald json-file local splunk syslog
 CDI spec directories:
  /etc/cdi
  /var/run/cdi
 Swarm: inactive
 Runtimes: runc io.containerd.runc.v2
 Default Runtime: runc
 Init Binary: docker-init
 containerd version: 
 runc version: v1.5.2-0-g29dd3dc
 init version: de40ad0
 Security Options:
  seccomp
   Profile: builtin
  cgroupns
 Kernel Version: 6.18.56-cloudflare-microvm-2026.10.9
 Operating System: Alpine Linux v3.24
 OSType: linux
 Architecture: x86_64
 CPUs: 4
 Total Memory: 11.93GiB
 Name: cloudchamber
 ID: fe1b0149-8f6c-414b-af97-36c5d592eeba
 Docker Root Dir: /var/lib/docker
 Debug Mode: false
 Experimental: false
 Insecure Registries:
  127.0.0.0/8
  ::1/128
 Live Restore Enabled: false
 Product License: Community Engine
 Firewall Backend: iptables
  EnableUserlandProxy: true
  UserlandProxyPath: /usr/local/bin/docker-proxy

```

References: [official DinD recipe](https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/), [Containers FAQ](https://developers.cloudflare.com/containers/faq/), [instance limits](https://developers.cloudflare.com/containers/platform/limits/), [pricing](https://developers.cloudflare.com/containers/platform/pricing/), [R2 token scopes](https://developers.cloudflare.com/r2/api/tokens/).
