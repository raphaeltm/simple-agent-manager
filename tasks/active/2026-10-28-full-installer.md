# Full hosted SAM installer

User authorization: complete the installer, pursue the goal, independently review implementation and documentation, make PR2465 green while keeping it DRAFT and UNMERGED, deploy to staging for human testing. Preserve approved branding.

## Research and implementation plan

Prior session3df4a676-3a87-43bb-9308-6b88c0f4be36 directly read before scoped search; accepted design idea01M60R60ZQT4203MGXAVJNPRH5 saved locally at .codex/tmp/installer-design-v4.txt. Independent Cloudflare, deployment-engine and security/auth audits complete.

- [x] Reconcile prior research and preserve draft restriction (PR2465 converted to draft).
- [ ] Build runner-neutral orchestration reusing Pulumi, migration gates, immutable publication and ordered API/tail/Pages deployment; use same engine from CI and maintenance.
- [ ] Package source-built patched Codex with an installation-owned trusted catalog; preserve publisher verification defaults.
- [ ] Durable user-owned maintenance coordinator: consume claim once, independent owner sessions/recovery, approved source/config jobs, locking, progress, cancellation and manifest.
- [ ] Account-owned least-privilege installation/runtime/storage credentials; prove child credentials survive central OAuth revocation. Never retain central refresh-token authority as fallback.
- [ ] Managed-image in-account Container runner: pinned checkout/toolchains, Docker, persistent Pulumi state and artifacts; bounded jobs and shutdown.
- [ ] Domain/account/DNS preview and explicit approval, credential transfer only to exact created service, owner-bound main SAM setup.
- [ ] Release update via same approved-source engine; preserve local modifications.
- [ ] Update public self-hosting/privacy/config/security docs against proven behavior.
- [ ] Independent implementation/security/Cloudflare/documentation/completion reviews; fix findings.
- [ ] Relevant tests and CI green, real first install plus interrupted/resumed install and update on staging, screenshot review of changed surfaces.
- [ ] Best-effort CodeRabbit requested once, findings resolved if returned; PR remains draft and unmerged.

## Evidence and known execution gaps

Approved design staging run40729553497 deployed c5adfb9ae; bootstrap smoke passed but OAuth configuration failed403/code10000. Live design/browser checks passed, full install is not yet functional.

2026-10-28 connected Cloudflare Personal OAuth request to SAM account e2eb9a8d5b560cce006fdd03ad6f2e49 OAuth-client listing confirms HTTP403: no OAuth scope covers endpoint, requires API-token permission OAuth Client Read. Existing GitHub deploy token has same failure. Do not bypass readiness gate or claim real OAuth proof.

Scoped child-token lifecycle, managed-image runner eligibility and full cold Rust/Docker build resource fit require real bounded account tests. Before long-running paid proof, prepare script and conservative cost bound then check user per staging rule13.

## Local agent ownership

- deployment_engine_audit: new scripts/deploy/installer-engine* and focused tests.
- cloudflare_installer_plan: source-built trusted Codex packaging and necessary existing consumers.
- design_critique: maintenance.ts durable auth/coordinator and focused tests.
- root: bootstrap provisioning, credential APIs, runner integration, owner binding, docs/PR/staging coordination.

## Shared engine / existing CI parity audit (2026-10-28)

The reusable deployment workflow now runs `pnpm exec vitest run --config scripts/deploy/installer-engine.vitest.config.ts` immediately after dependency installation. Six engine behavioral tests pass with fake subprocess/Cloudflare boundaries; workflow YAML parsing and formatting pass. **This is a contract-verification gate, not shared mutation execution. Existing CI deployment mutations still use the original workflow. The first implementation checklist item remains incomplete.** No staging or production mutation was performed for this gate.

Before replacing existing CI deployment commands with the engine, complete these concrete adapter/parity tasks:

