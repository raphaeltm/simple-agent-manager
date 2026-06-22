# Deployment Compose Interpolation Config

## Problem

SAM app deployments currently have environment-scoped secret storage, but normalized release apply resolves `{ secret: "name" }` values in the API and injects decrypted values directly into rendered Compose YAML. The deployment node then writes that YAML to disk. Compose-publish has the opposite problem: it preserves raw Compose fields but does not load SAM-managed per-environment config, and `docker compose config` resolves interpolation during capture.

We need per-environment deployment configuration where users manage Variables and write-only Secrets, Compose files use normal `${VAR}` interpolation, plain variables can participate in build/publish and deploy/apply, and secret values are only supplied transiently to deployment-node Docker Compose processes. Decrypted secrets must not be stored in release manifests, previews, signed Compose YAML, node disk state, logs, heartbeat errors, or build/publish requests.

Source idea: `01KVQANNQPBF4PVJR060VYKNG5` ("App deployments: per-environment Compose interpolation config without plaintext secret materialization").

## Research Findings

- `apps/api/src/db/schema.ts` defines `deploymentEnvironments` with `secretsUpdatedAt` and `deploymentSecrets`, but no unified env-key config table or `configUpdatedAt`.
- `apps/api/src/routes/deployment-secrets.ts` exposes legacy write-only secret routes under `/api/projects/:projectId/environments/:envId/secrets`; names allow hyphens, which are not valid Compose env keys.
- Existing runtime config patterns are available in `projectRuntimeEnvVars`, `profileRuntimeEnvVars`, `skillRuntimeEnvVars`, `apps/api/src/routes/projects/_helpers.ts`, `apps/api/src/routes/projects/crud.ts`, `apps/api/src/services/profile-runtime-assets.ts`, and `apps/web/src/components/runtime/RuntimeAssetsSection.tsx`.
- `apps/api/src/services/compose-renderer.ts` uses `ctx.resolvedSecrets` to inject decrypted secret values into `services.*.environment`.
- `apps/api/src/routes/deploy-release-callback.ts` decrypts legacy deployment secrets, calls `renderCompose()`, signs the payload, and returns only `composeYaml`, `routes`, `signature`, and optional registry credentials.
- `apps/api/src/services/deploy-signing.ts` and `packages/vm-agent/internal/deploy/signature.go` sign compose/routes hashes only. Interpolation env is not part of the signed payload.
- `packages/vm-agent/internal/deploy/types.go` `ApplyPayload` has no interpolation env map. `DiskState.WriteRelease()` comments that rendered Compose contains plaintext resolved secrets.
- `packages/vm-agent/internal/deploy/engine.go` runs `pull`, `up`, `down`, and service inspection without custom process env; apply failure and observed-state errors are not redacted against deployment config values.
- `packages/vm-agent/internal/publish/build.go` runs `docker compose config --format json`, `docker compose build`, and `docker compose config` without SAM-managed build env and captures resolved YAML.
- `apps/api/src/routes/mcp/compose-publish-tools.ts` proxies `build_and_publish` without loading deployment environment config.
- `apps/web/src/components/deployments/DeploymentEnvironmentCard.tsx` has logs, metrics, node, and agent policy panels, but no visible per-environment configuration surface. `apps/web/src/components/EnvironmentSecretsSection.tsx` is legacy/unmounted.
- Public app deployment docs live in `apps/www/src/content/docs/docs/guides/app-deployments.md`; repo markdown outside the docs site is not user-facing documentation.

## Relevant Rules And Prior Incidents

- `.claude/rules/06-api-patterns.md` and `.claude/rules/34-vm-agent-callback-auth.md`: VM agent callback routes must use callback JWT auth and be mounted before session-auth project routes.
- `.claude/rules/31-migration-safety.md`: additive migration only; never recreate/drop cascade-parent tables.
- `.claude/rules/23-cross-boundary-contract-tests.md` and `.claude/rules/35-vertical-slice-testing.md`: this feature crosses API, D1, VM agent, subprocess env, and UI boundaries; include realistic boundary tests.
- `.claude/rules/17-ui-visual-testing.md`: UI changes require mobile and desktop Playwright visual audit.
- `.claude/rules/27-vm-agent-staging-refresh.md` and `.claude/rules/13-staging-verification.md`: VM agent changes require staging deployment and real node refresh/provisioning validation before merge.

## Implementation Checklist

- [ ] Add schema and shared contract:
  - [ ] Add migration `0075_deployment_environment_config_vars.sql` with `config_updated_at` and `deployment_environment_config_vars`.
  - [ ] Update Drizzle schema and shared deployment config response/request types.
  - [ ] Add configurable per-env count, per-value byte, and aggregate env-size limits.
- [ ] Add deployment environment config API:
  - [ ] Implement service helpers for masked responses, encrypted storage, deploy interpolation env, build-only interpolation env, and timestamp updates.
  - [ ] Add session-auth routes for `GET /runtime-config`, `POST /runtime/env-vars`, and `DELETE /runtime/env-vars/:envKey`.
  - [ ] Validate env keys with `[A-Za-z_][A-Za-z0-9_]*`, mask secrets, reject empty secret writes, enforce create-only count limits, rate-limit writes, and enforce project/environment ownership.
