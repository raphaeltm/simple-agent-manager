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

Final local review: deployment-mode controls preserve existing capabilities/scopes and preflight full-mode OAuth changes before deploy; no silent promotion. Explicit workers.dev create/preserve preview is approved/fingerprinted, existing account address unchanged; current API lacks conditional-create, so external admin races remain documented. Cleanup cross-session circular waits now have explicit grant/session/reserve-bound deadline, tested with actual reciprocal DO queues and retry. Installer85tests and full100-capture Playwright audit pass; independent screenshot re-review passes the workers.dev row. Full quality scripts suite57files/780tests pass after updating exact legacy/shared mutation route assertion; Wrangler configured-secret inventory corrected. Inner runtime build R2 transport config moved outside all mounts; README explicitly identifies reviewed source/dependencies as trusted deployment code and inner containers as compatibility rather than malicious-code isolation.

Checkpoint1df800bbd deployed to install.sammy.party, livehealth confirms SHA and oauthConfigured=false. Run40743972820 passed browser audit and real isolated bootstrap smoke/cleanup, uploaded screenshot artifact12840771935, then failed OAuth registration403. PR screenshotcomment6477154447 published. CI40743980264 first failures: stale workflow assertion (fixed), screenshot evidence metadata (updated), inherited needs-human-review label requiring human removal. Full-mode live proofs remain incomplete; draft/unmerged.

## Adversarial completion audit — additional required fixes

Independent task-completion-validator verdict FAIL (not ready) identified functional gaps beyond live proofs:

- [ ] Reject older/diverged or protocol-incompatible releases before update approval and enforce immutable candidate compatibility at builder admission.
- [ ] Preserve verified full-history canonical Git source/baseline/tree in the user's account; restore same-source recovery without public GitHub availability; detect/reject changed preserved source.
- [ ] Propagate and enforce approved workers.dev target in strict installation engine; no silent account address creation under a different prefix during resume/update.
- [ ] Verify API release identity plus web app/setup availability before reporting completion. Container/runtime real startup stays a separate live proof.

Shared-engine staging run40745097252 failed in infrastructure phase after preflight, publisher runtime retrieval and state backend passed. No blind retry; inspect authoritative Cloudflare/Pulumi state and improve safe operation/exit diagnostics before another run. Agents assigned: design_critique update compatibility; cloudflare_installer_plan source preservation/approved target; deployment_engine_audit infrastructure diagnosis/readiness. Keep goal incomplete and PR draft.

## Final staging acceptance matrix

These are required verification outcomes, not claims that the flows have passed. Use one pinned candidate and one isolated installation, preserve its exact account/domain/resource journal, and clean up only resources created by the test. Confirm paid proof approval before running the cold builder.

| Flow                      | Required evidence                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent and cancellation  | Actual Cloudflare consent succeeds with documented scopes; denial/cancellation returns a useful retry state without creating installation resources.                                                                                                 |
| Account and DNS approval  | Choose the authorized account/active zone, inspect exact DNS conflicts and workers.dev create/preserve target, approve immutable source/configuration; changed account/domain/target requires fresh preview.                                         |
| Independent ownership     | Save browser-generated recovery before claim, open maintenance, consume claim once; disconnect hosted installer and revoke its OAuth authority; owner recovery and account-owned deployment/runtime/storage credentials still function.              |
| Fresh installation        | Build all modified runtime/VM/API/web/CLI artifacts in the selected account; durable deadline and scoped state/artifact storage; API and web release identities match approved source; owner-only private setup token is usable.                     |
| First administration      | Before the owner signs in, another provider-verified identity cannot become initial administrator; approved verified identity completes setup and receives exactly one initial admin role. Existing deployed users still sign in.                    |
| Interruption and resume   | Close/reopen browser and recover independently; cancel a real build, confirm whole-container shutdown, resume the same immutable job without duplicate resources or rebuilding under changed accepted runtime pins.                                  |
| Source independence       | Restore the accepted full-history source from account-owned preserved bytes with upstream unavailable; detect altered bundle/hash/tree, avoid replacing baseline or silently losing local changes.                                                   |
| Approved updates          | Refuse older/diverged/incompatible releases before paid compute; preview and approve a compatible ahead release, pass migration safety gates, preserve credentials/owner/domain/runtime identity where unchanged, and verify API+UI deployed source. |
| Recovery rotation         | Prepare replacement, save it, confirm; old credential remains usable before confirmation and is rejected afterward; dropped response or stale tab does not strand access.                                                                            |
| Partial bootstrap cleanup | Interrupt before transfer, expire/revoke bootstrap authority, reconnect with same-account consent and use Finish cleanup; delete only recorded untransferred principals, preserve transferred service authority and unrelated credentials.           |
| Runtime verification      | Provision one bounded staging VM using effective installation/project credentials, verify heartbeat and supported modified runtime execution, then delete test VM/workspace promptly.                                                                |

