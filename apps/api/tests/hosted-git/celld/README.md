# Hosted git on celld (manual)

Runs the real `HostedGitRepo` Durable Object under `celld dev` 0.6.3 with a bare router (no SAM
auth, which is plain JavaScript covered by `pnpm test:hosted-git` under workerd), then drives the
stock `git` CLI against it. Not part of CI.

```bash
mkdir -p /tmp/celld-run/proj /tmp/celld-run/bin && cd /tmp/celld-run
curl -fsSL -o celld.gz https://github.com/denoland/celld/releases/download/v0.6.3/celld-x86_64-unknown-linux-gnu.gz
echo "5084a083472cf036551a7eac63fa24d22bb9a56323c517f63205724c12783047  celld.gz" | sha256sum -c
gunzip celld.gz && chmod +x celld
ln -s "$(find <repo>/node_modules/.pnpm -path '*@esbuild+linux-x64*/bin/esbuild' | head -1)" bin/esbuild
cp <repo>/apps/api/tests/hosted-git/celld/{entry.ts,wrangler.json} proj/
ln -s <repo>/apps/api/src proj/src
PATH=/tmp/celld-run/bin:$PATH ./celld dev proj --port 9876 --no-watch &
bash <repo>/apps/api/tests/hosted-git/celld/conformance.sh
bash <repo>/apps/api/tests/hosted-git/celld/near-cap.sh
```

Result on 2026-11-12 (4 vCPU workspace, state on tmpfs, no bucket, so durability waits are not
included; the box's bucket adds latency): push, full clone + `fsck --strict`, shallow clone, fetch
into the shallow clone, and branch create and delete all pass. A 65 MiB push and a 30,071-object push
are refused with `remote: SAM: push refused: ...`. A `0004-004` pkt-line body answers 400 in 4 ms and
the repository keeps serving. Near the object cap (28,102 objects): push 3.2 s, cold clone 45 s, warm
clone 1.1 s, shallow clone 1.9 s, `fsck --strict` clean.
