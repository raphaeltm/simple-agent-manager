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
  pnpm 9, git, a C/C++ build toolchain (`make`, `g++`, `python3`; on Ubuntu
  `apt-get install build-essential`: `pnpm install` compiles `better-sqlite3`), and a checkout of
  this repository.
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
3. Optional: secrets for the Worker go in `deploy/selfhost/.state/secrets.env` (mode 0600; create
   the directory first with `mkdir -m 700 deploy/selfhost/.state`), for
   example `SMTP_PASSWORD=...` and `BOOTSTRAP_OWNER_EMAIL=you@example.com`. With an owner email set,
   only that address can claim the new install by signing in with an emailed code.
4. `pnpm selfhost:deploy --init`: generates the platform keys (`.state/platform-keys.json`; back
   it up), `.state/gateway.env` (the reverse-tunnel gateway secret and lease port range) and the
   mail-collector files. Set `COMPOSE_PROJECT_NAME` in `.env` to the installation-specific name
   this command prints, before running Compose. Keep that name with this install; another install
   needs its own state directory and project name. Run init again after changing the port range
   or turning a profile on (`scripts/selfhost/install-record.ts:expectedComposeProjectFor`).
5. `(cd deploy/selfhost && docker compose build)`: builds the two local images (`caddy`, and
   `sam-mx` when `mail-in` is on). See [Image builds](#image-builds).
6. `(cd deploy/selfhost && docker compose up -d)`. Run compose from `deploy/selfhost/`, as every
   compose command in this README assumes: there it reads `.env`, including any `COMPOSE_FILE`
   overlays and `COMPOSE_PROFILES`. A `-f` on the command line replaces `COMPOSE_FILE`, which would
   drop your overlays.
7. `pnpm selfhost:deploy`: builds the web UI, the API Worker's dependencies and the vm-agent
   (in a pinned Go image), publishes the vm-agent to the bucket, applies D1 migrations and runs
   `celld deploy`, then waits until the new version answers.
8. Sign in at `https://app.SAM_DOMAIN`. To add someone, or a first administrator without
   `BOOTSTRAP_OWNER_EMAIL`: `pnpm selfhost:create-account --email someone@example.com [--superadmin]`.
9. GCP nodes: `pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.SAM_DOMAIN
--state-dir /absolute/path/to/install/.state --installation-id <SAM_INSTALLATION_ID>`.
   Use the generated installation's 32-character hexadecimal id; it is a public identifier.
   Keep the state directory with this install: the bootstrap writes creation receipts there.
   It runs after step 7 because it checks the token issuer the running install advertises. It
   creates a workload identity pool and provider trusting only this install, and a node service
   account, then prints the credential JSON to paste in **Admin -> Credentials** (Cloud Provider,
   GCP). Add machines to the installation pool in **Admin -> Infrastructure**. For the first
   few minutes after the credential is added, Google is still propagating the new service
   account: the box logs impersonation 403s and the pool shows `migration-pending` until the
   catalog publishes on its own. If the first price refresh falls in that window, machines show
   "Price unavailable" until the next retry (`gcpCatalog.priceRetryMinutes`, 60 by default).
   A node created through the API without `vmLocation` defaults to a Hetzner location (`nbg1`),
   so pass a zone the pool offers. A previously deleted pool id is refused (Google keeps it for 30 days); pass a new
   `--pool-id`.
   **Use a GCP project dedicated to SAM's nodes**, not the box's: the node service account's
   roles apply to the whole project, so in a shared project it could change or delete the box VM
   and its firewall. An existing `--pool-id` is reused only when its sole provider is this
   install's, and an existing `--service-account` only when nothing but this pool holds any role on
   it (the script names any other member and how to remove it). The provider admits only tokens SAM
   signs for the installation's own credential
   (`assertion.user_id` starts with `platform:`), and re-running the script narrows a provider
   made by an earlier version. SAM also refuses a user's GCP credential that names a pool the
   platform credential already holds, so add the printed credential in Admin -> Credentials as
   soon as the script finishes.

`pnpm selfhost:deploy --dry-run` prints the Worker configuration it would deploy, secrets redacted.

## Backup and restore

The fleet bucket contains Worker secrets as well as application data. The backup command encrypts
**the entire backup**, including the bucket, `.state/`, `.env` and its manifest, with AES-256-GCM.
It first requires exactly one running celld in the selected Compose project, then briefly stops
it for a consistent second bucket copy and restarts it even if that copy
fails (`scripts/selfhost/backup-lib.ts:runBackup`, `runPlainBackup`). Temporary plaintext lives
under the private `.tmp/selfhost-backups/` directory and is removed on success or failure.
Backup, restore, upgrade and teardown are operator-box commands. They refuse execution whenever
`CI`, `GITHUB_ACTIONS` or any `RUNNER_*` variable is present, even with an empty or false value.

Create a separate raw 32-byte key once. These commands write the key directly to a private file;
they do not print it, and refuse to overwrite an existing key:

```sh
install -d -m 700 "$HOME/.config/sam"
(umask 077; set -C; openssl rand 32 > "$HOME/.config/sam/backup.key")
pnpm selfhost:backup --encryption-key-file "$HOME/.config/sam/backup.key"
```

Use `--to /absolute/path/to/new-backup` for a specific destination; the default is
`deploy/selfhost/backups/<timestamp>`. Keep the key outside installation state and all backup
folders. Alternatively set `SAM_BACKUP_KEY_FILE` in the private `.env` to the key's **absolute**
path. The file must be owned by the operator, mode 0600, exactly 32 raw bytes, and have no symlinks
or hard links (`scripts/selfhost/backup-encryption.ts:readBackupKey`). Store a separate offline
copy of this key with your recovery records. Losing it makes the backups unrecoverable; keeping
it alongside a backup defeats that backup's encryption. Never print keys, Worker secrets or raw
bucket deployment manifests when diagnosing a failure.

Restore into a fresh disposable or replacement installation using the same SAM checkout/ref as
the original backup. Prepare an existing mode-0600 target `.env` with its own domain, object-store
settings and absolute state path. Its state directory
must be empty or absent, and its bucket/prefix must contain no objects. For an `s3://` store,
set `R2_S3_REGION` as well as `S3_ENDPOINT` and its credentials.

```sh
pnpm selfhost:restore --from /absolute/path/to/backup \
  --box-env /absolute/path/to/target.env --state-dir /absolute/path/to/fresh-state \
  --encryption-key-file "$HOME/.config/sam/backup.key"
```

Restore authenticates the complete encrypted inventory and every file before touching the target.
It refuses a target project with existing containers, copies state and bucket data, keeps the
target `.env`, strips the source installation's creation receipts, and does not start celld. On the original SAM ref, run `selfhost:deploy --init`
to retain the restored keys and establish new target ownership receipts. Set the target `.env`'s
`COMPOSE_PROJECT_NAME` to the canonical project name init prints; the name incorporates the
persisted installation id, domain and state directory. Repeat init with that setting, then start
that target's Compose stack, deploy and verify its data (`scripts/selfhost/backup-lib.ts:runRestore`,
`scripts/selfhost/install-record.ts:recordInstall`).
This command refuses an occupied target; it does not overwrite an existing fleet.

