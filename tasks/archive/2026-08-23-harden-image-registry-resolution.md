# Harden deployment image registry resolution

## Problem statement

Authenticated deployment-release callers can submit image registry, repository,
and tag values that are resolved by the Worker through OCI registry HEAD/GET
requests and registry-controlled bearer-token realms. HTTPS and SAM credential
host scoping exist, but outbound destinations and aggregate resolver work are
not sufficiently bounded. A malicious manifest can make the Worker probe
private/link-local/control-plane HTTPS endpoints, pivot through bearer realms or
redirects, and amplify work across many services.

The fix must be narrowly scoped and compatibility-preserving: keep Docker Hub,
valid public registries, SAM-managed registries, existing Basic/Bearer flows,
and already digest-pinned manifests working; do not change public routes or
request/response contracts.

## Research findings

- `apps/api/src/services/image-resolver.ts` builds the core digest-resolution
  flow, and `apps/api/src/services/image-resolver-outbound.ts` owns outbound
  URL/authority validation, redirect handling, request timeout, response-size,
  total-attempt, and total-budget enforcement.
- `apps/api/src/routes/deployment-release-image-resolver.ts` pre-processes raw
  JSON manifests and skips network work when all images are already digest
  pinned. This path should also enforce a maximum count of tag-based image
  resolutions before constructing a resolver.
- `apps/api/src/routes/deployment-releases.ts` resolves Compose YAML through
  `packages/shared/src/compose-parser/resolve.ts`. The API route can pre-count
  unresolved Compose image references and construct a resolver with the same
  env-configured budget without changing the shared public contract.
- `packages/shared/src/compose-parser/resolve.ts` intentionally leaves
  digest-pinned images unchanged and calls the injected resolver only for
  mutable references. Preserve that behavior.
- Existing tests in `apps/api/tests/unit/image-resolver.test.ts` cover positive
  public registry, Docker Hub, Basic auth, Bearer challenge, GET fallback, and
  current auth-host scoping. Existing release-path tests in
  `apps/api/tests/unit/services/release-tag-resolution.test.ts` exercise real
  resolver behavior through release manifest rewriting.
- Retained lessons from `.claude/rules/28-credential-resolution-fallback-tests.md`
  require behavioral credential-boundary tests, not source-string checks. The
  existing credential non-forwarding tests are relevant and should be expanded
  around redirects/token realms.
- Retained unbounded HTTP lesson from
  `tasks/archive/2026-04-10-vm-agent-data-races-shell-injection-auth-bugs.md`
  supports using explicit, configurable timeouts rather than default clients or
  implicit platform behavior.

## Implementation checklist

- [x] Add resolver configuration defaults with env overrides for request
  timeout, total resolution budget, max fetch attempts, max redirects, max
  concurrent fetches, max token response bytes, and max tag-based services.
- [x] Validate every outbound registry, bearer-realm, and redirect URL before
  fetch: HTTPS only; no userinfo; no control characters; no trailing-dot/raw-IDN
  ambiguity; no localhost, metadata, `.local`/`.internal`, private/link-local,
  loopback, multicast, or reserved IPv4/IPv6 authorities.
- [x] Disable automatic fetch redirects and manually follow only bounded,
  validated HTTPS redirects. Preserve auth scoping by stripping Authorization
  on cross-origin redirects.
- [x] Preserve exact auth-host scoping and Docker Hub hostname rewrite behavior.
- [x] Enforce tag-resolution service-count limits in both JSON and Compose YAML
  release submission paths without touching already digest-pinned manifests.
- [x] Add adversarial tests for attacker/private hosts, IPv4/IPv6 encoded
  private forms, userinfo, trailing-dot/case/IDN ambiguity, redirects,
  token-realm pivots, credential non-forwarding, many-service amplification,
  timeout/abort, oversized token responses, and fetch-attempt budgets.
- [x] Re-run affected API/shared tests, full API/shared suites, `check:fast`,
      dependency/security gates, and specialist reviews locally. PR evidence
      checkers and CI are completed after opening the required non-draft PR.

## Acceptance criteria

- Registry, bearer realm, and redirect outbound requests fail closed for unsafe
  authorities before `fetch()` reaches them.
- Resolver work is bounded by configurable env/defaults for service count,
  fetch attempts, redirects, per-request timeout, total budget, response size,
  and concurrent fetches.
- Docker Hub, valid public registries, SAM-managed registries, Basic auth,
  Bearer auth, GET fallback, and digest-pinned manifest submissions remain
  compatible.
- Tests are behavioral and exercise the real resolver/release preprocessor
  rather than source-string assertions.
- Exactly one non-draft PR is opened against `main`; staging is not deployed and
  the PR is not merged.

## References

- `apps/api/src/services/image-resolver.ts`
- `apps/api/src/services/image-resolver-outbound.ts`
- `apps/api/src/routes/deployment-release-image-resolver.ts`
- `apps/api/src/routes/deployment-releases.ts`
- `packages/shared/src/compose-parser/resolve.ts`
- `apps/api/tests/unit/image-resolver.test.ts`
- `apps/api/tests/unit/services/release-tag-resolution.test.ts`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
