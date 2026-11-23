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

| case                                          | result                                              | celld RSS peak (idle 43 MB) | MB/s |
| --------------------------------------------- | --------------------------------------------------- | --------------------------- | ---- |
| `R2.put(request.body)` 256 MB                 | 200, sha matches on download                        | 145 MB                      | 101  |
| `R2.put(request.body)` 1023 MB                | 200, sha matches                                    | 220 MB                      | 132  |
| R2 multipart, 16 MB parts, 1023 MB            | 200                                                 | 308 MB                      | 169  |
| put 1000 MB through the box Caddy image       | 200 (Caddy 22 MiB)                                  | 237 MB                      | 143  |
| 1000 MB at 5 MB/s (200 s); via Caddy 10 MB/s  | 200; no handler-budget cut                          | -                           | -    |
| client aborts after 3 s                       | no partial object (GET 404)                         | -                           | -    |
| body over 1 GiB                               | 413 `request body too large` (celld)                | -                           | -    |
| `CELLD_MAX_REQUEST_BODY_BYTES` above 1 GiB    | celld refuses to start (`cannot exceed 1073741824`) | -                           | -    |
| put with `onlyIf: {etagDoesNotMatch: '*'}` x2 | first writes, second returns null (write-once)      | -                           | -    |
| put with a wrong `sha256`                     | rejected                                            | -                           | -    |

Concurrent 1 GB uploads (same setup): peak RSS 220 / 284 / 427 / 896 MB for 1 / 2 / 4 / 8 uploads,
about 85 MB per in-flight upload over a ~150 MB base. Aggregate throughput is flat at ~182 MB/s
from 2 uploads on. Hence the default cap of 4 (~430 MB peak).

The body never sits in the isolate heap and RSS stays far below the body size, so streaming works.
**Hard limit:** one request through celld carries at most 1 GiB. Larger compose artifacts need a
parted upload, which changes the vm-agent client. Deferred to PR B (idea filed in this PR).

## Design (PR A)

```
 uploader ─(1) init (existing authenticated route)─► Worker: mint token {op, key, max, ct, sha?, exp}
 uploader ─(2) PUT/GET https://api.<domain>/api/box-objects?token=…─► Caddy ─► celld Worker
 Worker ─(3) verify token → R2.put(key, body, {onlyIf: write-once, sha256?}) / R2.get(key) stream
```

- One URL-signing seam (`ObjectUrlSigner`): S3 presign (current code, unchanged bytes) or the box
  signer. The box signer is installed only by the self-host build (`selfhost/build.ts`), so the
  Cloudflare bundle cannot reach it. A box that still has a static key keeps direct presign.
- Token in the query string: the browser, vm-agent and builder clients PUT/GET opaque URLs, so no
  client changes and no rollout coupling. Caddy never logs query strings; SAM's request log records
  only the pathname.
- Key: HKDF-SHA256 from `ENCRYPTION_KEY` with its own label (the hosted-git token pattern, shared
  helper). It rotates with `selfhost:secrets rotate`. A token is verified once, when its request
  starts, so a rotation during an upload does not affect it. A token minted before the switch
  verifies through `ENCRYPTION_KEY_PREVIOUS` during the overlap. Once that key is dropped, an
  unused URL gets 403 like an expired presigned URL, and the client asks for a new one. No operator
  input, no new secret.
- Box-wide concurrency cap (`BoxUploadGate` DO, self-host only): `boxObjects.maxConcurrentUploads`
  (4), `boxObjects.maxUploadsPerUploader` (2), `boxObjects.uploadIdleSeconds` (60, then 408),
  `boxObjects.uploadLeaseSeconds` (300, renewed while bytes arrive). Over the cap: 503 + Retry-After.
- Session snapshots: their Worker-streamed route needs `X-SAM-Content-SHA256`, which the box Caddy
  strips (`request_header -X-SAM-*`), so every snapshot artifact PUT got 400 on a box (found on the
  disposable GCS box). Direct snapshot uploads now use the same signer (sha256-bound box URL).
  Restores read through the Worker's GET route with `Authorization`, which Caddy keeps.