- [ ] Preserve `workflow_call` inputs: `environment`, `target_commit_sha`, `dry_run`, `skip_agent`, and compatibility `agent_email`. The engine currently always applies Pulumi, migrations, artifacts and deploys. Add a preview execution path preserving current `pulumi preview --diff` behavior and a skip-agent path that neither publishes agent binaries nor advertises a required agent version. Preserve checked-out SHA verification and full-history source requirements.
- [ ] Preserve resource/state inputs from `Validate Deployment Resource Names`: `RESOURCE_PREFIX`, `BASE_DOMAIN`, and explicit `PULUMI_STATE_BUCKET`. The engine currently recomputes the state bucket and cannot honor an existing override. Resolve actual zone name/account workers.dev subdomain without changing unrelated existing DNS or account settings; populate new optional Pulumi `zoneName`/`workersDevSubdomain` inputs compatibly.
- [ ] Add a CI runtime artifact adapter, distinct from the installation source-build adapter. Existing CI may retain its reviewed publisher Codex archive/checksum path; installation builds must keep the in-account source-build/cache path. CI publisher mode must not unnecessarily require Rust 1.95.0 or require a new owner email. Preserve exact Go 1.26.10 toolchain verification, VM-agent source release/build date, pinned runtime publication and container binary identity.
- [ ] Set `VM_AGENT_REQUIRED_VERSION` explicitly from the resolved VM-agent release on normal builds and explicitly empty for skip-agent builds. The current engine sets only `VM_AGENT_RELEASE` and `VM_AGENT_BUILD_DATE`, whereas `sync-wrangler-config.ts` consumes `VM_AGENT_REQUIRED_VERSION`; inherited runner environment must not supply a stale version.
- [ ] Preserve the complete Worker configuration mapping: both workflow steps `Sync Wrangler Config (API + Tail Worker)` and `Re-sync Wrangler Config (add tail_consumers)` currently have **521 environment entries each**. Move these existing expressions as one centralized CI environment mapping passed to the engine; do not rebuild a partial hand-selected inventory. Assert both sync invocations receive identical optional overrides. Preserve `ARTIFACTS_BINDING_ENABLED`, preview settings and all operator tunables. The engine inherits process environment but does not obtain GitHub `vars` automatically.
- [ ] Preserve all 17 `Build Applications` inputs: `VITE_API_URL`, `VITE_PUBLIC_WEBSITE_URL`, `VITE_FEATURE_MULTI_TERMINAL`, `VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES`, `VITE_PROJECT_LIST_LIMIT`, `VITE_PROJECT_POLL_INTERVAL_MS`, `VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS`, `VITE_WORKSPACE_PORTS_POLL_MS`, `VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS`, `VITE_WORKSPACE_PORTS_FAILURE_BUDGET`, `VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO`, `VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS`, `VITE_PROJECT_PREFETCH_DELAY_MS`, `VITE_BACKGROUND_FETCH_DELAY_MS`, `VITE_ACP_PERMISSION_POLL_MS`, `VITE_ACP_PERMISSION_RECOVERY_POLL_MS`, and `VITE_ACP_PERMISSION_QUERY_RETRY_COUNT`. Preserve their current GitHub default expressions.
- [ ] Preserve all 44 entries in the `Configure Worker Secrets` environment, including GH-to-GITHUB mapping, generated Pulumi keys, explicit legacy `SECRET_ENCRYPTION_KEY`/`SECRET_JWT_PRIVATE_KEY`/`SECRET_JWT_PUBLIC_KEY` overrides, deployment/VAPID key overrides, Google/GitLab credentials, webhook/auth, trial/analytics and cache credentials. Existing CI has no separate `CF_RUNTIME_API_TOKEN` or approved owner email: explicitly model legacy credential mode rather than silently broadening installation runtime credentials or inventing an owner. Leave `BOOTSTRAP_OWNER_EMAIL` unset on legacy installations.
- [ ] Retain `CLOUDFLARE_API_USER_SERVICE_KEY` from optional `CF_ORIGIN_CA_KEY` on Pulumi preview/refresh/up, `AWS_REQUEST_CHECKSUM_CALCULATION=when_supported`, and `PULUMI_REFRESH_MAX_ATTEMPTS`/`PULUMI_REFRESH_RETRY_DELAY_SECONDS`/`PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES`. Retain the explicit S3 `.pulumi/meta.yaml` access preflight and its actionable failure, rather than assuming REST bucket inspection proves S3 credentials work.
- [ ] Restore optional/prepared service behavior: automatic `configure-agent-email.ts` before the first sync and its marker-driven email binding; R2 CORS; AI Gateway; D1 replication; staging-only KV `trials:enabled=true`; Pages domain verification before wildcard Worker publication. The engine currently omits agent-email preparation and the staging trial switch. Preserve the API/Tail first-install ordering and secrets-before-final-API ordering already covered by engine tests.
- [ ] Preserve Docker runner differences: GitHub host mirror configuration/restart belongs to the CI adapter; managed-image DinD needs a supported host-network build strategy instead. The engine currently delegates image builds to Wrangler and does not itself force `--network=host`. Prove each runner's image build/push path.
- [ ] Preserve Worker deploy warning validation: existing CI fails on unexpected non-inherited bindings, with only the intentionally gated Artifacts exception. The engine currently checks command exit status only and suppresses child output. Add structured validation of captured deploy diagnostics without exposing secrets.
- [ ] Keep GitHub-only reporting outside the engine: deployment outputs `api_url`/`app_url`, VM container version summary, final success/failure/dry-run summary and security-key source status. Engine JSONL/checkpoints/private setup results must not leak into GitHub artifact uploads or step summaries. Existing VM and CLI R2 artifact publication remains part of deployment semantics.
- [ ] Qualify equivalence on staging before switching the shared workflow: compare ordered mutation plans for existing install, clean bootstrap, missing-tail repair, dry-run and skip-agent; nondefault Worker/VITE settings; custom state bucket; legacy explicit keys and owner unset. Then execute a real bounded staging deploy with migrations/health evidence. Only after equivalence passes replace old mutation blocks, keeping setup/env/report adapters in YAML.

The remaining parity work is explicit implementation work, not a standing documentation rule or a staging waiver. The mock gate must never be reported as proof that current production CI and maintenance already execute one mutation engine.

### CI compatibility implementation progress

