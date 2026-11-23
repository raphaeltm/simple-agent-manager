# Self-host: SAM-signed object uploads through the box (no cloud storage keys)

SAM task `01M83T07FR9ZFXEPJQXA90HE14`, idea `01M828EKSVADDDZF7VXA5HPKK5`. Self-hosting only; hosted
SAM keeps direct R2 presigned URLs byte-identical.

## Problem

Build-backed app deploys (compose image artifacts, build contexts) and task attachments hand the
client an S3 presigned URL (`services/r2-s3-client.ts:getR2PresignTarget`). A box can presign only
with `R2_S3_ENDPOINT` plus a prefix-scoped static HMAC key. A GCS box in an org that refuses HMAC
keys cannot get one, so `compose-image-artifacts/init` 500s ("R2 S3 credentials not configured",
a plain `Error`) and attachments answer 403. Raphaël's decision (2026-11-23, ask
`01M828MCP6C88CC5PDBKC824QB`): no GCP-specific signing. The Worker issues a short-lived SAM-signed
token, and the client PUTs or GETs through the box, which streams the body into `env.R2` (celld's
R2 interface).

## Phase 1 proof (done 2026-11-23, local celld v0.6.3 + MinIO, `CELLD_V8_HEAP_LIMIT_MB=128`)

| case                                          | result                                          | celld RSS peak (idle 43 MB) | MB/s |
| --------------------------------------------- | ----------------------------------------------- | --------------------------- | ---- |
| `R2.put(request.body)` 256 MB                 | 200, sha matches on download                    | 145 MB                      | 101  |
| `R2.put(request.body)` 1023 MB                | 200, sha matches                                | 220 MB                      | 132  |
| R2 multipart, 16 MB parts, 1023 MB            | 200                                             | 308 MB                      | 169  |
| put 1000 MB through the box Caddy image       | 200 (Caddy 22 MiB)                              | 237 MB                      | 143  |
| 1000 MB at 5 MB/s (200 s); via Caddy 10 MB/s  | 200; no handler-budget cut                      | -                           | -    |
| client aborts after 3 s                       | no partial object (GET 404)                     | -                           | -    |
| body over 1 GiB                               | 413 `request body too large` (celld)            | -                           | -    |
| `CELLD_MAX_REQUEST_BODY_BYTES` above 1 GiB    | celld refuses to start (`cannot exceed 1073741824`) | -                       | -    |
| put with `onlyIf: {etagDoesNotMatch: '*'}` x2 | first writes, second returns null (write-once)  | -                           | -    |
| put with a wrong `sha256`                     | rejected                                        | -                           | -    |

The body never sits in the isolate heap and RSS stays far below the body size, so streaming works.
**Hard limit:** one request through celld carries at most 1 GiB. Larger compose artifacts need a
parted upload, which changes the vm-agent client. Deferred to PR B (idea filed in this PR).

## Design (PR A)

```
 uploader ─(1) init (existing authenticated route)─► Worker: mint token {op, key, max, ct, sha?, exp}
 uploader ─(2) PUT/GET https://api.<domain>/api/self-host/objects?token=…─► Caddy ─► celld Worker
 Worker ─(3) verify token → R2.put(key, body, {onlyIf: write-once, sha256?}) / R2.get(key) stream
```

- One URL-signing seam (`ObjectUrlSigner`): S3 presign (current code, unchanged bytes) or the box
  signer. The box signer is installed only by the self-host build (`selfhost/build.ts`), so the
  Cloudflare bundle cannot reach it. A box that still has a static key keeps direct presign.
- Token in the query string: the browser, vm-agent and builder clients PUT/GET opaque URLs, so no
  client changes and no rollout coupling. Caddy never logs query strings; SAM's request log records
  only the pathname.