## Upgrade

```sh
pnpm selfhost:upgrade --to <git-ref> --encryption-key-file "$HOME/.config/sam/backup.key"
```

Every upgrade requires a fresh encrypted pre-upgrade backup; `--skip-backup` is unsupported.
Use `--backup-to /absolute/path/to/new-backup` to choose its location, or let the command create
`backups/pre-upgrade-<timestamp>` next to the state directory. Keep that snapshot and its key
until you have verified the upgraded installation.

Before deploying, the upgrade checks the active deployment's Durable Object classes against the
installed migration history and the target checkout. Unknown, removed, duplicated or reordered
migration tags, and changes to existing class declarations, are refused. Self-host-only tags,
including `selfhost-hosted-git-v1` when present in that checkout, participate in the same check
(`scripts/selfhost/upgrade-migrations.ts:installedMigrations`, `assertMigrationProgression`).

The command requires a clean tracked checkout and an installation-specific Compose project with
creation receipts. It checks out the target, runs `deploy --init`, rebuilds changed local images,
restarts Compose when its inputs changed, deploys and checks health. Failure automatically restores
the encrypted snapshot and previous code/dependencies before starting the previous version.
The recovery checks the original installation, bucket, state and Compose ownership before removing
its disposable celld cache (`scripts/selfhost/upgrade-lib.ts:runUpgrade`, `recoverUpgrade`;
`scripts/selfhost/backup-recovery.ts:runRollback`). Redeploying an old Worker alone cannot undo a
migration.

An unfinished operation retains `.state/upgrade-pending.json` with the previous ref and encrypted
snapshot path. Keep celld stopped if automatic recovery fails; retain the snapshot and key, and
retry the same upgrade command to recover the original install before attempting a new upgrade.
Do not delete the pending record to bypass a failed recovery.

After a successful upgrade, its printed rollback command restores the populated installation
in place. Run it from the upgraded checkout, keeping the original full commit SHA, snapshot,
key and any printed `--rebuild` arguments:

```sh
pnpm selfhost:upgrade --to <original-full-commit-sha> \
  --rollback-from /absolute/path/to/pre-upgrade-backup \
  --encryption-key-file /secure/path/to/backup.key
```

