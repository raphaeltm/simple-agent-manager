# Project Runtime Env and Files (Encrypted + Plaintext)

**Status:** in-progress
**Priority:** high
**Estimated Effort:** 2-3 weeks
**Created:** 2026-02-18

## User Story

As a user, I can open a project, store encrypted and unencrypted environment variables/files for that project, and launch a workspace directly from that project so the workspace starts with those env vars/files injected. Encrypted values stay encrypted at rest and are only decrypted just-in-time over HTTPS.

## Preflight Classification

- `cross-component-change`
- `business-logic-change`
- `public-surface-change`
- `docs-sync-change`
- `security-sensitive-change`

## Prior Art and Best Practices

1. GitHub Actions/REST secrets use client-side sealed-box encryption and avoid returning secret values after creation/update.
Sources:
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- https://docs.github.com/en/rest/actions/secrets?apiVersion=2022-11-28#create-or-update-a-repository-secret

2. GitHub Codespaces secret scopes (user/repo/org) and server-side injection at runtime demonstrate project/repo-scoped secret delivery.
Source:
- https://docs.github.com/en/codespaces/managing-your-codespaces/managing-encrypted-secrets-for-your-codespaces

3. GitLab CI/CD variables support both variable and file types, masking, and encrypted-at-rest storage for sensitive values.
Source:
- https://docs.gitlab.com/ci/variables/

4. Kubernetes/AWS/OWASP all converge on: encryption at rest, least privilege, short-lived retrieval, auditability, and no secret leakage in logs.
Sources:
- https://kubernetes.io/docs/concepts/security/secrets-good-practices/
- https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html
- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html

## How This Applies to SAM

1. Keep SAM’s current AES-GCM at-rest model (`ENCRYPTION_KEY`) and per-record IV behavior for encrypted project values.
2. Never include decrypted secret values in list responses; return metadata + flags (`isSecret`, `hasValue`) for secret entries.
3. Decrypt secrets only at workspace provisioning/injection time via callback-authenticated HTTPS control-plane endpoint.
4. Avoid sending decrypted secrets across existing node-management HTTP path (`api -> vm-*`) by using vm-agent pull over `https://api.${BASE_DOMAIN}`.
5. Keep all new limits configurable via env vars (Principle XI).

## Architecture and Impact Map

### API / Database

- Add project-scoped runtime config tables for env vars and files.
- Add `projectId` linkage on workspaces for provenance and runtime lookup.
- Add authenticated project runtime config CRUD endpoints.
- Add callback-authenticated workspace runtime payload endpoint that returns decrypted values only to the VM agent.
- Extend workspace create flow to support direct project launch (`projectId`) without re-entering repo/install metadata.

### VM Agent

- Fetch project runtime payload during provision/recovery using existing callback-token pattern.
- Inject env vars into workspace runtime shell environment.
- Materialize file entries into the workspace directory with path validation to prevent traversal.

### Web UI

- Project detail page: manage env vars/files (plain + secret).
- Project detail page: one-click workspace launch from project context.

### Shared Contracts

- Add typed request/response contracts for project runtime config and project-launched workspace creation.

## Security Requirements

- Secret values encrypted at rest in D1.
- Secret values never returned in GET list/read APIs.
- Secret values decrypted only in callback-authenticated runtime payload endpoint.
- Runtime payload endpoint requires workspace callback token and ownership alignment.
- Do not log secrets; redact or avoid value fields in error paths/logging.

## Implementation Plan

1. Schema + migrations: project runtime env/file tables, workspace `project_id` link.
2. Shared types + API contracts for runtime config and project launch.
3. API routes:
- Project runtime config CRUD.
- Workspace callback endpoint for runtime payload.
- Workspace create support for `projectId`.
4. VM agent:
- Runtime payload fetch client.
- Env/file injection pipeline with path/key validation.
5. Web:
- Project page runtime config editor and launch action.
6. Docs sync (same PR): `AGENTS.md`, `CLAUDE.md`, architecture docs, relevant guides.

## Testing Plan

### API (Vitest)

- Unit tests for runtime limits/env var parsing.
- Route tests for project runtime CRUD auth, validation, masking semantics, and encrypted storage behavior.
- Route tests for workspace project launch behavior and callback runtime payload auth.

### VM Agent (Go tests)

- Unit tests for runtime payload fetch and error handling.
- Unit tests for env injection script generation and key validation.
- Unit tests for file path sanitization and file injection behavior.
- Provisioning tests verifying payload fetch + state propagation.

### Web (Vitest + RTL)

- Project page tests for runtime config form behavior, secret masking, and launch action payload.

### Validation Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `go test ./...` (packages/vm-agent)

## Constitution (Principle XI) Checklist

- [ ] No hardcoded internal URLs; derive from `BASE_DOMAIN` patterns.
- [ ] New limits configurable with defaults + env overrides.
- [ ] No hardcoded secret policy constants without override when they are operational.
- [ ] No hardcoded deployment identifiers.

## Completion Checklist

- [ ] Project runtime env/file CRUD implemented
- [ ] Encrypted-at-rest + masked-read semantics implemented
- [ ] Workspace launch-from-project implemented
- [ ] VM injection path implemented (HTTPS callback payload)
- [ ] Unit/integration tests added and passing
- [ ] Documentation synchronized in same PR
- [ ] PR opened with preflight evidence and security notes