- Key: HKDF-SHA256 from `ENCRYPTION_KEY` with its own label (the hosted-git token pattern, shared
  helper). It rotates with `selfhost:secrets rotate`; `ENCRYPTION_KEY_PREVIOUS` verifies during the
  overlap. No operator input, no new secret.

## Threat model

| Threat | Control | Test |
| --- | --- | --- |
| Forged token | HMAC-SHA256 over prefix+payload, constant-time verify, purpose-labelled HKDF key (a hosted-git token is not an object token) | tampered payload, wrong label, wrong key → 403, nothing written |
| Replay of an upload token | TTL = caller's existing presign TTL (≤ 15 min default); write-once put (`etagDoesNotMatch: '*'`); a retry after success answers 200 only when the stored object matches the token's size (and sha256 when bound) | second PUT with different bytes → 412, object unchanged; same bytes → 200 |
| Scope escape (other key/prefix, traversal) | the key lives only inside the signed payload; no path or query parameter names a key; key validated with the same unsafe-segment check as presign | extra `key=` param ignored; `..` key refused at mint |
| Method confusion | `op` claim: a GET token cannot PUT and vice versa | cross-op → 403 |
| Size DoS | `Content-Length` required and ≤ token `max` ≤ 1 GiB (celld cap); body wrapped in `FixedLengthStream`; celld refuses > 1 GiB before the Worker runs | over-max → 413 without a write; short body → no object |
| Integrity | build-context sha256 bound into the token and checked by `R2.put({sha256})`; compose artifacts keep size validation at completion | wrong bytes → 400/412 |
| Cross-user / cross-project writes | the token is minted only by the existing authenticated init routes (session auth for attachments, callback JWT + project policy for compose/build-context), which derive the key from the caller's verified identity; claims carry the user/project/workspace for audit logs | attack: user A's token cannot write user B's key; owner control writes its own key |
| Token leakage in logs | query string; Caddy logs no query; request log is pathname-only; tokens are never logged by the route | log assertion in route test |
| Egress fence / celld isolation | the route runs inside celld's Worker and talks only to the R2 binding (celld's bucket): no outbound fetch, nothing the egress fence must allow | n/a |

## Checklist

- [ ] Shared signed-token helper extracted from `selfhost/hosted-git/tokens.ts` (rule 59: extend, not fork); hosted-git tests unchanged and green
- [ ] Object URL token mint/verify (`selfhost/object-urls/tokens.ts`)
- [ ] Box route `PUT|GET /api/self-host/objects` (write-once put, sha256, size cap, FixedLengthStream, streaming GET)
- [ ] `ObjectUrlSigner` seam: app-deployment compose + build-context take a signer; attachments use it
- [ ] `getR2ObjectUrlSigner(env)`: presign when configured, else installed box signer, else `AppError` 503 naming the settings
- [ ] Attachments `request-upload` availability uses the same resolver (403 → works on box)
- [ ] Compose `maxBytes` clamped to the box limit so the agent fails before uploading
- [ ] Rule 74 tests: Cloudflare Env → presign; box Env (no key) → box route; box with key → presign
- [ ] Cloudflare byte-identity test still green (`r2-presign-cloudflare-equivalence.test.ts`)
- [ ] Self-host-only module test: Cloudflare bundle does not import the box signer
- [ ] Docs: `deploy/selfhost/README.md` "Object store and presigned uploads"; static key optional
- [ ] Idea for PR B (parted uploads > 1 GiB)
- [ ] Live celld test of the route (`scripts/selfhost/live`), small body + over-cap
- [ ] Disposable GCS box proof, no HMAC key: publish → release → app 200; attachment up/down; snapshot
- [ ] Staging: hosted attachments + compose publish still work

## Acceptance criteria

- A GCS box without an HMAC key: compose publish, task attachment upload/download and a session
  snapshot all work.
- `compose-image-artifacts/init` returns 503 with the missing setting named, never 500.
- The hosted Cloudflare presign URLs are byte-identical (existing equivalence test).