Independent review must reconcile this matrix with actual artifacts/results; mock/unit success alone cannot satisfy real-grant or real-build rows. Keep PR draft regardless of successful tests; human decides final readiness/merge later.

## Reviewed candidate after completion audit and external review

Implemented all four completion-audit code corrections: forward-only protocol-compatible releases guarded before approval and builder admission; full-history account-owned canonical source with immutable manifest and DO-persisted exact identity on resume; strict approved workers.dev propagation; API+Pages deployed release identity plus routed UI/setup/assets readiness. Real Git tests cover upstream deletion and missing/changed accepted manifests, tree/hash/size tampering and archived bytes. Root actualWranglerbuild caught bundler-generated free __name inserializedfunction; replacedwithliteralbootstrap and testedcompiledkeepNames module incleancontext.

CodeRabbitreview5687930326 (18:45UTC) returned twofindings: historicalfirstowner lockout and READMEspacing. Fixed historicalelection marker atomicallywithD1promotion; lifecycleemail/suspension/demotion/delete and total-user-deletion re-election tests pass. Independentsecurityreview confirms firstowneridentity isnotweakened to anyarbitraryadmin. Defaults textspacing corrected. Lowavailabilityrace onlyconcurrentlegacy-preview upgradeprobes can requireoneretry; noauthorizationbypass, fresh electionsatomic.

SonarCloud firstfullgate failednewsecurity/reliability andcomplexityfindings. Addressedwithfixedexecutablepaths, SHA256-derived40hex runtimeidentity, standardESM trustedfixtureimports, explicit37-required-secret CI allowlist, pnpm ignore-scripts atisolated workflowinstall, explicitcomparators, cleanup preservingoriginalfailure, boundedlinearowneremailvalidation and focusedhelperextractions. No blanketexclusions or NOSONAR. ActualSonarJS S3776 scan ofall111changed/untrackedfiles returns0issues.

Latestlocalvalidation: installer103tests/lint/typecheck/full100-capturebrowseraudit/build (426.72KiB); API37focusedauth/owner tests+typecheck; engine/proof34tests;8Nodebootstrap/runtime/sourcecache/integritytests; fullqualityscripts780tests; Wranglersecretinventory anddeployTSchecks pass. Independentreviews cover latest router/provision/session/cleanup/auth/source-persistence/update-policy changes. NewliveCI/stagingevidence stillneeded.

Wrongstatebackendincident: CIadapter nowusesexistingresolveResourceNames (sam-pulumi-state), nevercreates installation-defaultbucketforlegacyCI. Failedrun40745097252 createdsam-pulumi-state-staging at18:28:32.592Z; nine unchanged encryptedPulumi objects holdstack/provider/randomresources only, noCloudflare resourceentries. Availablemanagedread-onlytoken deniesobjectDELETE andWorkerPUT403; noobjectsdeleted/nohelperWorkercreated. ConnectedPersonalOAuthdoesnotaccesstargetstagingaccount. Cleanupremainsrequiredwhenwriteauthorityavailable; originalbackendandpublicAPI/appremainintact.

Staging retry40751145382 failed before any engine phase or cloud mutation: GitHub toJSON on absent optional secrets produced null, while the private input contract correctly requires strings. Explicit allowlisted secret expressions now coalesce missing values to empty strings. New actual CLI boundary regression renders the real workflow payload with missing optional secrets and a quoted/multiline private value, validates adapter startup and private environment forwarding, and verifies structured credential-safe startup errors on invalid input. Focused engine/CLI tests now36PASS, full780qualityPASS, strictTS/Sonarcomplexity/diffcheckPASS. Earlier CodeRabbit two threads replied and resolved on02cb80472; incremental review40751208413 requested successfully.

## Cold-build continuation — 2026-10-29

Raphaël authorized a reasonable cold-build test below $5. Updated managed staging CF_TOKEN now permits Worker creation. GitHub cannot dispatch the new proof workflow while it is absent from main, so the reviewed launcher runs through managed-secret execution against pinned source 82940bdb9e36b8a1c618e3a7da825d59ed140536.

The first live API validation exposed missing Worker upload `metadata.containers`: Cloudflare rejected the application with `Durable Object namespace is not Container-enabled`. Both the proof Worker and installation maintenance Worker now explicitly declare their builder class. The existing provisioning boundary test asserts that contract. Installer 103 tests, typecheck, six proof tests and formatting pass.

One actual credential-free cold build started at 08:31:52 UTC: proof `sam-build-proof-907cd4d61cfd`, application `75d306039a434f4a97d80e8c78527aa2`, two vCPU/eight GiB/16 GB disk, durable 60-minute stop. Compute upper estimate $0.220032 before allowances; conservative incremental estimate $2. Execution ID `sx-5868a31e390192d3929b2069db09c279890d2b1334cee9f5776089b14eea8c73`. Validation-only attempts created no paid container and cleaned up. Result and final cleanup remain pending; this is not a successful-build or full-install claim. Keep PR #2465 draft and unmerged.
