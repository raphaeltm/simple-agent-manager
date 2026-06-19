# Spike: `docker compose publish` against a local OCI receiver

**Question:** If the VM agent exposes a transparent localhost OCI registry and the
coding agent runs a plain `docker compose publish`, what artifacts do we get, and
can SAM interpret them appropriately (separate the compose topology from the image
blobs, extract digests, drive a digest-pinned deploy)?

**Answer: Yes, cleanly.** Compose produces a small, self-describing OCI artifact
with a dedicated `artifactType`, the compose YAML as its own layer, a separate
digest-pinned overlay layer that is exactly the join key SAM needs, and (with
`--app`) an OCI index that bundles the service images and links them back to the
compose project via the OCI `subject`/referrers field.

## What was built (this directory)

- `proxy.mjs` — ~250-line Node OCI Distribution v2 receiver. Implements the push
  half of the spec (`/v2/`, blob uploads, manifest PUT/HEAD/GET), serves TLS
  (compose's publish client requires HTTPS even for localhost), and dumps every
  blob + manifest to `_captured/` while logging media types / digests / sizes.
- `sample-app/` — two-service compose app (`web`, `cache`), both built locally,
  `image:` fields pointed at the proxy via `${SAM_REGISTRY}`.
- `run-spike.sh` — builds the images and runs
  `docker compose publish localhost:5050/sam-proj/app:v1 --app --with-env --resolve-image-digests --yes`.

Env: Docker 29.6.0, Compose v5.1.4, dev container forced to `vfs` storage driver
(`/etc/docker/daemon.json`) because nested overlayfs fails here.

## What compose publish produced

Tag `localhost:5050/sam-proj/app:v1` resolved to **two** top-level manifests plus
the two image manifests:

```
oci://.../sam-proj/app:v1
├─ compose project manifest   (artifactType: application/vnd.docker.compose.project)
│    config: application/vnd.oci.empty.v1+json   (empty {})
│    layer[0]: application/vnd.docker.compose.file+yaml
│              annotation com.docker.compose.file=compose.yaml   ← original, TEMPLATED
│    layer[1]: application/vnd.docker.compose.file+yaml
│              annotation com.docker.compose.file=image-digests.yaml  ← RESOLVED + DIGEST-PINNED
│
└─ image index   (application/vnd.oci.image.index.v1+json, pushed by digest)
     manifests[]: web@sha256:a387…, cache@sha256:09c8…   (the service images)
     subject:     → the compose project manifest above   (OCI referrers link)
```

### Key artifact: the two YAML layers

`compose.yaml` layer (verbatim source, interpolation NOT applied):

```yaml
services:
  web:
    image: ${SAM_REGISTRY}/sam-proj/web:v1
    build: { context: ./web }
    environment: [ GREETING=${GREETING:-hello} ]
    ports: [ "8080:80" ]
    depends_on: [ cache ]
  cache:
    image: ${SAM_REGISTRY}/sam-proj/cache:v1
    ...
```

`image-digests.yaml` layer (the join key — produced by `--resolve-image-digests`):

```yaml
services:
  cache:
    image: localhost:5050/sam-proj/cache:v1@sha256:09c81e4e6ee833c18c7a0b2b91a782cab1137faa40094a52582c74437cbb684b
  web:
    image: localhost:5050/sam-proj/web:v1@sha256:a387f931edf0b199208e94f9bad5299a85e40760b1644d62028fcb5e3aaaaf53
```

These digests **exactly match** the image manifests bundled in the index — verified
in the harness. The overlay is a clean compose-merge layer: `compose -f compose.yaml
-f image-digests.yaml config` yields the fully digest-pinned project.

## Why this is good for SAM

1. **Discriminator is explicit.** `artifactType:
   application/vnd.docker.compose.project` (and per-layer
   `application/vnd.docker.compose.file+yaml`) means SAM can recognize a compose
   app without guessing. Image blobs (`…rootfs.diff.tar.gzip`) are trivially
   separable from topology (`…compose.file+yaml`).

2. **The digest is the join key, not the tag.** The `image-digests.yaml` overlay
   gives SAM an immutable, content-addressed mapping of service → image digest,
   snapshotted at publish time. This is exactly the contract SAM's deployment
   model wants (digest-pinned signed manifest). Tag `app:v1` is just a pointer;
   the deploy is driven by digests.

3. **Topology lives in the registry, not just the workspace.** SAM can pull
   `app:v1`, read the compose layers, and reconstruct the full service graph
   (ports, depends_on, env templates) on the deployment node without shipping a
   build context. Build once in the workspace, deploy by digest.

4. **Tiny payloads inline.** Layers under the threshold are returned inline as
   base64 `data` in the manifest (the YAML never needed a separate blob GET), so
   SAM can read the whole topology from a single manifest fetch.

5. **The localhost insight holds.** All image pushes went over plain localhost and
   were NOT subject to the CF 100MB edge ingress limit (the limit that killed the
   in-path Worker proxy). The vm-agent-local receiver is the right seam.

## Gotchas / notes for the real implementation

- **Publish client requires TLS.** Image push honors docker's localhost=insecure
  rule, but the compose *publish* artifact client (separate Go HTTP client) does
  not — it demanded HTTPS. The proxy had to serve TLS with a cert trusted via the
  system store + `/etc/docker/certs.d/`. The real vm-agent receiver must serve TLS
  (self-signed cert provisioned into the workspace trust store at boot).
- **`--with-env` added no layer here.** With only `${VAR}`-style inline env and no
  `env_file:` directives, no separate env layer appeared; env stayed as templates
  in the base `compose.yaml` layer. Worth re-testing with `env_file:` before
  relying on env capture.
- **Base compose layer is NOT interpolated.** `${SAM_REGISTRY}` / `${GREETING}`
  remain literal in the stored `compose.yaml`. Concrete image refs come only from
  the `image-digests.yaml` overlay. SAM should treat the overlay as authoritative
  for image identity and the base layer as the (templated) topology source.
- **Two-verb model fits.** `compose publish` = "snapshot app+images+digests into
  the registry"; a separate `sam deploy --env <name> <ref>` = "apply that digest
  to an environment". Environment is a deploy-time argument, never baked into the
  artifact — enabling promote-by-digest (same `app:v1` → staging then prod).

## Reproduce

```bash
# from this dir
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem \
  -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
sudo cp certs/cert.pem /usr/local/share/ca-certificates/sam-spike-localhost.crt
sudo update-ca-certificates
sudo mkdir -p /etc/docker/certs.d/localhost:5050
sudo cp certs/cert.pem /etc/docker/certs.d/localhost:5050/ca.crt
node proxy.mjs &            # serves https://localhost:5050
bash run-spike.sh           # builds + publishes; inspect _captured/
```
