# Compose-publish `x-sam-routes` override support

## Problem statement

The deployment docs and MCP deployment guide say SAM derives public app routes from either top-level `x-sam-routes` or Compose service `ports:`. That is true for the normalized YAML release endpoint, where `parseCompose()` turns `x-sam-routes` into `manifest.routes` and falls back to `ports:`/`expose:` route hints.

The agent-first `build_and_publish` path records a compose-publish release instead. Its apply transform currently derives public route targets only from service `ports:`. As a result, `x-sam-routes` in a Compose file submitted through `build_and_publish` is ignored, and `mode: private` cannot suppress automatic exposure of a matching `ports:` entry.

Desired product behavior:

- `ports:` remains the normal happy path for public routes.
- `x-sam-routes` is an optional explicit override layer.
- `expose:` and Dockerfile `EXPOSE` do not become public routes.

## Research findings

- `packages/shared/src/compose-parser/parse-fields.ts` already implements the intended route semantics for normalized Compose parsing:
  - parse top-level `x-sam-routes` first
  - default route `mode` to `public`
  - validate `service`, `port`, and `mode`
  - add `expose:` as private route hints only when no explicit service/port route exists
  - add `ports:` as public route hints only when no explicit service/port route exists
- `apps/api/src/services/compose-publish-apply.ts` handles compose-publish releases and currently collects public routes only from `service.ports`, then rewrites those ports to `127.0.0.1:{hostPort}:{containerPort}`.
- `apps/api/src/services/deployment-routing.ts` provides shared `assignRouteTargets()` used by both manifest and compose-publish apply paths. It should stay the single source for hostnames and loopback host ports.
- `apps/api/src/routes/deploy-release-callback.ts` signs the rendered Compose YAML and route targets together, upserts SAM-owned DNS records for public routes, and appends verified custom domains after public route derivation.
- `tasks/archive/2026-06-11-compose-subset-parser.md` records the intended `x-sam-routes` + route-hint behavior for normalized Compose.
- `tasks/archive/2026-06-24-custom-domains-deployment-public-routes.md` depends on compose-publish route targets matching the signed payload and Caddy route target contract.
- Public docs in `apps/www/src/content/docs/docs/guides/app-deployments.md` and MCP guide text in `apps/api/src/routes/mcp/deployment-guide-tools.ts` already describe both `x-sam-routes` and `ports:` but should be clarified so users understand `ports:` is the default and `x-sam-routes` is advanced/override behavior.

## Implementation checklist

- [ ] Add a shared helper inside `compose-publish-apply.ts` that parses top-level `x-sam-routes` from the captured compose document and returns explicit route definitions with structured validation errors.
- [ ] Update compose-publish public route collection so explicit `x-sam-routes` entries take precedence over `ports:` hints for the same `service` + `port`.
- [ ] Ensure `mode: private` suppresses public exposure for the same `service` + `port` even when the service has `ports:`.
- [ ] Ensure `x-sam-routes` `mode: public` can publish a route even if the service has no `ports:` entry by injecting the loopback binding into the rendered Compose output.
- [ ] Preserve current `ports:` happy-path behavior, including route order, loopback rewrite, artifact/provider handling, and deterministic hostname/hostPort assignment.
- [ ] Add focused regression tests in `apps/api/tests/unit/services/compose-publish-apply.test.ts`:
  - [ ] `ports:` alone still creates a public route and loopback binding.
  - [ ] `x-sam-routes` public without `ports:` creates a route and loopback binding.
  - [ ] `x-sam-routes` private plus matching `ports:` suppresses the public route and removes the service `ports:` entry.
  - [ ] explicit public route plus matching `ports:` does not duplicate.
  - [ ] invalid route mode/service/port fails with an actionable compose-publish error.
- [ ] Add/update route-target reconstruction tests in `apps/api/tests/unit/services/deployment-routing.test.ts` so stale DNS/custom-domain consumers also honor stored compose-publish `x-sam-routes`.
- [ ] Clarify docs/tool guide wording: use `ports:` for normal public routes; use `x-sam-routes` for explicit public routes without `ports:` or to mark a matching port private.
- [ ] Run focused tests, typecheck/lint, full quality suite, specialist review, staging verification, PR, CI, merge, and production deploy monitoring per `/do`.

## Acceptance criteria

- [ ] Agent-first `build_and_publish` releases support the same route precedence as normalized Compose releases for public/private `x-sam-routes` versus `ports:` hints.
- [ ] A service with `ports:` and no explicit route still exposes a public app route.
- [ ] A service with `x-sam-routes: [{ service, port, mode: public }]` and no `ports:` still exposes a public app route.
- [ ] A service with matching `ports:` and `x-sam-routes: [{ service, port, mode: private }]` is not publicly exposed.
- [ ] Duplicate explicit/public and `ports:` hints for the same service/port do not create duplicate route targets or duplicate loopback bindings.
- [ ] Invalid `x-sam-routes` entries in compose-publish releases fail before apply with clear error messages.
- [ ] Public docs and the MCP deployment guide match the implemented behavior.
- [ ] Local tests and staging verification prove the route behavior before merge.

## References

- `/do` request in SAM task `01KVX9RHY1VSD02QFAXG1ECXZN`
- `apps/api/src/services/compose-publish-apply.ts`
- `apps/api/src/services/deployment-routing.ts`
- `packages/shared/src/compose-parser/parse-fields.ts`
- `apps/api/tests/unit/services/compose-publish-apply.test.ts`
- `apps/api/tests/unit/services/deployment-routing.test.ts`
- `apps/www/src/content/docs/docs/guides/app-deployments.md`
- `apps/api/src/routes/mcp/deployment-guide-tools.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/03-constitution.md`
- `.claude/rules/35-vertical-slice-testing.md`
