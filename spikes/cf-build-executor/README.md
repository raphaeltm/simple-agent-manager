# SPIKE ONLY — Cloudflare compose executor

Throwaway staging experiment. **Never merge. No PR.** Attempt 2 uses the official Sandbox SDK 0.x DinD startup recipe, pinned SDK/image 0.12.14. Product code must add job scoping, deadlines, safe extraction and cancellation callbacks.

## Reproduce within an explicitly authorized staging budget

1. Use managed `CF_TOKEN`/`CF_ACCOUNT_ID` through `exec_with_secrets`. Confirm account GET name is `SAM Staging` before deploying. Never use production credentials.
2. `npm ci`; select a NEW Worker name in `wrangler.jsonc` for each deployment. Keep `max_instances=3`. Export the selected managed values as `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` only inside that execution job; run `npx wrangler deploy`.
3. Generate a throwaway key in a private file outside the repo; `npx wrangler secret put SPIKE_KEY < /private/key`. This authorizes arbitrary root exec; delete Worker after use.
4. `python3 probe.py WORKER_URL fresh-id 'timeout 60 sh -c '\''until docker version >/dev/null 2>&1; do sleep 0.2; done'\''; docker info; uname -a' --key-file /private/key`.
5. Execute `/usr/local/bin/measure.sh a`, `SPIKE_HOST_NETWORK=1 /usr/local/bin/measure.sh b`, and `/usr/local/bin/measure.sh c` through the same Worker. Use separate fresh instances for cold repeats. Warm repeats reuse the same instance and cache. Fixture b without the environment switch tests the default bridge failure.
6. Capture log `/var/log/dockerd.log`. Sample VM MemTotal/MemAvailable/MemFree, whole-filesystem `df`, and `/sys/fs/cgroup/cloudchamber/memory.peak`. Memory includes reclaimable page cache; do not call CLI process RSS the builder peak.
7. Upload saved tar to scoped presigned R2 PUT and fetch a context via presigned GET. Never put broad credentials in the container. Attempt 2 could not perform these checks because staging R2 credentials were unavailable.
8. Stop/destroy instances, DELETE application + Worker, delete every registry tag, empty/delete any scratch bucket and revoke any created token. Verify with API GET404/list absence. Remove local auth/key files.

The deployed attempt-2 image preceded addition of `measure.sh`; that identical helper was uploaded via authenticated SDK exec (base64). The b host override was appended to `compose.override.yaml` in the live instances; `compose.host.yaml` preserves the equivalent reusable configuration. No Worker redeploy occurred during measurements.

See `cf-build-executor-spike.md`, `measurements.json`, and `docker-info.txt` for measured results and limits. R2 transfer completion remains a gate, not an inferred success.
