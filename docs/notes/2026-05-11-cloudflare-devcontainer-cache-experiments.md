# Cloudflare Devcontainer Cache Experiments

Date: 2026-05-11
PR: #963
Workflow run: `25664066831`

## Context

SAM's first GHCR-based devcontainer cache implementation successfully pulled,
built, tagged, and attempted to push cache images, but GHCR rejected pushes made
with GitHub App installation tokens:

```text
denied: permission_denied: installation not allowed to Create organization package
```

This experiment tested two Cloudflare-based replacements:

1. Cloudflare managed Containers Registry at `registry.cloudflare.com`
2. R2-backed cache storage, both as Docker tarballs and BuildKit S3 cache

## Result Summary

Both Cloudflare strategies worked in GitHub Actions with staging environment
credentials.

The managed Containers Registry is the best fit for SAM's current VM agent flow
because it preserves the existing `docker pull`, `docker tag`, and `docker push`
model.

BuildKit S3 cache against R2 also worked, but it requires a `docker-container`
Buildx builder and does not map cleanly onto the current `devcontainer up`
wrapper flow.

R2 tarballs worked, but they would require custom `docker save/load` code and do
not get registry layer deduplication or native Docker transfer behavior.

## Cloudflare Managed Registry

The experiment built a 64 MiB image and pushed it through Wrangler:

```text
wrangler containers push sam-devcontainer-cache-exp:<run-id>
```

Wrangler authenticated Docker and pushed:

```text
Pushed image: registry.cloudflare.com/<account-id>/sam-devcontainer-cache-exp:<run-id>
```

Then the workflow reused that Docker login and tested plain Docker commands:

```text
docker tag sam-devcontainer-cache-exp:<run-id> registry.cloudflare.com/<account-id>/sam-devcontainer-cache-exp:docker-<run-id>
docker push registry.cloudflare.com/<account-id>/sam-devcontainer-cache-exp:docker-<run-id>
docker pull registry.cloudflare.com/<account-id>/sam-devcontainer-cache-exp:docker-<run-id>
```

Result:

```text
docker-<run-id>: digest: sha256:7eafb128de623003b2a956dd721be06eabd3c046c3408adc0cde7402214caf2b size: 737
Status: Downloaded newer image for registry.cloudflare.com/<account-id>/sam-devcontainer-cache-exp:docker-<run-id>
```

This confirms the registry supports the plain Docker push/pull behavior the VM
agent needs.

## R2 Docker Tarball

The experiment built the same image, saved it as a Docker tarball, uploaded it
to a temporary R2 bucket, downloaded it, loaded it back into Docker, and ran it:

```text
docker save sam-r2-cache-exp:<run-id> -o /tmp/sam-cache-exp-image.tar
wrangler r2 object put <bucket>/docker-save/sam-r2-cache-exp-<run-id>.tar --file /tmp/sam-cache-exp-image.tar
wrangler r2 object get <bucket>/docker-save/sam-r2-cache-exp-<run-id>.tar --file /tmp/sam-cache-exp-image-downloaded.tar
docker load -i /tmp/sam-cache-exp-image-downloaded.tar
docker run --rm sam-r2-cache-exp:<run-id>
```

Result:

```text
Upload complete.
Download complete.
Loaded image: sam-r2-cache-exp:<run-id>
3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351  /r2-cache-test.bin
```

This is feasible but not recommended as the primary path.

## R2 BuildKit S3 Cache

The experiment used `docker/setup-buildx-action` with the `docker-container`
driver and pointed BuildKit's S3 cache backend at a temporary R2 bucket:

```text
docker buildx build \
  --cache-to type=s3,region=auto,bucket=<bucket>,name=sam-buildkit-cache-<run-id>,endpoint_url=https://<account-id>.r2.cloudflarestorage.com,use_path_style=true,...,mode=max \
  --cache-from type=s3,region=auto,bucket=<bucket>,name=sam-buildkit-cache-<run-id>,endpoint_url=https://<account-id>.r2.cloudflarestorage.com,use_path_style=true,... \
  --load \
  /tmp/sam-cache-exp
```

Result:

```text
#6 importing cache manifest from s3:11828236366541811895
#11 exporting cache to Amazon S3
#11 sending cache export 0.9s done
#11 DONE 0.9s
```

This proves R2 can serve as a BuildKit S3 cache backend, but using it in SAM
would require owning the Buildx invocation instead of relying on `devcontainer
up`'s current `cacheFrom` image-reference support.

## Recommendation

Use Cloudflare managed Containers Registry for the next production iteration.

Implementation direction:

1. Generate short-lived Cloudflare registry credentials in the API/control
   plane.
2. Pass `DEVCONTAINER_CACHE_REGISTRY=registry.cloudflare.com`,
   `DEVCONTAINER_CACHE_USERNAME`, and `DEVCONTAINER_CACHE_TOKEN` to the VM agent
   bootstrap environment.
3. Change cache refs from `ghcr.io/<owner>/<repo>:devcontainer-cache` to
   `registry.cloudflare.com/<account-id>/<owner>-<repo>:devcontainer-cache`.
4. Keep the existing VM agent `docker pull`, `cacheFrom`, `docker tag`, and
   `docker push` flow.

R2 BuildKit cache is worth keeping as a future option only if SAM later takes
direct ownership of Buildx/devcontainer build execution.
