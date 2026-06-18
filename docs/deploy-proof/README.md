# App-Deployment Staging Proof (PR #1312 / #1313)

Live, end-to-end proof that the SAM agent-first app-deployment chain works on
staging (`sammy.party`): **release → auto-provision deploy node → fetch signed
apply payload → docker compose apply → Caddy serve with Let's Encrypt TLS →
redeploy (port rebind)**.

All steps were driven in-session against the live staging API and verified in a
real browser (Playwright / HeadlessChrome 147) and via `curl`/`openssl`.

## Environment under test

| Field | Value |
| --- | --- |
| Project | `01KJVGMWX26SGQ5DX94GMTJRQN` (Test Project 2) |
| Deployment environment | `01KVBZRA9EYA349TVZ2FQQ6QMM` |
| Auto-provisioned deploy node | `01KVBZXHRXB5QD5KMWVRYV5EEC` (`deploy-01kvbzra`, role `deployment`, Hetzner fsn1) |
| Node IP | `167.233.126.79` |
| Public route hostname | `r1-web-80-01kvbzra9eya349tvz2fqq6qmm.apps.sammy.party` |
| Image (digest-pinned) | `docker.io/traefik/whoami@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab` |

## What was proven

1. **First release auto-provisions a deploy node.** Submitting release **v1**
   (`01KVBZXH8B6BVP7C458Y0GDAAB`) to an environment with no node triggered
   `provisionDeploymentNode` → a fresh Hetzner deployment node booted, the
   vm-agent registered, and its first heartbeat arrived ~2.5 min later.
2. **Grey-cloud DNS A record** `r1-web-80-…apps.sammy.party → 167.233.126.79`
   was created by the deploy-release callback.
3. **Signed apply payload fetched + applied.** The node fetched the release via
   `GET /api/nodes/:id/deploy-release?seq=1` (Ed25519-signed `ApplyPayload`),
   ran `docker compose`, and the whoami container came up.
4. **Caddy serves with valid TLS.** `https://…/` returns **200**, `ssl_verify=0`
   (valid chain), responses carry `Via: 2.0 Caddy` and `X-Forwarded-Proto: https`.
5. **Genuine Let's Encrypt PRODUCTION certificate** — issuer `CN = YE1`
   (LE prod intermediate), subject + SAN = the route hostname, TLS 1.3. A clean
   browser padlock results.
6. **HTTP → HTTPS auto-redirect** returns **308**.
7. **T1 redeploy port rebind.** Submitting release **v2**
   (`01KVC0N3A30HVATJ9E46TMP3BQ`) to the SAME node redeployed in place: the
   serving container changed (`c0f103e422fb` → `fe56b59e75bd`) while the same
   route/host-port kept serving HTTPS 200. The new container correctly rebound
   the host port — the T1 fix.

## TLS certificate (openssl)

```
issuer=C = US, O = Let's Encrypt, CN = YE1
subject=CN = r1-web-80-01kvbzra9eya349tvz2fqq6qmm.apps.sammy.party
notBefore=Jun 17 22:56:05 2026 GMT
notAfter=Sep 15 22:56:04 2026 GMT
X509v3 Subject Alternative Name:
    DNS:r1-web-80-01kvbzra9eya349tvz2fqq6qmm.apps.sammy.party
```

Browser engine (Playwright `response.securityDetails()`): TLS 1.3, issuer `YE1`,
subjectName = route hostname, `window.isSecureContext === true`,
`location.protocol === "https:"`.

## Screenshots

| Release | Container | Desktop (1280×800) | Mobile (375×667) |
| --- | --- | --- | --- |
| v1 (initial deploy) | `c0f103e422fb` | `whoami-live-desktop.png` | `whoami-live-mobile.png` |
| v2 (T1 redeploy)    | `fe56b59e75bd` | `whoami-redeploy-desktop.png` | `whoami-redeploy-mobile.png` |

The redeploy screenshots show `Hostname: fe56b59e75bd`, `Via: 2.0 Caddy`,
`X-Forwarded-Proto: https`, served to a real HeadlessChrome/147 client.

## Notes / findings for review (NOT blockers)

- **`deployment_releases.status` never transitions to `applied`.** It is written
  `created` at submission and no code path updates it; the deploy-release GET
  callback is read-only. The authoritative "applied" signal is the node's
  `appliedSeq` echoed in the heartbeat (control plane returns `pendingReleaseSeq`
  only when `latestVersion > appliedSeq`). So `status='created'` post-apply is
  expected — a pre-existing **observability gap**, not a functional break. Both
  v1 and v2 show `created` while the live site serves v2's container.
- **Cross-registry credential forwarding breaks public Docker Hub tag→digest
  resolution on credential-configured deployments.** On staging
  (`CF_ACCOUNT_ID`/`CF_API_TOKEN` set), `resolveManifestImageTags` mints
  best-effort PULL creds for the CF registry, then the `ImageResolver` forwards
  those CF creds to Docker Hub's token endpoint (the realm-trust check passes —
  `registry-1.docker.io` and `auth.docker.io` share the `docker.io` parent), and
  Docker Hub rejects them `401` → public tag resolution fails
  (`IMAGE_RESOLVE_FAILED`). Worked around here by pinning the digest directly
  (the resolver is skipped for already-pinned images). Recommend: only forward
  minted creds to the registry host they were minted for.

## Reproduction (in-session, no Docker required)

Public images can be deployed without a local container runtime by pinning the
digest (resolve it anonymously against Docker Hub, then submit a digest-pinned
manifest). T2 (private-registry `docker login`) is **not** browser-provable here
(no container runtime in the workspace) and remains CI-covered.