This command verifies that the authenticated snapshot belongs to that revision and installation,
restores its data before starting the old code, and checks health. Keep celld stopped and retry
the same rollback command if recovery fails. Failure restores the operator checkout and dependencies
without starting the application. If the process was killed or that checkout recovery fails,
restore the newer operator checkout and run `pnpm install --frozen-lockfile` before retrying.
`selfhost:restore` requires an empty replacement
target; use the printed upgrade rollback command for an existing installation.

For a nondefault install, use `--box-env`, `--state-dir` and, if needed, `--secrets`. Every deploy
and Compose operation uses that installation's environment and overlays. Set
`SAM_SELFHOST_STATE_DIR` to an absolute path when running Compose manually.

Older installs using the shared `sam-selfhost` project may set `COMPOSE_PROJECT_NAME=sam-selfhost`
explicitly for backup. Upgrades and destructive teardown refuse that shared identity. Move to a
separate, installation-specific Compose project through an operator-controlled migration first;
these commands do not adopt or automatically migrate the old project.

## Teardown

Inventory is read-only by default. Review a dry run before confirming either removal mode:

```sh
pnpm selfhost:teardown
pnpm selfhost:teardown --keep-data --dry-run
pnpm selfhost:teardown --keep-data --confirm <SAM_DOMAIN>
pnpm selfhost:teardown --remove-everything --dry-run
pnpm selfhost:teardown --remove-everything --confirm <SAM_DOMAIN>
```

`--keep-data` stops/removes this installation's Compose containers and owned node VMs, while
keeping its volumes, bucket, configuration, backups, keys, workload identity pool/provider, service
account and IAM grants. The retained data keeps the identity needed to use it again.

`--remove-everything` also removes proven-owned local volumes/state and cloud resources recorded
as created for this installation. It preserves backups unless `--delete-backups` is explicit,
and preserves local platform key material unless `--destroy-key` is explicit. Images and custom networks remain manual cleanup steps because they may be shared. Docker cleanup
checks live container ids, configuration paths and volume creation identities immediately before
removing those exact resources; it does not run a broad Compose project sweep. It does not adopt
resources because their names look familiar. Foreign, ambiguous, replaced and unrecorded resources
are preserved; a refusal/failure returns a nonzero exit status. The summary lists retained data
and manual cleanup steps (`scripts/selfhost/teardown.ts`, `teardown-model.ts:execute`).

Operator-managed `gs://` and external `s3://` stores and their contents are retained for manual
cleanup: a configured bucket URL or prefix is not creation proof. Verify exclusive ownership
before deleting anything there. The bundled trial store is removed only with its proven-owned
installation-specific Compose volume. DNS records, the box VM, its network and other manually
created resources remain operator cleanup steps. Never run destructive verification against a
shared install; use disposable resources you created for the test.

For new GCP node firewall rules, the bootstrap optionally accepts `--create-firewalls
--agent-source-ranges <comma-separated-CIDRs>` together with `--installation-id` and `--state-dir`.
It creates only missing rules and records their immutable ids and installation/environment scope.
Choose agent source ranges appropriate for your ingress path. Existing shared rules are not
adopted. Teardown deletes a recorded rule only after rechecking its id, owner and absence of
other VM users; it preserves shared or legacy rules (`deploy/selfhost/gcp-bootstrap.sh`,
`scripts/selfhost/teardown-gcp.ts:firewallItems`). Keep `.state/created-resources.json` after a
partial teardown: it is the receipt used to resume cleanup.

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
content is pinned, so a changed upstream fails the build rather than changing the image. A build
step has the same unrestricted network access as everything else on this box, the cloud metadata
server included (see [Not included yet](#not-included-yet)): pinning, not a fence, is what keeps an
upstream from changing what runs.

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
- **Hosted git.** Every project needs a repository, so on this install users can create projects
  and run agents only once a GitHub App (the `GITHUB_*` Worker secrets in `.state/secrets.env`)
  or a GitLab integration is configured.
  Without one, sign-in, administration and nodes work, but no agent session can start.

Do not put data on this box that you could not afford to lose or leak.

## Tests

- `pnpm selfhost:test`: deploy, encrypted backup/restore, upgrade recovery, teardown ownership, account and configuration logic, compose wiring, pinned
  versions, `caddy/start.sh` (no Docker needed).
- `pnpm selfhost:live-test`: the box's real Caddy image (built from `caddy/Dockerfile`), frp and
  celld in Docker with host networking: gateway 404s and path tricks, the frp rate limit, header
  stripping, logging, keep-warm, the mail collector, frpc certificate checks, celld's guarded
  fetch and shared in-flight reads. CI runs it only when self-host paths change.