- [ ] Add callback-auth node config fetch:
  - [ ] Add callback-JWT-only endpoint for deployment nodes to fetch current interpolation env by environment.
  - [ ] Mount before session-auth routes and test through the combined app route stack.
- [ ] Sign and transport interpolation env:
  - [ ] Add `interpolationEnv` to TS and Go apply payloads.
  - [ ] Add deterministic sorted-entry env hash to TS and Go signing contracts.
  - [ ] Add cross-language fixture tests for empty, single, reordered, and multiline values.
- [ ] Update normalized renderer/apply path:
  - [ ] Refactor renderer to emit placeholder YAML plus interpolation env instead of plaintext secret YAML.
  - [ ] Preserve legacy explicit secret refs using deterministic internal env names when necessary.
  - [ ] Attach current deployment environment config to normalized apply payloads.
  - [ ] Update release preview to show placeholders, not fake `***` runtime YAML.
- [ ] Update VM agent deploy engine:
  - [ ] Pass interpolation env to `config`, `pull`, `up`, `down`, and service inspection commands.
  - [ ] Add compose config preflight with missing-variable warning detection.
  - [ ] Redact all interpolation env values from compose stderr/errors, persisted release state, and observed heartbeat errors.
  - [ ] Fetch current env for restart reconcile and teardown without caching decrypted values on disk.
  - [ ] Add label-based cleanup fallback for teardown when env fetch or placeholder resolution fails.
  - [ ] Update disk-state comments and tests to prove placeholders are persisted instead of decrypted values.
- [ ] Update compose-publish/build path:
  - [ ] Load only non-secret build env and secret key names in the API before proxying to the workspace VM.
  - [ ] Add VM build request/options for build env and secret keys.
  - [ ] Separate resolved build inventory from placeholder-preserving deploy template capture.
  - [ ] Capture stderr on successful compose commands and detect missing-variable warnings robustly.
  - [ ] Reject secret references in build/image/publish-control fields; preserve placeholders in stored release manifests.
- [ ] Update compose-publish apply transform:
  - [ ] Preserve interpolation placeholders in deploy-time service fields.
  - [ ] Reject interpolated container ports with actionable diagnostics while allowing host ports SAM rewrites.
  - [ ] Attach current interpolation env in compose-publish deploy callback branch.
- [ ] Add deployment UI:
  - [ ] Add a compact Configuration summary row/panel to `DeploymentEnvironmentCard`.
  - [ ] Implement reusable env-var editor behavior with loading, empty, error, save/update/delete, duplicate-key, long-value, and secret replace/delete states.
  - [ ] Add API client functions and exports; stop using the legacy secret-only UI.
  - [ ] Verify mobile/desktop overflow, focus, ARIA, and long data states with Playwright.
- [ ] Update public deployment docs:
  - [ ] Explain per-environment Variables vs Secrets and Compose interpolation examples.
  - [ ] Document deploy-only secret behavior, non-secret build variable behavior, missing-variable validation, and compatibility status of old secret refs.

## Acceptance Criteria

- [ ] Users can add deployment-environment Variables and Secrets from the Deployments page.
- [ ] Compose files using `${DATABASE_URL}` and non-secret `${PUBLIC_APP_DOMAIN}` style placeholders deploy with SAM-supplied values.
- [ ] Secret values do not appear in D1 release manifests, preview responses, signed Compose YAML, node `docker-compose.yml`, node metadata JSON, logs/errors/heartbeat observed errors, or build/publish requests.
- [ ] Deployment-node Docker Compose commands receive interpolation env through process env and SAM values override host env.
- [ ] Build/publish receives only non-secret variables; secret variable names may be sent only as names for validation.
- [ ] Secret placeholders in build/image/publish-control fields are rejected before build/apply.
- [ ] Missing variables are preserved through SAM capture/render stages and fail at apply preflight or Compose required-expression validation with redacted output.
- [ ] Apply payload signature verification fails if interpolation env key/value content is modified.
- [ ] Reconcile and teardown after node restart work by fetching current config, with best-effort label cleanup fallback for unresolved placeholders.
- [ ] Old `deployment_secrets` and explicit secret refs remain compatible during transition but are no longer the primary UI/product path.

## Test Plan

- [ ] API route tests for CRUD, encryption/masking, validation, limits, rate limiting, and ownership.
- [ ] Callback/apply tests proving placeholder YAML, attached interpolation env, no decrypted secrets in Compose YAML, and signature changes when env changes.
- [ ] Renderer tests for legacy explicit secret refs, generated internal variable names, missing refs, and preview parity.
- [ ] Go tests for signing hash parity, tamper rejection, env propagation to compose commands, redaction, disk placeholder persistence, reconcile/teardown fetch, and cleanup fallback.
- [ ] Compose-publish tests for non-secret build env, no secret env to build commands, placeholder-preserving capture, missing-variable warning detection, secret-in-build rejection, and route-port diagnostics.
- [ ] UI component and Playwright tests for configuration summary/panel, many rows, long keys/values, validation errors, masked secrets, loading/error states, keyboard/focus behavior, and 320/375px no-overflow.
- [ ] Public docs build.
- [ ] Full local quality suite, specialist review, staging deploy, real VM-agent refresh/provisioning verification, PR CI, merge, and production deploy monitoring per `/do`.
