# L23: egress fence and metadata token proxy

## Problem
Land only L23 from origin/sam/selfhost-pass-2 on fresh main. F3: full VM token depended on unproven runtime isolation. F4: scopes parameter ineffective. F5: incomplete probes, unfenced serving after flush, missing DNS/IPv6/UDP/127.0.0.2, Caddy admin allowlist bypass. M5: s3 operator store requires R2_S3_REGION.

## Research / preflight
Classes: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, infra-change, docs-sync-change. Main prerequisite 917077fef (#2901/#2902/#2906). No Worker runtime changes are intended; import graph tests must prove this.
Integration nft watchdog and celld entrypoint already have probes/attestation, but polling has a gap. Design security review found HIGH polling gap, MEDIUM established-socket bypass and MEDIUM UID7101 collision with main Caddy. Coordinator decision event1d303f49 accepts <=1s measured stop and verified recovery, with structured error trace/admin unhealthy state, because only host root/CAP_NET_ADMIN can flush the control-plane firewall. No BPF mechanism in this slice. Workload nodes remain separate per-user VMs; privileged nested containers remain supported.
Metadata design approved: fixed fleet-bucket Credential Access Boundary via STS; never return upstream VM token. Read-only maps objectViewer, read-write maps objectAdmin; no full_control, caller resource/scope override or wildcard grants. Secret path retained only with real pinned celld isolation proof. No OAuth registration/callback. Operator config once per install (bucket/profile); existing VM account bucket object permissions suffice. Two SAM users/projects share installation backend intentionally; no user receives proxy credential. Compromised scoped token reaches only fleet bucket objects until source token expiry; plaintext fleet bucket remains an installation secret on main. Never imply this is per-user bucket isolation.
Official constraints: CAB applies only to Cloud Storage, max10 rules; use one fixed bucket rule. STS exchange no new grants. Metadata enforce_scopes=true now exists but scopes must be subset of instance; CAB is needed for bucket restriction. Sources: https://docs.cloud.google.com/iam/docs/create-downscoped-short-lived-credentials and https://docs.cloud.google.com/compute/docs/metadata/querying-metadata . Fixed source URLs, redirects disabled, bounded I/O, generic errors, no tokens/paths logged. SDK preference: assess existing Google auth dependency before custom exchange.
Trace: deploy -> fence-state rules/celld.env -> compose dedicated UID/NET_ADMIN sidecar -> kernel OUTPUT -> celld entrypoint probes/attestation -> Worker fetch. Native GCS storage -> loopback metadata proxy -> metadata service -> STS CAB -> scoped token. No Cloudflare request cost.
Docs stay experimental operator guide in deploy/selfhost/README.md per landing plan, not publicized on docs site (same exception as L22).

## Checklist
- [x] Fresh main branch; checkout exact integration paths then trim held features.
- [x] F3/F4 fixed-bucket scoped metadata proxy, scope mapping and malicious request tests.
- [x] Pinned real Worker runtime environment/filesystem isolation proof.
- [x] Dedicated UID distinct from Caddy/mx/proxy; no capabilities.
- [x] Caddy admin refusal across allowlist/endpoints/lease range/local addresses.
- [x] Reply-direction established rule and spanning-flush regression.
- [x] Complete start/verify probes: DNS TCP/UDP, IPv6, UDP,127.0.0.2 and every blocked class.
- [ ] Measured <=1s shutdown on fence loss; no serving until verified restoration; structured error and unhealthy/recovery evidence.
- [x] Prove workload/Worker cannot change control-plane firewall.
- [x] Wire deploy/upgrade/compose minimally; preserve s3 R2_S3_REGION requirement.
- [ ] Unit/live tests plus self-host-only import graph; lint/typecheck/build/full relevant checks.
- [ ] Security design follow-up acceptance, final-head security, task-completion and supporting specialist reviews.
- [ ] Coordinate BOX after H2 BOX FREE; prove all denials/recovery/flush stop/scoped token/normal workload; clean resources/access.
- [ ] Draft PR, ready CI+CodeRabbit; merge main first; current-head gates; merging channel note; merge; monitor production; idea SHIPPED.

## Acceptance
Every checklist item above is required. Report numerical test totals and exact box head. No token/secret output. No new accounts. Clean every created VM. No merge while any gate is outstanding.

## Validation evidence (candidate before BOX)
- Self-host unit: 23 files, 487 passed / 3 skipped (host lacks nft capabilities; isolated kernel lab runs those paths).
- Privileged isolated netns lab: 66/66 passed; latest flush-to-stop27ms; partial-rule startup, transient loss, observer death, DNS TCP/UDP, routed IPv6, reply-only conntrack, UID denial and operator recovery covered.
- Pinned celld0.6.3 bucket runtime: native canary exists in parent /proc environ but exact Worker comparison false; envOwn false/envNames empty, native files inaccessible, /bin/true child exec refused with native success control. 1/1 passed.
- Worker import graph4/4; dependency governance5/5. Public resolver startup regression red when filter removed, green restored.
- Root lint23/23, typecheck38/38, build19/19 passed. Full root tests:39/41 tasks succeeded; web433files5459tests passed but3unhandled window teardown errors in unchanged ErrorBoundary test caused failure/cancel; focused rerun pending.
- BOX FREE417, yielded toL24. Shared H2 head/data unchanged; ownSSHmetadata keys absent + firewall404 verified, noVM/accountcreated. Future BOX uses disposable isolated install from main-based candidate, preserving H2DO/data (coordinator eventc3b97be7).
- Pending: final-head security/completion, current-headCI/CodeRabbit, isolated BOX scoped token+normal workload proof/cleanup, merge/deploy.
