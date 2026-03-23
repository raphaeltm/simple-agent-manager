# Split ENCRYPTION_KEY into 3 Separate Secrets

## Problem

`ENCRYPTION_KEY` is dual-used across three distinct security domains:
1. **BetterAuth session secret** (`apps/api/src/auth.ts:80`) — session integrity
2. **AES-GCM credential encryption** (`apps/api/src/services/encryption.ts` via many callers) — user cloud token confidentiality
3. **GitHub webhook HMAC verification** (`apps/api/src/routes/github.ts:208`) — webhook authenticity

Compromise of one role compromises all three. BetterAuth may expose derived material in cookie headers, widening the attack surface for the AES key.

## Research Findings

### Usage Sites (ENCRYPTION_KEY)

**BetterAuth session secret** (1 site):
- `apps/api/src/auth.ts:80` — `secret: env.ENCRYPTION_KEY`

**Credential encryption** (many sites, all call `encrypt()`/`decrypt()` from `services/encryption.ts`):
- `apps/api/src/services/nodes.ts` (3 calls via `createProviderForUser`)
- `apps/api/src/routes/credentials.ts` (3 calls)
- `apps/api/src/routes/bootstrap.ts` (2 calls)
- `apps/api/src/routes/gcp.ts` (2 calls)
- `apps/api/src/routes/providers.ts` (1 call)
- `apps/api/src/routes/workspaces/runtime.ts` (4 calls)
- `apps/api/src/routes/projects/crud.ts` (2 calls)
- `apps/api/src/durable-objects/task-runner.ts:62` — `ENCRYPTION_KEY: string` in `TaskRunnerEnv`

**Webhook HMAC** (1 site):
- `apps/api/src/routes/github.ts:208` — `const webhookSecret = c.env.ENCRYPTION_KEY`

### Configuration/Deployment Files
- `apps/api/src/index.ts:83` — `Env` interface, `ENCRYPTION_KEY: string` (required)
- `apps/api/.env.example:20` — documented as "encrypt user-provided credentials"
- `scripts/deploy/configure-secrets.sh:87` — sets `ENCRYPTION_KEY` as required secret
- `docs/` — 7 doc files reference ENCRYPTION_KEY

### Test Files (12 files)
All test files set `ENCRYPTION_KEY` in mock env bindings.

## Implementation Checklist

- [ ] 1. Add `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET` as optional fields to `Env` interface in `apps/api/src/index.ts`
- [ ] 2. Add same optional fields to `TaskRunnerEnv` in `apps/api/src/durable-objects/task-runner.ts` (for `CREDENTIAL_ENCRYPTION_KEY`)
- [ ] 3. Update `apps/api/src/auth.ts:80` to use `env.BETTER_AUTH_SECRET ?? env.ENCRYPTION_KEY`
- [ ] 4. Update `apps/api/src/routes/github.ts:208` to use `env.GITHUB_WEBHOOK_SECRET ?? env.ENCRYPTION_KEY`
- [ ] 5. Create a helper function (e.g., `getCredentialEncryptionKey(env)`) to centralize `env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY` pattern, update all credential encryption call sites
- [ ] 6. Update `apps/api/.env.example` — add the 3 new secrets with documentation
- [ ] 7. Update `scripts/deploy/configure-secrets.sh` — add optional secret configuration for new keys
- [ ] 8. Update documentation (`docs/architecture/secrets-taxonomy.md`, `docs/guides/self-hosting.md`, `docs/architecture/credential-security.md`)
- [ ] 9. Add unit tests verifying fallback behavior (new secret used when present, falls back to ENCRYPTION_KEY)
- [ ] 10. Update test fixtures to exercise both paths

## Acceptance Criteria

- [ ] When `BETTER_AUTH_SECRET` is set, BetterAuth uses it; when unset, falls back to `ENCRYPTION_KEY`
- [ ] When `CREDENTIAL_ENCRYPTION_KEY` is set, all encrypt/decrypt calls use it; when unset, falls back to `ENCRYPTION_KEY`
- [ ] When `GITHUB_WEBHOOK_SECRET` is set, webhook verification uses it; when unset, falls back to `ENCRYPTION_KEY`
- [ ] Existing deployments with only `ENCRYPTION_KEY` continue to work without changes
- [ ] New secrets are documented in `.env.example`, deployment scripts, and architecture docs
- [ ] Tests cover both the new-secret and fallback paths

## References

- `apps/api/src/auth.ts`
- `apps/api/src/services/encryption.ts`
- `apps/api/src/routes/github.ts`
- `scripts/deploy/configure-secrets.sh`
- `apps/api/.env.example`
- `docs/architecture/secrets-taxonomy.md`