## Threat model

| Threat                                     | Control                                                                                                                                                                                                                                                                      | Test                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Forged token                               | HMAC-SHA256 over prefix+payload, constant-time verify, purpose-labelled HKDF key (a hosted-git token is not an object token)                                                                                                                                                 | tampered payload, wrong label, wrong key → 403, nothing written                    |
| Replay of an upload token                  | TTL = caller's existing presign TTL (≤ 15 min default); write-once put (`etagDoesNotMatch: '*'`); a retry after success answers 200 only when the stored object matches the token's size (and sha256 when bound)                                                             | second PUT with different bytes → 412, object unchanged; same bytes → 200          |
| Scope escape (other key/prefix, traversal) | the key lives only inside the signed payload; no path or query parameter names a key; key validated with the same unsafe-segment check as presign                                                                                                                            | extra `key=` param ignored; `..` key refused at mint                               |
| Method confusion                           | `op` claim: a GET token cannot PUT and vice versa                                                                                                                                                                                                                            | cross-op → 403                                                                     |
| Size DoS                                   | `Content-Length` required and ≤ token `max` ≤ 1 GiB (celld cap); body wrapped in `FixedLengthStream`; celld refuses > 1 GiB before the Worker runs                                                                                                                           | over-max → 413 without a write; short body → no object                             |
| Integrity                                  | build-context sha256 bound into the token and checked by `R2.put({sha256})`; compose artifacts keep size validation at completion                                                                                                                                            | wrong bytes → 400/412                                                              |
| Cross-user / cross-project writes          | the token is minted only by the existing authenticated init routes (session auth for attachments, callback JWT + project policy for compose/build-context), which derive the key from the caller's verified identity; claims carry the user/project/workspace for audit logs | attack: user A's token cannot write user B's key; owner control writes its own key |
| Token leakage in logs                      | query string; Caddy logs no query; request log is pathname-only; tokens are never logged by the route                                                                                                                                                                        | log assertion in route test                                                        |
| Egress fence / celld isolation             | the route runs inside celld's Worker and talks only to the R2 binding (celld's bucket): no outbound fetch, nothing the egress fence must allow                                                                                                                               | n/a                                                                                |

## Checklist

- [x] Shared signed-token helper extracted from `selfhost/hosted-git/tokens.ts` (rule 59: extend, not fork); hosted-git tests unchanged and green
- [x] Object URL token mint/verify (`selfhost/object-urls/tokens.ts`), key-prefix allowlist incl. the snapshot prefix, 24 h cap
- [x] Box route `PUT|GET /api/box-objects` (create-only put, sha256, size cap, FixedLengthStream, idle watchdog, streaming GET)
- [x] `ObjectUrlSigner` seam: app-deployment compose + build-context take a signer; attachments and snapshots use it
- [x] `getR2ObjectUrlSigner(env)`: presign when configured, else installed box signer, else `AppError` 503 naming the settings (route-level test)
- [x] Attachments `request-upload` availability uses the same resolver (403 → works on box)
- [x] Session snapshot direct uploads use the signer on a box (the fallback route cannot pass Caddy)
- [x] Compose `maxBytes` clamped to the box limit so the agent fails before uploading
- [x] Concurrency gate DO + settings (coordinator requirement), memory arithmetic stated
- [x] Rule 74 tests: Cloudflare Env → presign; box Env (no key) → box route; box with key → presign
- [x] Cloudflare byte-identity test still green (`r2-presign-cloudflare-equivalence.test.ts`)
- [x] Self-host-only module test: Cloudflare bundle does not import the box signer
- [x] Docs: `deploy/selfhost/README.md` "Object store and uploads through the box"; static key optional
- [x] Idea for PR B (parted uploads > 1 GiB, vm-agent URL redaction, 503 retry): `01M83WWQTNTBD4SY1530G3XWH7`
- [x] Live celld test of the route (`scripts/selfhost/live/box-object-urls.live.test.ts`, 9 cases)
- [x] Disposable GCS box proof, no HMAC key: publish → release → app 200; attachment up/down; snapshot
- [x] Staging: hosted attachments + compose publish still work

