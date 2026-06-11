# Deployment Environment Secrets

**Created:** 2026-06-11
**Status:** backlog

## Problem Statement

The app-deployment feature (slice 2) needs environment-scoped secrets so real apps can reference sensitive values (DB URLs, API keys) without embedding them in manifests. The compose renderer currently rejects `{ "secret": "name" }` references. This task lifts that limitation by adding:
- Encrypted secret storage (D1)
- Write-only API (set/overwrite/delete/list names)
- Render-time secret injection in the compose renderer
- Minimal UI for managing secrets per environment

## Research Findings

### Existing Infrastructure
- **Encryption:** `apps/api/src/services/encryption.ts` — AES-256-GCM via Web Crypto. Functions: `encrypt(plaintext, keyBase64)`, `decrypt(ciphertext, iv, keyBase64)`. Key from `ENCRYPTION_KEY` env var (with purpose-specific overrides like `CREDENTIAL_ENCRYPTION_KEY`).
- **Manifest schema:** `packages/shared/src/deployment-manifest/schema.ts` — `SecretRef = { secret: string }`, `EnvValue = string | SecretRef`. SECRET_NAME_RE = `/^[a-zA-Z0-9_-]{1,128}$/`.
- **Compose renderer:** `apps/api/src/services/compose-renderer.ts` — builds Compose doc as object then `stringify(doc)`. Line 65-73: only handles literal strings, secret refs rejected at validation.
- **Release validation:** `apps/api/src/routes/deployment-releases.ts:32-57` — `validateSlice2Constraints()` rejects `{ secret: ... }` env values.
- **Environment routes:** `apps/api/src/routes/deployment-environments.ts` — CRUD under `/api/projects/:projectId/environments`. Auth: `requireAuth()` + `requireApproved()` + `requireOwnedProject()`.
- **Latest migration:** `0067_deployment_environments.sql`. Next: `0068`.
- **Web UI:** No deployment environment UI exists yet (only GCP OIDC setup in `DeploymentSettings.tsx`).
- **API client:** `apps/web/src/lib/api/deployment.ts` — GCP-only, no environment endpoints.

### Design Decisions (from doc 07)
- **Storage:** environment-scoped, encrypted at rest with platform ENCRYPTION_KEY
- **Write-only:** set, overwrite, delete, list names only — never return values
- **Injection:** at render time, resolve secret refs and return resolved env separately (values never persisted in release record)
- **Rotation:** updating a secret marks environments "stale config"
- **Audit:** store referenced secret NAMES only, never values

## Implementation Checklist

### 1. D1 Migration (0068)
- [ ] Create `deployment_secrets` table: `id`, `environment_id` (FK → deployment_environments, CASCADE), `name`, `encrypted_value`, `iv`, `created_at`, `updated_at`
- [ ] Add unique index on `(environment_id, name)`
- [ ] Add index on `environment_id`
- [ ] Add `secrets_updated_at` column to `deployment_environments` table (for stale config detection)

### 2. Drizzle Schema
- [ ] Add `deploymentSecrets` table definition to `apps/api/src/db/schema.ts`
- [ ] Add `secretsUpdatedAt` column to `deploymentEnvironments`
- [ ] Export row types

### 3. API Routes — Secret Management
- [ ] Create `apps/api/src/routes/deployment-secrets.ts`
- [ ] `PUT /:projectId/environments/:envId/secrets/:name` — set/overwrite a secret (encrypt value, upsert row)
- [ ] `DELETE /:projectId/environments/:envId/secrets/:name` — delete a secret
- [ ] `GET /:projectId/environments/:envId/secrets` — list secret names only (never values)
- [ ] Auth: `requireAuth()` + `requireApproved()` + `requireOwnedProject()` per route (not wildcard middleware)
- [ ] Post-query ownership check: verify environment belongs to project
- [ ] On set/delete: update `secrets_updated_at` on the environment row
- [ ] Register route in `apps/api/src/index.ts`

### 4. Compose Renderer — Secret Resolution
- [ ] Add `resolvedSecrets?: Record<string, string>` to `ComposeRenderContext`
- [ ] Update renderer to resolve `{ secret: "name" }` refs using provided secrets map
- [ ] If a secret name is missing from the map, throw a loud validation error listing all missing names
- [ ] Return type change: `{ composeYaml: string; resolvedEnv: Record<string, string> }` — the compose YAML has env_file-style delivery, resolved env returned separately
- [ ] Actually, simpler approach: inject resolved values directly into the environment block of the compose document (they need to reach the container). The key constraint is that the release record in D1 never stores secret values.

### 5. Release Route — Wire Up Secrets
- [ ] Remove the "reject secret references" block from `validateSlice2Constraints()`
- [ ] In the compose render endpoint, load secrets for the environment, decrypt them, and pass to renderer
- [ ] Ensure the stored release manifest still contains `{ "secret": "name" }` refs (not resolved values)
- [ ] The `/compose` endpoint resolves at render time

### 6. No-Value-Leakage Regression Tests
- [ ] Test: release record stored in D1 contains `{ "secret": "name" }` not decrypted values
- [ ] Test: list-secrets endpoint returns names only, no values
- [ ] Test: rendered compose from the API never stores resolved values in D1

### 7. Behavioral Tests
- [ ] Write-only API: PUT secret, then GET list → name appears, no value
- [ ] Encryption round-trip: encrypt then decrypt → same value
- [ ] Renderer with present secrets: resolves `{ secret: "name" }` to actual value in compose output
- [ ] Renderer with missing secrets: throws validation error listing missing names
- [ ] Delete secret: removes from list, render fails if still referenced
- [ ] Stale config: setting/deleting secret updates `secrets_updated_at`

### 8. Web UI
- [ ] Add API client functions in `apps/web/src/lib/api/deployment.ts`: list secrets, set secret, delete secret
- [ ] Create `EnvironmentSecretsSection` component: displays secret names, add/overwrite form, delete button
- [ ] Integrate into project deployment environment surface
- [ ] Playwright visual audit at mobile (375px) and desktop (1280px) with stress-test data

## Acceptance Criteria

- [ ] Secrets are stored encrypted at rest (AES-256-GCM)
- [ ] API never returns secret values (write-only semantics)
- [ ] Compose renderer resolves `{ "secret": "name" }` references at render time
- [ ] Missing secret name causes a loud validation error (fail fast)
- [ ] Release records in D1 contain secret references (names), not values
- [ ] Updating/deleting a secret updates `secrets_updated_at` on the environment
- [ ] UI allows managing secret names (add/overwrite/delete) per environment
- [ ] All behavioral tests pass
- [ ] No secret values appear in logs, audit records, or stored Compose
