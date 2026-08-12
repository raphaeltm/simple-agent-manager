# Cross-Origin Browser Requests Require Automated CORS

## When This Applies

This rule applies when a feature involves the **browser making direct HTTP requests to a third-party origin** — not proxied through the API Worker. Examples: presigned URL uploads to R2/S3, direct calls to external APIs, embedded iframes from other domains. It also applies to same-site sibling origins that execute untrusted content, such as workspace port previews.

## Why This Rule Exists

The R2 file upload feature (PR #554) shipped with working presigned URL generation, passing unit tests, and a functional API — but the feature was completely broken because the R2 bucket had no CORS configuration. The browser silently blocked every upload. See the retained incident lesson in this rule.

## Required Steps

When implementing a browser-to-external-service direct request:

1. **Identify the CORS requirement** — if the browser will make requests to a different origin (different domain, subdomain, or port), CORS must be configured on the target service.

2. **Automate CORS configuration in the deployment pipeline** — CORS rules must be set as part of automated deployment, not documented as a manual step. Manual steps are forgotten; automated steps run every time.

3. **Make CORS configuration idempotent** — the deployment step must be safe to run on every deploy without side effects.

4. **Scope CORS rules tightly** — allow only the specific origin, methods, and headers needed. Never use wildcard `*` for origins when the request carries credentials or sensitive data.

5. **Test the cross-origin request on staging** — unit tests cannot exercise CORS. The staging verification for any cross-origin feature MUST include a real browser making the actual cross-origin request (via Playwright or manual testing). When the task explicitly forbids staging, do not mutate staging; require equivalent runtime-real local boundary tests plus CI evidence and record the explicit exception.

6. **Treat sibling origins as separate trust boundaries** — a host under the same registrable domain is not trusted merely because it is same-site. Parent-domain cookies, credentialed CORS, and WebSocket origin rules can collapse that boundary.

7. **Reject untrusted WebSocket origins before mutation** — origin validation must run before session creation, authentication side effects, runtime allocation, or an upgrader writes the `101` response. Reject literal and wildcard trusted-origin configuration instead of trying to match it.

8. **Filter both directions at every proxy hop** — remove product-owned cookies and query credentials on ingress, and block reserved `Set-Cookie` and cookie-clearing response directives on egress. Preserve application-owned cookies and positively identify product-issued bearer tokens before removing `Authorization`; never blanket-strip application auth.

9. **Use production-real boundary tests** — WebSocket proxy tests must exercise the runtime's real upgrade type (for Workers, `WebSocketPair` and status `101`; for Go, `httptest` plus a real WebSocket dial). Do not add production fallbacks solely to make a test environment accept upgrades.

## Quick Compliance Check

Before committing a feature that involves browser-to-external-service requests:

- [ ] CORS requirement identified and documented
- [ ] CORS configuration automated in deployment pipeline (not manual)
- [ ] CORS rules scoped to specific origin (not wildcard `*`)
- [ ] Same-site sibling origins classified explicitly as trusted or untrusted
- [ ] WebSocket origin rejection happens before authentication or state mutation
- [ ] Credential filtering covers ingress and egress at every proxy hop without removing application auth/cookies
- [ ] Upgrade tests exercise the production runtime boundary
- [ ] Staging verification includes actual browser cross-origin request