2026-10-28: added an executable legacy-CI runner adapter and implemented the parity branches in the shared engine. `installer-engine-ci-env.json` preserves the existing non-secret GitHub expressions; a regression test checks all extracted mappings against the unchanged legacy workflow (including identical first/repeated Worker sync mappings). `installer-engine-ci-cli.ts` reads non-secret input JSON and private `SAM_CI_SECRETS_JSON`, emits normal deployment outputs/summaries, and keeps secrets out of configuration/checkpoints. The strict installation profile still requires an approved owner plus separate runtime principal and rejects CI-only preview/skip-agent/state override options.

Implemented engine branches cover preview, skip-agent with explicitly empty required version, normal resolved `VM_AGENT_REQUIRED_VERSION`, custom state bucket, publisher Codex hooks only for legacy CI, exact Go toolchain, legacy key and Origin CA overrides, explicit S3 state preflight, agent email preparation, staging trial flag, CI Docker mirror setup, first-install/missing-tail sequencing, identical sync overrides, and Worker binding-warning validation. Fourteen local engine/adapter tests, deploy TypeScript and targeted ESLint pass. Main workflow still runs only the contract gate; production mutation cutover and real staging equivalence proof remain pending. The earlier parity checklist is retained as the acceptance checklist rather than falsely marked complete by mocked verification.

## Implementation checkpoint — functional iteration 2

Implemented in this branch, not yet enabled as a supported full-install experience:

- Shared engine/strict installation and legacy-CI profiles; private owner handoff; safe opt-in shared-engine staging path with legacy/shared mutations mutually exclusive. Production remains on the existing path until staging equivalence is proven.
- Source-built patched Codex packaging, immutable verified account cache, ABI-matching Bookworm build, real Wrangler Docker networking setting and runtime-aware VM release identity. Unrelated frontend updates preserve runtime/agent bytes.
- User-account coordinator/DO, atomic claim, browser-saved recovery, two-phase rotation, independent sessions, immutable requested jobs, lost-start reconciliation, controlled updates and private setup instructions.
- Initial-admin provider-verified email guard with real SQLite concurrent election; separate Cloudflare deployment/runtime/storage token roles and partial-failure journals.
- Exact zone ownership/DNS preview, stable provisioning identity and retry that never replaces a claimed service. Nested-domain DNS and existing account workers.dev hostname preservation.
- Public documentation corrected; experimental full mode explicitly distinguished from bootstrap mode. No real-grant or build success is claimed.

Validation so far: installer57tests/lint/typecheck/build; engine+CI adapter22tests (plus bounded proof tests); runtime packaging/identity/network6Node tests; infrastructure74tests/typecheck; API31auth/owner tests and typecheck. Browser audit94screenshots, including actual HTTPS navigation forms, cookie/claim, domain preview/conflicts and maintenance states; no horizontal overflow. Browser audit exposed no-referrer causing Origin:null on form POST; strict-origin now withholds URL paths/queries while preserving exact-origin CSRF checks. No acceptance of null Origin.

Independent designer rejected the first functional maintenance layout, then approved iteration2: hierarchy4,interaction4,mobile4,brand4. Installation controls now precede collapsed details/recovery. Uploaded local mock screenshot evidence: mobile maintenance01M61TK0KEF9WRZMME9V7H1N80, desktop full approval01M61TK3P9HQHBBF2EH635JDBJ. These are local mock evidence, not live install proof.

Final security review found an expiring-grant cleanup edge and retry journal-merging edge; fixes are in progress with /root/cloudflare_installer_plan. Before full mode: reserve cleanup authority before grant expiry, bound mutation work, retain nonsecret cleanup receipts and recover cleanup with a fresh authorized grant. Do not discard unresolved token IDs or revoke user-service authority after transfer.

Pending external inputs: OAuth-client Read/Edit registration credential (current token and OAuth connections cannot manage registration); explicit user approval for prepared one-builder60minute standard-3 build-fit proof, conservative incremental$2 ($0.220032 compute maximum before allowances), per staging rule13. No paid proof run or workflow dispatched. Proof container receives no cloud tokens and is isolated from SAM DNS/D1/Pulumi resources; full installation authority and OAuth lifecycle still require separate real-grant verification.

Main staging and installer deployment runs were all complete before this implementation publication. SAM search found only this active installer task. PR2465 remains draft/unmerged; full workflow CI and staging evidence still pending the implementation push and live gates. Do not archive or call goal complete.

## Publication checkpoint

Installer validation now70tests, lint/typecheck/build; full browser audit100screenshots including fresh-grant cleanup UI and real form navigation. Engine/CI/proof25tests and runtime/network6Node tests pass; infra74tests and API31auth/owner tests plus typechecks pass. Format ratchet and runtime tunable ratchet pass. Expiry cleanup budget, transfer-aware retained nonsecret receipts, fresh account-authorized cleanup and pending-job cancellation findings fixed; final independent review running. Managed-secret read-only CF_TOKEN confirmed sammy.party belongs to configured staging account; OAuth clients listing still403/code10000, so registration credential authority remains required. No full OAuth/build/install success claimed. Workers.dev first-account initialization and explicit deployment mode controls in final adjacent implementation.
