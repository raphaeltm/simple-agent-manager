# SPIKE ONLY — Cloudflare compose builder

Throwaway phase-0 research, 2026-11-06. Never merge this branch. This is an incomplete startup/capacity probe, not a product builder.

The staging experiment was blocked before fixture builds. No storage-driver result or R2 throughput was obtained. See SAM Library `/engineering/research/cf-build-executor-spike.md` for evidence and cleanup.

Files include root DinD startup probe, authenticated scratch Worker with RPC diagnostics/lifecycle endpoints, and three **unexecuted** compose fixtures. The driver does not yet run fixtures, sample resources, handle SIGTERM, or transfer R2 artifacts.

Dependencies are locked. `docker:28-dind` resolved to `sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac` during this run; Compose was v2.40.3, Docker v28.5.2.

Do not deploy without a new authorized staging budget and cleanup owner. Use only staging account/token via SAM `exec_with_secrets`, export them to CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN within that process, install dependencies with `npm ci`, and set a fresh SPIKE_KEY Worker secret. No credentials belong in config/source.

Probe routes require bearer SPIKE_KEY: `/version`, `/rpcdiag?id=NAME`, `/?id=NAME`, `/kill?id=NAME`, `/destroy?id=NAME`. `max_instances=1`. A second identity exercises capacity. The library SDK can convert start errors to HTTP500; direct start RPC errors are caught as HTTP503 by this scratch Worker.

Known probe hazards: DinD remounts /tmp; keep logs elsewhere. Python HTTPServer normally does a reverse DNS lookup; the current probe skips it. Existing DOs continued serving earlier code after Worker redeploys; check version evidence. A successful stop/destroy response is not proof the platform freed capacity.

Cleanup must delete Worker, application, every repository tag/image, objects/bucket/tokens if created, then verify via CF API. Do not touch unrelated staging apps.
