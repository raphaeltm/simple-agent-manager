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
- [x] Measured <=1s shutdown on fence loss; no serving until verified restoration; structured error and unhealthy/recovery evidence.
- [x] Prove workload/Worker cannot change control-plane firewall.
- [x] Wire deploy/upgrade/compose minimally; preserve s3 R2_S3_REGION requirement.
- [x] Unit/live tests plus self-host-only import graph; lint/typecheck/build/full relevant checks.
- [x] Security design follow-up acceptance, final-head security and supporting specialist reviews.
- [ ] Final task-completion validation before archive.
- [x] Coordinate BOX after H2 BOX FREE; prove all denials/recovery/flush stop/scoped token/normal workload; clean resources/access.
- [ ] Draft PR, ready CI+CodeRabbit; merge main first; current-head gates; merging channel note; merge; monitor production; idea SHIPPED.

## Acceptance

Every checklist item above is required. Report numerical test totals and exact box head. No token/secret output. No new accounts. Clean every created VM. No merge while any gate is outstanding.

## Validation evidence

- Runtime source final reviewed head bbd7e5d1ce85b95f6fb57d05eaae524307221a9b, fresh main base917077fef; main merged before final release (already up to date).
- Self-host unit26files536passed/3hostskip; kernel66passed,27ms stop; pinned native celld isolation1passed; Worker import graph4passed; dependency governance6passed. Root lint23/typecheck38/build19 passed. API17904passed/5skip; web5459passed on full rerun. Initial unchanged ErrorBoundary teardown error reproduced separately then focused4/4 and whole-web rerun passed.
- CodeRabbit/Codex23inline threads resolved with evidence. Design security PASS; final security PASS on exactbbd7e5d1c. Final completion/release gates pending below.
- Disposable VM sam-l23-5sp7kd (same e2-standard-4/Ubuntu2404 as shared BOX), existing VM account/network. Shared H2 application/data untouched; no accounts/grants created. VM candidate source updated from exactbbd7e5d1c archive; images runtime-identical to236e5b10b (later changes are comments/docs/tests only).
- Real Google source-token controls: other public bucket and Cloud DNS200. CAB token: configured bucket object write/read200, other bucket403, Cloud DNS403, caller scope/resource overrides404. Actual other Linux UID403. Never printed tokens/secrets. Native failure Docker logs known-secret absent, REDACTED marker present.
- Real pinned celld HTTP/SQLite DO workload0->1, restart retained1->2; flush stopped serving20ms,2seconds no-serving, unhealthy latch/lost attestation/structuredevent; operator recovery retained2->3. Final cold POST exceeded200ms proof deadline but follow-up confirmed persisted4; not a lost mutation. Verifier passed all classes including DNS TCP/UDP, UDP,127.0.0.2 and routed IPv6 through owned veth/namespace.
- Earlier preparation failures (unsupported native metadata audience query, proof script sudo/path and lost-attestation format assumptions) were corrected and superseded by successful final proof. Artificial local IPv6 aliases at port80 invoked intentional Caddy-local exception; replaced with real routed peer, all deny classes passed.
- Cleanup complete23:25:51UTC: VM, bootdisk and own firewall all HTTP404; exact storage prefix empty (all generations deleted), owned compose containers/volumes, nft table, veth/namespace absent. Namespace deletion automatically removed its veth peer; explicit subsequent host deletion reported already absent, then absence verified. No resources remain. Current-head CI, final completion and merge/production/SHIPPED remain release gates.