## Acceptance criteria

- A GCS box without an HMAC key: compose publish, task attachment upload/download and a session
  snapshot all work.
- `compose-image-artifacts/init` returns 503 with the missing setting named, never 500.
- The hosted Cloudflare presign URLs are byte-identical (existing equivalence test).

## Disposable GCS box proof (2026-11-23, GCP `sam-vm-control-plane-test`)

Box `sam-upbox` (e2-standard-4, europe-west1-b), `SAM_DOMAIN=upbox.vmtest.sam2.party`,
`CELLD_BUCKET=gs://sam-upbox-fleet-90he14/celld`, TLS `dns-googleclouddns`, key provider `file`,
built from this branch. **No `R2_S3_ENDPOINT`, no HMAC or static store key.** Nodes through
`gcp-bootstrap` (pool `sam-upbox-90he14`), OpenCode agent with a free model.

- **Task attachment, browser → box → GCS:** `request-upload` returned
  `https://api.upbox…/api/box-objects?token=samobj1…`; the XHR PUT from the app origin got 200;
  `gs://…/celld/r2/workspaces-dev-assets/temp-uploads/<user>/<upload>/proof.txt` (46 B). Task
  submit validated it; the agent printed the file's contents from its workspace (download).
- **Session snapshot:** before the fix every `PUT …/session-snapshot/artifacts/*` got 400 (Caddy
  strips `X-SAM-Content-SHA256`). After 8bedbfb29: `upload-url` 200, `box_objects.uploaded`
  `session-snapshots/…/wip.bundle` (978 B) and `home.tar` (27.9 MB), `complete` 200.
- **Build-backed publish:** `compose-image-artifacts/init` 200 (was a 500), `box_objects.uploaded`
  `compose-image-artifacts/…/web.docker-save.tar`, `complete` 200, `compose-publish-release` 200
  (release v1). The deployment node downloaded the artifact (`box_objects.downloaded`), applied the
  release, and `https://r1-web-8080-01m83zgpc4sf9jqxq879093f20.apps.upbox.vmtest.sam2.party/` answered
  **200 `upbox build ok`** with a verified certificate.
- Logs: Caddy recorded `uri: /api/box-objects?<redacted>`; `samobj1` occurs 0 times in the Caddy
  and celld logs.
- Side findings (not this change): OpenCode Zen returned "Workspace usage limit reached" for the
  default paid model (a free model worked); a build-backed publish needs the task to run under an
  agent profile (`publish: empty agentProfileID` otherwise); node boot on e2-standard-2 took ~12 min.

### Cleanup (2026-11-23 11:47 UTC)

Deleted and verified absent: SAM nodes (3 workspace, 1 deployment) through the box API, after
which their GCP VMs were gone; VM `sam-upbox`; firewall `sam-upbox-allow-web`; Cloud DNS
`*.upbox` and `*.apps.upbox`; project bindings `compute.instanceAdmin.v1` and `compute.securityAdmin`
(sam-upbox-nodes) and `dns.admin` (sam-upbox); service accounts `sam-upbox` and `sam-upbox-nodes`;
WIF pool `sam-upbox-90he14` (state DELETED); bucket `gs://sam-upbox-fleet-90he14`. The shared box
`sam-box`, its firewall and the shared `sam-allow-*` rules were not touched.

## Review round 3 (Codex P1, browser 503)

Browser attachment uploads treat a 503 as fatal, so a user uploading more files than
`boxObjects.maxUploadsPerUploader` lost the extras. The route now waits up to
`boxObjects.uploadAdmissionWaitSeconds` (default 30, range 0..600) for a slot, checking the gate
every second, and only then answers 503 with Retry-After (80143b6b1). Unit test proven
discriminating; live celld test: the fifth concurrent upload is held, then returns 200 when slots
free. Memory is unchanged: a waiting request holds no gate slot and its body is not read yet.
