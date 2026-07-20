# Remove host-header URL derivation

## Problem

SAM backend paths currently derive some externally visible URLs from `Request.url`, which is controlled by the inbound `Host` header at the Worker boundary. For callback, proxy, setup, and webhook-style credentials, this can turn a malicious Host/X-Forwarded-Host value into a trusted-looking URL returned by the API or passed downstream.

The fix must prefer configured deployment origins/domains, preserve existing environment variable names, avoid breaking configured deployments, and keep explicitly documented legacy compatibility for in-flight callback/bootstrap tokens.

## Research Findings

- `apps/api/src/index.ts` builds VM-agent proxy URLs by cloning `c.req.url` and then replacing protocol/host/port. This should not preserve attacker-controlled origin components for security-sensitive routing.
- `apps/api/src/index.ts` strips spoofed `x-forwarded-host` before proxying and injects a trusted value parsed from the validated workspace subdomain. Existing `ws-proxy.test.ts` covers this source contract.
- `apps/api/src/routes/triggers/webhooks.ts` returns webhook credential endpoint URLs using `new URL(requestUrl).origin`, making returned webhook endpoints Host-header-derived.
- `apps/api/src/routes/triggers/crud.ts` uses `buildWebhookCredential(c.req.url, ...)`, so webhook trigger creation has the same Host-derived endpoint issue.
- `apps/api/src/routes/bootstrap.ts` preserves legacy plaintext callback token compatibility; this is explicitly required and already covered by `bootstrap-callback-encryption.test.ts`.
- `.claude/rules/07-env-and-urls.md` and constitution Principle XI require internal URLs, callback URLs, and public URLs to derive from environment/configuration, not hardcoded or request host data.
- `.claude/rules/34-vm-agent-callback-auth.md` requires callback-authenticated VM routes to avoid session-auth middleware leaks; this task must not move callback routes into protected user middleware.

## Checklist

- [x] Create a small URL/origin helper in `apps/api` for trusted API/public origin derivation from existing env/config (`https://api.${BASE_DOMAIN}` in deployed environments, with localhost/dev fallback only where needed).
- [x] Update webhook credential generation to use trusted configured origin instead of `Request.url`.
- [x] Update proxy URL construction to avoid cloning attacker-controlled request origins for VM-agent backend requests.
- [x] Audit remaining apps/api `Request.url`/origin constructions and leave non-security-sensitive path/query parsing intact.
- [x] Add scenario tests for:
  - trusted configured API URL is used;
  - malicious Host/X-Forwarded-Host is ignored for returned credentials/proxy routing;
  - legacy callback token compatibility remains intact.
- [x] Run focused tests, then full quality checks.
- [x] Run security/test/constitution specialist reviews and address findings.
- [ ] Push branch, open PR, wait for CI, and do not merge. (final PR/CI step pending)

## Acceptance Criteria

- Public/callback/setup URL generation in scope does not trust inbound Host or X-Forwarded-Host.
- Existing env var names remain compatible; no required deployment variable rename.
- Legacy plaintext bootstrap callback tokens still redeem.
- Tests cover configured trusted origin, malicious Host/X-Forwarded-Host behavior, and legacy compatibility.
- CI is green.
- PR is open and not merged.

- Focused implementation checks passed: trusted origin/webhook/ws-proxy/bootstrap tests and API typecheck.
- Full local validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Specialist reviews passed: security-auditor, test-engineer, constitution-validator, cloudflare-specialist, and task-completion-validator found no blocking issues.
