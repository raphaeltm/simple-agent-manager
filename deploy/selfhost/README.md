# Self-hosted SAM on one box (celld)

> **Experimental, not a supported deployment option.** This directory exists for the SAM team's
> own test box. It changes without notice, has no upgrade guarantees, and lacks security layers a
> real deployment needs (see [Not included yet](#not-included-yet)). The supported way to run SAM
> is the Cloudflare deployment described on the docs site.

One Linux VM runs the whole control plane with Docker Compose (`docker-compose.yml`):

| Service          | What it does                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| `celld`          | Runs the API Worker and serves the web UI, on `127.0.0.1:8080`              |
| `caddy`          | TLS on 80/443 for `*.SAM_DOMAIN`, proxies to celld; carries node WebSockets |
| `frps`           | Reverse tunnels from workspace nodes (profile `tunnel`), loopback only      |
| `objectstore`    | Bundled MinIO for trials (profile `local-store`)                            |
| `mail-collector` | Catches sign-in email for test installs (profile `mail-collector`)          |
| `sam-mx`         | Inbound agent email on port 25 (profile `mail-in`)                          |

Workspace nodes are cloud VMs that dial back to `wss://api.SAM_DOMAIN/~!frp`; they need no public
DNS of their own. The fleet bucket (`CELLD_BUCKET`) is the durable copy of everything celld stores.

## Prerequisites

- A Linux VM (GCE is what the team tests) with Docker Engine and the Compose plugin, Node.js 22,
  pnpm 9 and git, and a checkout of this repository.
- A domain with a wildcard record `*.SAM_DOMAIN` pointing at the VM. SAM serves `api.`, `app.`,
  `ws-<id>.` and `ws-<id>--<port>.` under it; the apex is unused.
- Inbound TCP 80 and 443 to the VM (and 25 for inbound agent email).
- A fleet bucket: `gs://` (the VM's service account needs `roles/storage.objectAdmin` on it),
  any `s3://` store, or the bundled store for a trial (`local-store` profile).
- TLS: `SAM_TLS_MODE=dns-googleclouddns` gets a Let's Encrypt wildcard through Cloud DNS (the VM's
  service account needs `roles/dns.admin` on the zone's project, `GCP_PROJECT` names it).
  `internal` uses Caddy's own CA, for local proofs only.
- A way to send sign-in codes: an SMTP relay (`SMTP_*`), or the mail collector on a test box.
- For GCP workspace nodes: `gcloud`, authenticated as an owner of the nodes' project.

Nothing here creates the VM, its firewall, DNS records or the bucket.

## Fresh install

From the repository root on the VM:

1. `pnpm install --frozen-lockfile`
2. `cp deploy/selfhost/.env.example deploy/selfhost/.env && chmod 600 deploy/selfhost/.env`, then
   edit it. The comments in `.env.example` explain every setting. The bucket credential in it can
   read every Worker secret, so the file must stay private (the scripts refuse a readable one).
3. Optional: secrets for the Worker go in `deploy/selfhost/.state/secrets.env` (mode 0600), for
   example `SMTP_PASSWORD=...` and `BOOTSTRAP_OWNER_EMAIL=you@example.com`. With an owner email set,
   only that address can claim the new install by signing in with an emailed code.
4. `pnpm selfhost:deploy --init`: generates the platform keys (`.state/platform-keys.json`; back
   it up), `.state/gateway.env` (the reverse-tunnel gateway secret and lease port range) and the
   mail-collector files. Run it again after changing the port range or turning a profile on.
5. `docker compose -f deploy/selfhost/docker-compose.yml --env-file deploy/selfhost/.env build`:
   builds the two local images (`caddy`, and `sam-mx` when `mail-in` is on). See
   [Image builds](#image-builds).
6. `docker compose -f deploy/selfhost/docker-compose.yml --env-file deploy/selfhost/.env up -d`
   (or run `docker compose build` / `up -d` from inside `deploy/selfhost/`, which reads `.env`).
7. `pnpm selfhost:deploy`: builds the web UI, the API Worker's dependencies and the vm-agent
   (in a pinned Go image), publishes the vm-agent to the bucket, applies D1 migrations and runs
   `celld deploy`, then waits until the new version answers.
8. Sign in at `https://app.SAM_DOMAIN`. To add someone, or a first administrator without
   `BOOTSTRAP_OWNER_EMAIL`: `pnpm selfhost:create-account --email someone@example.com [--superadmin]`.
9. GCP nodes: `pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.SAM_DOMAIN`.
   It runs after step 7 because it checks the token issuer the running install advertises. It
   creates a workload identity pool and provider trusting only this install, and a node service
   account, then prints the credential JSON to paste in **Admin -> Credentials** (Cloud Provider,
   GCP). Add machines to the installation pool in **Admin -> Infrastructure**.
   **Use a GCP project dedicated to SAM's nodes**, not the box's: the node service account's
   roles apply to the whole project, so in a shared project it could change or delete the box VM
   and its firewall. An existing `--pool-id` is reused only when its sole provider is this
   install's. Known gap: the service account trusts every token this install signs for that
   provider, and SAM does not yet stop a user's own GCP credential from naming this pool, so a
   user of the install could act as the node service account (fix tracked as SAM task
   01M7SB8FRZ08M5NEX9WGM74X61). Until then, give accounts on a GCP-node install only to people
   you would trust with that project.

`pnpm selfhost:deploy --dry-run` prints the Worker configuration it would deploy, secrets redacted.

## Upgrade

```sh
pnpm selfhost:upgrade --to <git ref>
```

It refuses a checkout with uncommitted changes, checks the ref out, runs `deploy --init`, rebuilds
only the images whose build inputs changed (explicitly, with `docker compose build <service>`),
restarts the stack (`up -d`, never `--build`) only when compose inputs changed, deploys, checks
health and prints how to roll back. For a box other than the default, pass `--box-env`,
`--state-dir` and `--secrets`; every deploy and compose command it runs or prints uses that box's
`.env` and every compose file its `COMPOSE_FILE` selects.

If an upgrade fails, `.state/upgrade-pending.json` records the ref it started from and the printed
output gives both ways out: run the same `selfhost:upgrade --to <ref>` again to retry (it reruns
every step, from the recorded ref, and its rollback still names that ref), or run the printed
rollback commands. The file is removed once an upgrade passes its health check.

**It takes no backup.** Copy the fleet bucket and `deploy/selfhost/.state` yourself first. An
upgrade that carries a D1 migration cannot be rolled back by redeploying the old ref; only your
own pre-upgrade copy restores it.

## Image builds

`caddy` and `sam-mx` are built on the box; every other image is pulled by digest. Builds are
explicit: `docker compose build [service]` (or `up` when the image does not exist yet), never on
an ordinary `up`, and `selfhost:upgrade` rebuilds a service only when its Dockerfile, its build
context or its build section in `docker-compose.yml` changed. Both Dockerfiles pin their base
images by digest. Caddy's modules (the DNS provider, `CADDY_DNS_MODULE`, and caddy-ratelimit) are
pinned by version and verified against the Go checksum database, and the build fails unless the
binary carries exactly those versions; `sam-mx` modules are pinned by `go.sum`.

Neither image runs as root. Caddy runs as uid 7101 and binds 80/443 through its binary's file
capability (`NET_BIND_SERVICE`, the one capability compose leaves it). Before each start, the
one-shot `caddy-volumes` service hands the `caddy-data` and `caddy-config` volumes to that uid,
so a box whose certificates were written by an older, root Caddy keeps them.

A build still downloads from the network (Docker Hub, the Go module proxy, Alpine packages). The
content is pinned, so a changed upstream fails the build rather than changing the image.

After changing a build argument in `.env` (`CADDY_DNS_MODULE`), run `docker compose build caddy`
yourself, then `docker compose up -d`: `selfhost:upgrade` rebuilds only for changes in the
repository, so it never notices an `.env` edit.

## Settings worth knowing

**Shell variables beat `.env`.** Docker Compose takes every variable its files interpolate
(`docker-compose.yml` and any file `COMPOSE_FILE` selects) from the shell before `.env`, so
`selfhost:deploy` and `selfhost:upgrade` do the same: an exported `CELLD_BUCKET`, `SAM_DOMAIN` or
port is what the deploy publishes and checks, and each one is logged by name. Shell variables no
compose file uses are ignored. Set the box in `.env`, not the shell.

**Object store and presigned uploads.** Uploads (attachments, snapshots) go from the browser
straight to the fleet bucket when `R2_S3_ENDPOINT` is set and `.state/secrets.env` holds a
credential scoped to the R2 prefix (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; never the fleet
credential, which the deploy refuses). **For an `s3://` bucket `R2_S3_REGION` is required** (the
store's SigV4 signing region, for MinIO usually `us-east-1`): the deploy refuses `R2_S3_ENDPOINT`
without it. A `gs://` bucket defaults to `auto`. The bundled store is a community MinIO build that
celld does not qualify for production. It refuses to start unless `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` are set, are not `minioadmin`, and the secret has at least 24 characters
(`openssl rand -hex 24`): that credential reads every Worker secret in the bucket.

**Reverse-tunnel ports and the gateway secret.** frps binds one loopback port per node from
`REVERSE_TUNNEL_PORT_RANGE_START`..`_END` (default 20000-29999). The deploy writes the resolved
range to both the Worker and `.state/gateway.env`, and refuses a range that contains a box port
(`CELLD_PORT`, `CELLD_INTERNAL_PORT`, `FRPS_BIND_PORT`, `OBJECTSTORE_*`, `HTTP(S)_PORT`,
`MAIL_COLLECTOR_*`, and the port of sam-mx's `SAM_MX_LISTEN`): a node leased one of those would
receive traffic meant for it. The deploy and upgrade check the ports as Docker Compose will run
them (shell variables included, see below) as soon as they read `.env` and before anything starts,
and Caddy's `start.sh` refuses to start when a port it is given lies in the range. celld, frps and
the mail collector run without capabilities, so their ports must be 1024 or above.
`SAM_MX_LISTEN` is a listen address, `[host]:port` (`:25`, `0.0.0.0:2525`, `[::]:2525`): a bare
port is refused, because sam-mx cannot listen on one. `gateway.env` also holds `REVERSE_TUNNEL_GATEWAY_SECRET`, the shared secret frps and
Caddy present to the Worker's loopback-only gateway routes (`/api/self-host/gateway/*`, which
Caddy answers with 404 from outside). When `gateway.env` changes, the deploy stops until the
stack is restarted (`docker compose up -d`), so the Worker never assumes settings frps is not
running.

**frp login rate limit.** Caddy accepts `SAM_FRP_LOGIN_RATE_LIMIT_EVENTS` (default 60) new frp
connections per client address per `SAM_FRP_LOGIN_RATE_LIMIT_WINDOW` (default `1m`) and answers
429 above it. A node keeps one connection; raise the limit if many nodes share an address.

**Email sign-in.** Either an SMTP relay (`SMTP_HOST`, `SMTP_TLS`, `SMTP_PORT`, `SMTP_USERNAME`,
`SMTP_FROM` in `.env`, `SMTP_PASSWORD` in `.state/secrets.env`), or, on a test box only, the
`mail-collector` profile: Mailpit catches every message and shows it at
`https://mail.SAM_DOMAIN` behind basic auth (user `collector`, password generated by
`deploy --init` into `.state/mail-collector-ui-password`). Anyone who can read the collector can
sign in as any account. The deploy refuses both at once, and the profile without `--init`.

**Inbound agent email.** Add `mail-in` to `COMPOSE_PROFILES`, an MX record
`agents.SAM_DOMAIN -> mx.SAM_DOMAIN` and inbound TCP 25. `sam-mx` accepts mail for
`agent+<key>@agents.SAM_DOMAIN` only, requires aligned SPF or DKIM, and hands each message to the
Worker's loopback gateway route. Replies go out through the SMTP relay (or the collector), which
the deploy requires when the profile is on.

**Cold starts.** celld retires an idle Worker isolate on its 30 s pool tick, and the next request
waits 1.5-2.4 s while a new one loads. Caddy pings `/health` every `SAM_KEEP_WARM_INTERVAL`
(default 5s) so the ping pays that cost instead of a user. `SAM_KEEP_WARM=off` turns it off.

**Logs.** `docker compose logs caddy` is the access log: one JSON line per request, with no
headers, no query strings, and no credentials in the path on the routes listed in
`caddy/log-redaction.caddy` (bootstrap, invite and AI-proxy tokens, preview signatures).
`docker compose logs celld` is the Worker's output.

## Not included yet

This version runs in plaintext mode: celld keeps every Worker secret in plaintext in the fleet
bucket's deploy manifests, so the bucket credential is the install's master key. Also missing:

- **Egress fence**: nothing stops Worker code from reaching loopback services, the private
  network or the cloud metadata server on the box.
- **Sealed secrets**: no key agent or KMS-backed encryption of the Worker's secrets.
- **Guided credential login** (sandboxed agent sign-in on the box).
- **Hosted git.**
- **Backup, restore and teardown** commands. Back up the fleet bucket and `.state/` yourself.

Do not put data on this box that you could not afford to lose or leak.

## Tests

- `pnpm selfhost:test`: deploy, upgrade, account and configuration logic, compose wiring, pinned
  versions, `caddy/start.sh` (no Docker needed).
- `pnpm selfhost:live-test`: the box's real Caddy image (built from `caddy/Dockerfile`), frp and
  celld in Docker with host networking: gateway 404s and path tricks, the frp rate limit, header
  stripping, logging, keep-warm, the mail collector, frpc certificate checks, celld's guarded
  fetch and shared in-flight reads. CI runs it only when self-host paths change.
