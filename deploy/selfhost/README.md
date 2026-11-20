# Self-hosted SAM on one box (celld)

> **Experimental, not a supported deployment option.** This directory exists for the SAM team's
> own test box. It changes without notice, has no upgrade guarantees, and lacks security layers a
> real deployment needs (see [Not included yet](#not-included-yet)). The supported way to run SAM
> is the Cloudflare deployment described on the docs site.

One Linux VM runs the whole control plane with Docker Compose (`docker-compose.yml`):

| Service          | What it does                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `celld`          | Runs the API Worker and serves the web UI, on `127.0.0.1:8080`                     |
| `key-agent`      | Opens the sealed Worker secrets for celld only ([Sealed secrets](#sealed-secrets)) |
| `caddy`          | TLS on 80/443 for `*.SAM_DOMAIN`, proxies to celld; carries node WebSockets        |
| `frps`           | Reverse tunnels from workspace nodes (profile `tunnel`), loopback only             |
| `objectstore`    | Bundled MinIO for trials (profile `local-store`)                                   |
| `mail-collector` | Catches sign-in email for test installs (profile `mail-collector`)                 |
| `sam-mx`         | Inbound agent email on port 25 (profile `mail-in`)                                 |

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
4. `pnpm selfhost:deploy --init`: chooses the key provider and seals newly generated platform keys
   into `.state/key-agent/bundles/` ([Sealed secrets](#sealed-secrets); no key setup needed),
   writes `.state/gateway.env` (the reverse-tunnel gateway secret and lease port range), the key
   agent's `agent.env` and the mail-collector files. Set `COMPOSE_PROJECT_NAME` and
   `SAM_KEY_AGENT_UID` in `.env` to the two lines this command prints, before running Compose. Keep that name with this install; another install
   needs its own state directory and project name. Run init again after changing the port range
   or turning a profile on (`scripts/selfhost/install-record.ts:expectedComposeProjectFor`).
5. `(cd deploy/selfhost && docker compose build)`: builds the local images (`egress-fence`, `key-agent`, `gce-metadata-proxy`, `caddy`, and
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

## Sealed secrets

On by default. The deploy passes celld no secret: it seals the platform keys and `secrets.env`
into `.state/key-agent/bundles/<id>.json` (AES-256-GCM under a random data key, the data key
wrapped by a key provider), and the Worker gets them at runtime from the `key-agent` service.
The deployed vars carry only `SAM_KEY_AGENT_ADDRESS` (`127.0.0.1:SAM_KEY_AGENT_PORT`, 7190), the
bundle id and the agent's public verify key, so the bucket's `deploy/` manifests hold no secret.
If the agent is down the API answers 503 `SECRETS_UNAVAILABLE` (`docker compose ps key-agent`).
Code: `scripts/selfhost/key-service.ts`, `scripts/selfhost/key-choice.ts`,
`deploy/selfhost/key-agent/`, `apps/api/src/selfhost/runtime-secrets.ts`.

**The channel.** The Worker connects to the agent with a raw TCP socket (`cloudflare:sockets`),
not `fetch`, and speaks a framed protocol whose first byte is NUL. No HTTP request can start that
way, so nothing the Worker can be made to fetch (any URL, headers, body, redirect or DNS answer)
can ask the agent for secrets. The agent also answers only celld's uid (checked in
`/proc/net/tcp`), and signs every answer over the Worker's nonce with a key sealed in the bundle,
so a process that takes the port while the agent is down cannot answer as it. Each fresh Worker
isolate pays one loopback round trip and asks again every `SAM_RUNTIME_SECRETS_TTL_MS` (5 min).
The agent keeps an opened bundle for 300 s, serves that copy while an unreachable or slow key
service is retried (`SAM_KEY_AGENT_STALE_WAIT_MS`, 1000 ms), for at most
`SAM_KEY_AGENT_MAX_STALE_SECONDS` (6 h) after it opened it, and drops it when the key service
refuses. So revoking the box's key access reaches running Worker isolates within one refresh; a
Durable Object already running keeps the secrets it started with until celld evicts it. The other
limits are in `.env.example`.

**The agent runs as the owner of `.state`**, from the start: never root, no capabilities, a
read-only root file system. Docker Compose takes the uid from `SAM_KEY_AGENT_UID` in `.env`;
`--init` prints the line (`id -u` of the user that owns `.state`) and every sealing deploy refuses
a missing or different value. The deploy never edits `.env`.

**Which key provider.** `pnpm selfhost:deploy --init` chooses once, records the choice and why in
`.state/key-agent/choice.json`, and every deploy prints it (`key provider: file (...)`).
`pnpm selfhost:secrets status` shows it later with the key reference and the bundles (never key
material). The automatic choice: bundles already on the box decide; otherwise `--init` asks the
instance metadata services which cloud this VM is on (Google, AWS IMDSv2, Azure IMDS,
`SAM_METADATA_PROBE_TIMEOUT_MS`, default 1500 ms each), tries this install's cloud key through the
VM's own identity (the key in `.env`, else the conventional one below) and takes it only if a real
wrap and unwrap succeeds. It falls back to a key file on the box only when nothing better was set
up, and never to a weaker key by itself: a configured key that fails, or a key that exists but
cannot be used, stops `--init` with the reason (`sealingFloorRefusal` in `key-choice.ts`).
`SAM_KEY_PROVIDER` in `.env` overrides the choice:

| `SAM_KEY_PROVIDER` | Key                                                                                   | Settings                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| unset (default)    | chosen by `--init`                                                                    |                                                                                            |
| `file`             | 32 bytes in `.state/key-agent/kek`, created at the first seal                         |                                                                                            |
| `gcp-kms`          | Cloud KMS key, the VM's service account                                               | `SAM_GCP_KMS_KEY`                                                                          |
| `aws-kms`          | KMS symmetric key, the instance role through IMDSv2; **not yet run against real AWS** | `SAM_AWS_KMS_KEY_ID`, `SAM_AWS_KMS_REGION`                                                 |
| `azure-kv`         | Key Vault key, the VM's managed identity; **not yet run against real Azure**          | `SAM_AZURE_KEY_VAULT_URL`, `SAM_AZURE_KEY_NAME`                                            |
| `transit`          | Vault or OpenBao transit key, off the box                                             | `SAM_TRANSIT_ADDR`, `SAM_TRANSIT_KEY`, `SAM_TRANSIT_ROLE_ID` (secret id in `credentials/`) |
| `legacy-plaintext` | **none: LEGACY.** Every Worker secret is a deploy var, in plaintext in the bucket     |                                                                                            |

**A box sealed with the file key can never be replaced or rebuilt on another machine.** The key
that opens its bundles exists only on that box, and backups leave it out
(`.state/key-agent/kek` and `.state/key-agent/credentials/` are excluded). Keep a copy off the box
(`pnpm selfhost:secrets key-file` prints where it is and its fingerprint,
`pnpm selfhost:secrets verify-key-copy <path>` checks a copy; neither prints the key): without it,
losing the box loses every stored credential. To make a box replaceable, seal with a key held off
it (a cloud key or Vault): `pnpm selfhost:secrets switch --to auto` after the one-time setup below.
`pnpm selfhost:secrets status` says the same on a file-key box.

**Removing a sealed value.** Each deploy lays `secrets.env` over the newest bundle, so deleting a
line does not remove a value sealed before. Delete the line, then deploy once with
`pnpm selfhost:deploy --unset NAME` (repeat `--unset` for more). It refuses a name still in
`secrets.env` and SAM's own generated keys. The two older bundles kept for rollback, and any
backup, still hold the value until later seals replace them.

**Switching providers** is never a silent change at a deploy:

```bash
pnpm selfhost:secrets switch --to auto --dry-run    # or --to gcp-kms|aws-kms|azure-kv|transit|file
pnpm selfhost:secrets switch --to auto
pnpm selfhost:secrets reseal                        # same provider: new data key, current KEK version
```

It opens the secrets with the current provider, checks the target with a round trip, seals them
with it and moves the install over; while the new Worker version deploys, the agent opens each
bundle with the provider its header names. If the first request to the new version is not healthy
it restores the previous provider and redeploys (`scripts/selfhost/secrets-switch.ts`).

### Moving an existing install to sealed secrets

A box installed before sealed secrets keeps its secrets in `.state/platform-keys.json` and
`secrets.env`, and `pnpm selfhost:upgrade` keeps it that way (it never makes this switch by
itself; it tells you to run `migrate`). So does `pnpm selfhost:deploy`, `--init` included: a box
with plaintext platform keys and no recorded key choice is sealed only with `--seal`, which
`migrate` passes after its contract check (`scripts/selfhost/deploy-keys.ts` `holdsPlaintext`).
That holds when the upgrade is run by a version from before sealed secrets, which knows no key
flags. One command moves it:

```bash
pnpm selfhost:secrets migrate                          # seal, check, switch, verify
pnpm selfhost:secrets migrate --key-copy <path>        # file key: also removes the plaintext files
```

It seals the existing files unchanged, proves the chain before anything switches (the agent's code
answers the Worker's real loader with every secret the files hold), starts the key agent and the
updated fence, deploys the Worker without secret vars, makes celld adopt it at once and requires
the first request to be healthy and the current deploy version in the bucket to hold no secret.
Any failure after the switch redeploys with `--key-provider legacy-plaintext` and removes nothing.
The plaintext files go last, and with the file key only once `--key-copy` proves a matching copy
exists (`scripts/selfhost/secrets-migrate.ts`).

### Old plaintext copies

Sealing stops new plaintext. Copies made before stay where they are:

```bash
pnpm selfhost:secrets plaintext [--backups <dir or gs://|s3:// url> ...]   # read only
```

It lists every deploy version in the fleet bucket that holds secret vars (names only, never
values), which ones celld still reads, and the backups holding `platform-keys.json`, `secrets.env`,
the key file or plaintext deploy versions. It deletes nothing: celld documents `deploy/` as not to
be deleted by operators. **Platform-key rotation is not available yet**, so until it lands the
copies made before sealing stay readable by anyone holding the bucket credential (or a backup and
its key). Rotate what you can rotate yourself (GitHub App secrets, OAuth client secrets, the SMTP
password) by putting the new value in `secrets.env` and deploying.

### Cloud key, one-time setup

Set the key up once, then run `pnpm selfhost:deploy --init` on a new box (it finds the key by
itself), or `pnpm selfhost:secrets switch --to auto` on a box sealed with the file key. The default
key name is `sam-` plus 8 hex digits derived from your domain:

```bash
NAME=sam-$(printf 'https://api.%s' "$SAM_DOMAIN" | sha256sum | cut -c1-8)
```

**Google Cloud** (as a project owner; the box VM needs the `cloud-platform` access scope):

```bash
PROJECT=<the box project>; BOX_SA=<the box VM's service account email>
gcloud kms keyrings create sam-selfhost --location global --project "$PROJECT"
gcloud kms keys create "$NAME" --keyring sam-selfhost --location global --purpose encryption \
  --labels sam-install="${NAME#sam-}" --project "$PROJECT"
gcloud kms keys add-iam-policy-binding "$NAME" --keyring sam-selfhost --location global \
  --member "serviceAccount:$BOX_SA" --role roles/cloudkms.cryptoKeyEncrypterDecrypter --project "$PROJECT"
```

The grant is on that key only. `--init` finds `projects/$PROJECT/locations/global/keyRings/sam-selfhost/cryptoKeys/$NAME`
by itself (`SAM_GCP_KMS_LOCATION` for another location), or set `SAM_GCP_KMS_KEY` in `.env`.

**AWS** (an EC2 instance with an instance profile):

```bash
REGION=<the box's region>; ROLE=<the box instance profile's role name>
KEY_ID=$(aws kms create-key --region "$REGION" --description "SAM sealed secrets $SAM_DOMAIN" \
  --tags TagKey=sam-install,TagValue="${NAME#sam-}" --query KeyMetadata.KeyId --output text)
aws kms create-alias --region "$REGION" --alias-name "alias/$NAME" --target-key-id "$KEY_ID"
KEY_ARN=$(aws kms describe-key --region "$REGION" --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)
aws iam put-role-policy --role-name "$ROLE" --policy-name sam-sealed-secrets --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"kms:Encrypt\",\"kms:Decrypt\"],\"Resource\":\"$KEY_ARN\"}]}"
```

**Azure** (a system-assigned managed identity on the box VM):

```bash
RG=<resource group>; VM=<box VM>; VAULT=<a new, globally unique vault name>
az keyvault create --name "$VAULT" --resource-group "$RG" --enable-rbac-authorization true \
  --enable-purge-protection true
az keyvault key create --vault-name "$VAULT" --name "$NAME" --kty RSA --size 3072 --ops wrapKey unwrapKey
PRINCIPAL=$(az vm identity assign --resource-group "$RG" --name "$VM" --query systemAssignedIdentity -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Crypto Service Encryption User" --scope "$(az keyvault show --name "$VAULT" --query id -o tsv)/keys/$NAME"
echo "SAM_AZURE_KEY_VAULT_URL=https://$VAULT.vault.azure.net"   # put this line in .env
```

**Removing a key is destructive**: every bundle, and every backup, sealed with it becomes
unrecoverable. Remove the grant first; keep the key until the box and its backups are gone. A box
cannot go back to plaintext deploy vars once `platform-keys.json` is gone
(`SAM_KEY_PROVIDER=legacy-plaintext` then refuses, because it would generate new platform keys).

**Agent VMs never receive the bucket or KMS credentials.** Only the box's key agent and the deploy
hold a key provider's credential; workspace nodes get neither, and the Worker never sees one
(`scripts/selfhost/agent-vm-credentials.test.ts`).

## Backup and restore

On a sealed box the backup holds the sealed bundles but leaves out the file key and key-service
credentials (`.state/key-agent/kek`, `.state/key-agent/credentials/`): a restore needs the key
copy you kept off the box, the Vault/OpenBao or AWS credential file (`transit-secret-id`,
`transit-token`, `aws-credentials`) restored into `.state/key-agent/credentials/` from a separate
secure copy, or access to the cloud key. `pnpm selfhost:restore` prints which. On a `legacy-plaintext` box, or for deploy versions
made before sealing, the fleet bucket contains Worker secrets as well as application data. The backup command encrypts
**the entire backup**, including the bucket, `.state/`, `.env` and its manifest, with AES-256-GCM.
Restored files retain owner execution when needed, with mode 0700 for tools and 0600 for other
files; group and world access are never restored. The one exception is `.state/egress-fence.nft`:
the fence container's root reads it without `DAC_OVERRIDE`, so every restore and rollback puts it
back at deploy's 0644 (`fence-state.ts:repairFenceRulesMode`). It holds addresses and ports, never
a secret. Rebuildable `go-cache` data is excluded.
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
`deploy/selfhost/backups/<timestamp>`. Existing parent directory permissions are preserved; only
new dedicated directories are created private, and symlinked parents are refused. Keep the key outside installation state and all backup
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
For the bundled store, first authenticate the backup and print the final target Compose project:

```sh
pnpm --silent selfhost:restore --from /absolute/path/to/backup --print-project \
  --box-env /absolute/path/to/target.env --state-dir /absolute/path/to/fresh-state \
  --encryption-key-file "$HOME/.config/sam/backup.key"
```

This prints only the public project name; it writes a private sibling identity reservation but makes no target state, runtime or store changes. Put that
name in the target `.env` as `COMPOSE_PROJECT_NAME`, keep `COMPOSE_PROFILES=local-store` (plus any
other desired profiles), and start only the bundled store and its initializer:

```sh
docker compose --env-file /absolute/path/to/target.env \
  -f deploy/selfhost/docker-compose.yml --profile local-store up -d objectstore objectstore-init
```

Wait for the store to be healthy and the initializer to exit successfully, then run the restore
below. Its store-only exception verifies the final canonical project, selected canonical Compose
file, pinned image, ownership labels and exact data/script mounts. It refuses application or
foreign containers, overlays and a store started under the pre-key project. The same project
keeps the restored store volume when you initialize and start the application afterward. The
store healthcheck uses IPv4 loopback and `OBJECTSTORE_PORT`, including a custom port.

```sh
pnpm selfhost:restore --from /absolute/path/to/backup \
  --box-env /absolute/path/to/target.env --state-dir /absolute/path/to/fresh-state \
  --encryption-key-file "$HOME/.config/sam/backup.key"
```

Restore authenticates the complete encrypted inventory and every file before touching the target.
If a copy fails, retain `<state-dir>.restore-progress.json` and retry the exact same command and
backup. This private journal binds the target and authenticated snapshot; its started phase records that
the target passed the empty-state and empty-bucket checks. A retry
refuses changed, additional, linked or foreign-owned partial files before copying again; do not
start the target or remove its journal to bypass a refusal. State files interrupted mid-copy may
be retried only when their bytes are an exact prefix of the authenticated source; bucket objects
still require complete byte equality. Before removing the progress journal, restore durably links
a private `<state-dir>.restore-complete.json` receipt. Keep that completion receipt until a fresh
deploy and health/data checks succeed: the same restore can safely retry after a completion error,
even when progress-journal removal succeeded but its directory sync failed. Both receipts must
match if present. A completed retry still refuses changed data or an application runtime. After
verification, remove these exact operator-owned metadata files manually; teardown retains them.
It permits only the verified bundled-store bootstrap described above, copies state and bucket data, keeps the
target `.env`, strips the source installation's creation receipts, and does not start celld.
A fresh restore reserves a random `SAM_INSTALLATION_ID` in private target-local metadata,
distinct even for independent hosts using identical paths and bucket names and stable for retries,
while preserving all cryptographic keys needed to read the restored data. The generated local
config receives that new ID. Restore omits the source bucket's active `deploy/current.json`
pointer but retains immutable deployment objects and application data, so starting celld cannot
execute source Worker code or its Durable Object alarms. Run a fresh deploy before serving the
restored application; that deploy creates the target's active pointer and Worker identity. Do not set an installation
ID in the target environment; restore refuses explicit overrides. Source VMs and their ownership
labels are retained: the replacement must provision its own nodes, and its teardown cannot adopt or
delete the source fleet. This also applies to disaster recovery; retire surviving source resources
separately using their original installation records. For every store type, set the target `.env`'s
`COMPOSE_PROJECT_NAME` to the canonical name restore prints **before** running `selfhost:deploy --init`.
You can also reserve it beforehand with the authenticated `--print-project` command. That command
creates only the private sibling identity reservation; it does not write target state or bucket data
or start a runtime. A reservation alone never permits restoring into occupied state or a bucket.
Keep the reservation on the target host and reuse the exact command and backup. Older v1 journals
are refused because they cannot prove an independent clone identity; preserve their target and
receipts for inspection instead of deleting metadata to bypass the check.
The name incorporates the restored installation ID, domain and state directory. On the original
SAM ref, run init with that setting to retain the keys and establish target ownership receipts, then start
that target's Compose stack, deploy and verify its data (`scripts/selfhost/backup-lib.ts:runRestore`,
`scripts/selfhost/install-record.ts:recordInstall`).
This command refuses an occupied application target; it does not overwrite an existing fleet.

A killed backup process cannot run its restart handler. If interrupted while celld was stopped,
inspect the exact installation's containers and restart only that installation's celld explicitly,
then use a fresh backup destination. Normal backup refuses a missing or stopped writer; it never
guesses which other installation to start. A partial ciphertext directory is not reusable, and a
fully encrypted backup whose receipt write failed is retained for operator inspection and restore;
it is not automatically adopted for destructive cleanup. Restore writes and syncs the complete
private journal before atomically publishing it, so an interrupted initial write can be retried
without adopting partial metadata. A published journal is revalidated and synced before any
target write. Invalid or legacy metadata still causes refusal: preserve the target and receipts
for inspection instead of bypassing ownership.

## Upgrade

After target deployment or restoration of the previous version, upgrade durably records that
health verification is in progress. If
verification is interrupted, a retry refuses automatic snapshot recovery: preserve live data and
inspect the stack before choosing an explicit rollback. A returned health failure still triggers
automatic rollback. Once health succeeds, both a successful upgrade and recovery of the previous version durably
commit completion before removing their recovery marker and syncing the state directory. A stale completed marker permits cleanup only,
never restoration of the pre-upgrade snapshot. An invalid phase or different checkout refuses.
If deployment is interrupted before health verification begins, retry still recovers the original
snapshot. **Writes accepted during that unverified upgrade window are discarded on rollback.**
Holding traffic until verification is tracked separately; schedule upgrades accordingly.

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
creation receipts (an older `sam-selfhost` install first needs `--adopt-legacy`, below). It checks out the target, runs `deploy --init`, rebuilds changed local images,
restarts Compose when its inputs changed, deploys and checks health. Failure automatically restores
the encrypted snapshot and previous code/dependencies before starting the previous version.
The recovery checks the original installation, bucket, state and Compose ownership before removing
its disposable celld cache. The recovery journal remains until the old service is healthy, and
current resource creation/removal receipts survive rollback (`scripts/selfhost/upgrade-lib.ts:runUpgrade`, `recoverUpgrade`;
`scripts/selfhost/backup-recovery.ts:runRollback`). Redeploying an old Worker alone cannot undo a
migration.

An unfinished operation retains `.state/upgrade-pending.json` with the previous ref and encrypted
snapshot path and resolved target SHA. Keep celld stopped if automatic recovery fails; retain the
snapshot and key. A pre-verification pending record permits retrying the same resolved target
to recover the original install. An interrupted verification or uncertain completion instead
requires inspection as described above; a valid completed marker permits cleanup only. A changed
`--to`, a moved branch/tag, or an older journal without a target requires the explicit rollback
command before choosing another target.
Do not delete the pending record to bypass a failed recovery.

**One-time case when upgrading to the rollback fence fix.** A rollback runs the tool of the version
you upgrade from. On a version before this fix, a failed upgrade's automatic rollback restores
`.state/egress-fence.nft` at 0600. The egress-fence container then crash-loops with
`Could not open file "/etc/sam/egress-fence.nft": Permission denied`, celld stays stopped and the
upgrade reports that automatic rollback did not complete. Restore the file's mode and rerun the
same command (the documented retry of the same target):

```sh
chmod 644 deploy/selfhost/.state/egress-fence.nft   # or "$SAM_SELFHOST_STATE_DIR/egress-fence.nft"
pnpm selfhost:upgrade --to <same-target> --encryption-key-file "$HOME/.config/sam/backup.key"
```

The retry restores the snapshot again, so repeat the `chmod` if the fence restarts with the same
error before celld comes up. Upgrades that start from a fixed version restore the mode
themselves (`fence-state.ts:repairFenceRulesMode`).
Rollback also keeps a private sibling `.<state-directory-name>.rollback-state.json` receipt
while replacing local state. Retry reconciles an interrupted directory swap before reading
installation metadata, and refuses changed directory identities. Keep that receipt and its
recorded `.rollback-state-*` directory together until recovery finishes; do not remove them
manually.

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
explicitly for backup. Upgrades and destructive teardown refuse that shared identity. Move such an
install to its installation-specific project with legacy adoption (below) first.

### Upgrade an install created before the shared project was retired

Installs created before `pnpm selfhost:upgrade` gained snapshots run under the fixed Compose
project `sam-selfhost` and have no compose creation receipt, so a plain upgrade refuses them. Their
own checkout also still holds the old upgrade tool. Check out the new SAM ref, then let its tool
adopt the install and upgrade it in one command. `--from` is the full 40-character commit the
stack runs now, and `--to` must resolve to the checked-out ref:

```sh
git fetch origin && git checkout --detach <target-ref> && pnpm install --frozen-lockfile
pnpm selfhost:upgrade --adopt-legacy --from <deployed-full-sha> --to <target-ref> \
  --encryption-key-file "$HOME/.config/sam/backup.key"
```

`--adoption-backup-to` chooses the adoption snapshot's path (default
`backups/pre-adoption-<timestamp>` next to the state directory). `--backup-to` applies to the
upgrade that follows. `--from` and `--adoption-backup-to` require `--adopt-legacy`, which cannot
be combined with `--rollback-from` or `--rebuild`. The checkout must be clean for tracked files.
The shell must not set `COMPOSE_PROJECT_NAME`, and the box `.env` must leave it unset or set it to
`sam-selfhost`. An install that already has its compose creation receipt is refused: use the plain
upgrade.

The running stack is not touched by the checkout. Adoption changes no SAM code and deploys
nothing (`scripts/selfhost/legacy-adoption.ts:runLegacyAdoption`):

1. It checks out `--from` again, so the compose files and bind mounts match the running stack.
2. It proves ownership (`legacy-adoption-inventory.ts:proveLegacyOwnership`):
   - every container of the `sam-selfhost` project carries this checkout's compose directory,
     compose files and `.env`; a missing label refuses;
   - bind mounts stay inside this checkout or its state directory;
   - each project volume is used only by those containers;
   - each container's config hash equals `--from`'s compose configuration;
   - there is exactly one running celld;
   - the canonical project is empty.

   Another checkout on the same host using `sam-selfhost`, or a wrong `--from`, refuses before
   any change.

3. It takes the encrypted backup from the live legacy stack.
4. It stops the legacy stack, journaling the intent first. It copies each volume into
   `<canonical>_<volume>` with a digest-pinned Alpine image, the egress fence's own base, which it
   pulls before changing anything if the box does not have it. The helper runs with no network,
   all capabilities dropped except the file-ownership ones a faithful copy needs, and a label
   carrying a random adoption id. Each copy is verified by a digest of every path's type, owner and
   mode and every file's content.
5. It writes `COMPOSE_PROJECT_NAME=<canonical>` into `.env`, keeping every other byte, then starts
   the same version under that project and checks health. After health it writes the installation
   and compose-project creation receipts and removes the stopped legacy containers.
6. It runs the normal upgrade from `--from` to the target, with its own fresh snapshot, automatic
   rollback and printed rollback command.

Each step is journaled (phases `proving`, `backed-up`, `stopped`, `switched`, `adopted`) in
`legacy-adoption.json` in the state directory, beside `legacy-adoption.env`, a private copy of the
original `.env`. Both are removed when the run succeeds or rolls back completely. If the process is
killed, check out the target ref again and rerun the identical command:

- it resumes at the recorded step;
- it removes any helper container the killed run left (only those with its adoption id);
- it recopies an unfinished volume from scratch;
- a backup interrupted mid-way is kept and a new one is taken, after restarting the legacy celld
  it may have left stopped;
- a stop that completed before its phase was journaled resumes from the stopped stack;
- a rollback that was interrupted is finished as a rollback, never resumed forward;
- an upgrade that already completed is not run again.

The upgrade marks the adoption journal while its own completed marker is still durable, so a
re-checkout of the target cannot make a finished upgrade look unstarted.

A refusal or failure before the legacy stack stopped returns the checkout to the target and
discards the journal. A later failure, or an unhealthy new project, rolls back to `sam-selfhost`:

- it journals the rollback first, so a killed rollback is finished on the next run;
- if the new stack ran, it first copies each of its volumes back over the legacy one,
  digest-verified: the celld cache, Caddy's certificates and, with `local-store`, the bundled
  bucket itself, so nothing the new stack wrote is lost;
- it removes the canonical containers and the volumes it created;
- it restores `.env` byte for byte and restarts the legacy stack.

Before the new stack starts, the legacy volumes are only read. Adoption never restores the bucket
from its snapshot: the same deployed version kept writing it. After such a rollback the checkout stays at `--from`, which matches the
running stack. If the rollback itself fails, the journal, the `.env` copy and the legacy volumes
are kept. Inspect the stack (`docker compose -p sam-selfhost ps`) before rerunning, and do not
delete those files to get past the error.

If the upgrade step fails, its automatic rollback restores `--from` under the adopted project; the
adoption stands and its journal remains. Check out the target and rerun the same command to retry
the upgrade. After a successful run the legacy volumes remain until you remove them with the
`docker volume rm` command it prints.

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

Keep that receipt after interrupted bootstrap too: project and service-account IAM grants have
an exact, durable intent before mutation, so retrying can preserve their creation proof
(`deploy/selfhost/created-resources.mjs:grantIntent`, `gcp-bootstrap.sh:record_resource`).
Pool, provider, service-account and optional firewall creation still have a post-create receipt
window: interruption before the receipt is saved can leave an unrecorded resource that retry
preserves as reused. Teardown will not adopt it. Inspect these public inventories in the node
project before manual cleanup:

```sh
gcloud iam workload-identity-pools list --project <node-project> --location global --show-deleted
gcloud iam workload-identity-pools providers list --project <node-project> --location global --workload-identity-pool <pool-id> --show-deleted
gcloud iam service-accounts list --project <node-project>
gcloud compute firewall-rules list --project <node-project>
```

Cross-check immutable IDs, issuer/description, creation time and the creator in Cloud Audit Logs
against your setup; a familiar name is insufficient. Inspect pool providers, account grants/keys
and firewall users before deleting anything. Remove only resources you can prove this install
created and exclusively uses; retain ambiguous/shared resources for inspection. A leftover
bootstrap firewall retains its original target tags, source ranges and TCP ports: agent ingress
8080/8443 from the selected ranges, or public app ingress 80/443. It does not widen them, but it
continues admitting matching traffic until you remove the proven-owned rule. These limitations
follow the create/describe/record sequence in `deploy/selfhost/gcp-bootstrap.sh`.

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
step has unrestricted network access, including metadata. The runtime UID fence does not
apply to build tools; only reviewed, pinned build inputs belong on the box.

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

## SAM-hosted repositories

The celld build enables SAM-hosted git. Create a project with the Artifacts repository option;
SAM seeds an empty repository so an agent can clone, commit and push without a GitHub App.
The repository Durable Object and its `selfhost-hosted-git-v1` migration exist only in celld.
The Cloudflare Worker never includes them.

Public repository import is unavailable in this slice; an import URL returns a clear 400.
A bounded importer is tracked in `tasks/backlog/2026-11-19-bounded-selfhost-git-import.md`.
GitHub and GitLab integrations remain available when configured.

Admin → Settings exposes `repositories.*` limits. Failed GC sweeps retry up to
`repositories.maxGcAttempts` (default 3), five minutes apart; success resets the budget.
Exhaustion preserves a failed marker and emits `hosted_git.gc_failed`; a later admitted push
starts a new cleanup episode. Failed pack ingestion reclaims incomplete rows before the next
push checks quota. Defaults are 64 MiB per push, 30,000 objects
10,000 refs and 256 MiB stored per repository, 16 MiB per inflated object, 128 MiB cumulative inflation
per request, delta depth 100 and 120 seconds per git operation. Operators can lower these
limits; raising them needs measured capacity review. Rejected pushes leave existing refs intact.
The storage limit is checked again after a pack and its index are stored; a push that crosses it
is refused and its pack dropped at once.
Like git, push ingest hashes every object with SHA-1 collision detection (SHA-1DC) and refuses
a push carrying a SHA-1 collision-attack block before any ref changes.
GC first drops whole packs that hold nothing reachable (for example a rejected push) without
inflating them. Known limit: moving the remaining reachable packed objects to loose storage
inflates each one under the same decompression budget, so that step cannot finish while more than
`repositories.maxInflatedBytes` of reachable pushed content waits for collection. Tracked in
`tasks/backlog/2026-11-19-hosted-git-gc-and-ingest-hardening.md`.
Clone/push credentials expire and runtime credentials also require the same active workspace
and callback generation. Deleting a project removes its hosted repository. At the ref limit, delete old refs in a separate
push before creating replacements; an unvalidated deletion does not reserve space for new refs.

## Not included yet

Missing:

- **Platform-key rotation**: deploy versions and backups made before a box was sealed keep its
  platform keys in plaintext until rotation lands ([Old plaintext copies](#old-plaintext-copies)).
- **Guided credential login** (sandboxed agent sign-in on the box).

Do not put data on this box that you could not afford to lose or leak.

## Tests

- `pnpm selfhost:test`: deploy, encrypted backup/restore, upgrade recovery, teardown ownership, account and configuration logic, compose wiring, pinned
  versions, `caddy/start.sh` (no Docker needed).
- `pnpm selfhost:live-test`: the box's real Caddy image (built from `caddy/Dockerfile`), frp and
  celld in Docker with host networking: gateway 404s and path tricks, the frp rate limit, header
  stripping, logging, keep-warm, the mail collector, frpc certificate checks, celld's guarded
  fetch and shared in-flight reads. CI runs it only when self-host paths change.

## Egress fence and metadata broker

`egress-fence.ts` renders a native nftables OUTPUT table for celld UID7103, distinct from Caddy7101,
sam-mx7102 and the metadata broker65532. DNS is open only to the configured resolver addresses on
TCP/UDP53; tunnel lease ports, exact store/SMTP endpoints and public HTTP(S) remain usable.
Loopback (including127.0.0.2 andIPv6), private, metadata, reserved and transition ranges are denied.
`SAM_EGRESS_ALLOW` adds exact IP:TCP-port exceptions; it cannot open metadata or Caddy admin2019.
The established allowance is reply-direction only, so restoration also blocks forbidden sockets
opened during a flush. Tests live in `scripts/selfhost/live/fence-netns.live.test.ts`.

`celld/start.sh` requires every rule-class probe and a current attestation before serving. A rule
loss kills celld within the <=1-second validated bound; this is a bounded stop, not zero-gap kernel
protection. Only host root or host NET_ADMIN can change the control-plane rules. celld has neither;
ordinary agent workspaces and their privileged nested containers run on separate per-user node VMs.
No guided-login or untrusted app containers run on this box in this slice.

`fence.sh` observes kernel change events as well as exact rule fingerprints. Rule changes, flushes,
or observer failure latch a structured `egress_fence.lost` error in container logs and
`egress-fence-attestation/events.jsonl`. `docker compose ps` reports the fence unhealthy and celld
stays stopped/restarting; the front door cannot serve the API. There is no automatic rule repair.
Recover as the installation operator: regenerate with `pnpm selfhost:deploy --init` (which also
restores the rules file's 0644 mode when its content is unchanged), then
`docker compose restart egress-fence`, wait for healthy, and run `pnpm selfhost:verify-fence`.
Only verified startup clears the loss latch; event history remains. After resolver changes, regenerate
and restart the fence too. An `iptables -F` does not erase this native nft table; full native ruleset
flush/replacement is also tested. `verify-fence` covers DNS, TCP, UDP, routedIPv6 and alternate loopback.

For `gs://`, add `gce` to `COMPOSE_PROFILES`. The proxy listens only on127.0.0.1:7180 and checks the
client socket UID from Linux `/proc/net/tcp` as well as the generated path and Metadata-Flavor header.
It refuses other UIDs even if they know the path. It holds the VM token in its own process and uses
the pinned official Google auth SDK to exchange it through STS for a Credential Access Boundary
fixed to the `CELLD_BUCKET` bucket. `GCE_METADATA_PROXY_SCOPES` selects `devstorage.read_write`
(objects only: `roles/storage.objectAdmin`) or `devstorage.read_only` (`roles/storage.objectViewer`).
Mixed scopes and full_control are refused. Query, scope and resource overrides are404; exchange
failure is503 and never falls back to the VM token. Tokens and request paths are never logged.

The VM account needs object permissions on that exact bucket and IAM/STS APIs enabled once per
installation. This broker creates no accounts, grants or OAuth callbacks. CAB intersects existing
permissions and cannot grant access to another bucket or Cloud DNS. See Google's
[CAB guide](https://docs.cloud.google.com/iam/docs/create-downscoped-short-lived-credentials).
Metadata `scopes` alone is not used as a security boundary; Google's current
[metadata documentation](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata)
also requires `enforce_scopes=true` and scopes supported by the instance.

The SAM API Worker is trusted with fleet authority. On a sealed box the fleet bucket's deployment
manifests hold no secret, but those made before sealing still do, and fleet write authority is powerful; CAB does not establish
isolation between mutually untrusted Workers. Safety from broad VM permissions does not depend on
hiding the broker path. The pinned runtime test `live/metadata-proxy.live.test.ts` nevertheless
proves an exact native canary is absent from Worker process env (unknown keys return shim functions),
host/proc files are inaccessible, and Worker child-process execution fails. The first truthiness
assertion was a false positive; the exact comparison plus native-parent control is the proof.

Self-host tests install the broker's isolated npm lockfile. CI runs the kernel lab in a disposable
privileged Docker container with its own network namespaces; no workspace sudo or apt is needed.
For an `s3://` operator store, `R2_S3_REGION` remains mandatory when `R2_S3_ENDPOINT` is set.

### Reconcile generated fence state

On an existing running installation, ordinary deploy and `--init` now reconcile changed fence
inputs before continuing: stop affected celld, recreate and verify the fence, apply volume
ownership for its configured UID, then reload the proxy and celld as needed. Services deliberately
stopped remain stopped. Fresh `--init` only generates files. A failed reconciliation retains
private retry intent and aborts; repair Compose and rerun deploy. Each Compose command is bounded
by `SELFHOST_COMPOSE_TIMEOUT_MS` (default `60000` milliseconds); captured output is suppressed
because Compose can interpolate credentials. Verification honors the same
`SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS` setting as celld (default `2` seconds).

List Compose profiles explicitly: `COMPOSE_PROFILES=*` is refused, since it would select the
optional GCE broker even for an S3 installation. The broker accepts only its fixed native
client audience query; it never uses caller queries to select a token audience, scope or bucket.
Celld stdout/stderr redact the broker path credential before Docker records logs.

Metadata transport timeouts apply per attempt. The pinned Google STS SDK enables its bounded
retry policy for transient failures; callers receive a generic failure if exchange cannot complete.
Redirects and oversized responses are refused on every attempt.

The metadata proxy listener port is reserved outside node tunnel leases even while the GCE
profile is disabled. Deploy and Caddy refuse a conflicting range before serving.

Configured SMTP relay hostnames are resolved at deploy, opening only their exact TCP endpoints.
After relay DNS changes, rerun `pnpm selfhost:deploy --init` to reconcile the fence. Metadata
addresses and protected local listeners remain forbidden for relays.

The broker port must also differ from every other managed box listener, including disabled
optional services. Deploy, fence planning and Caddy startup all check this reservation.

GCP bootstrap requires a dedicated `--state-dir` receipt path for each GCP project. It refuses
active GCP receipts for a different or unrecorded project before making issuer or cloud calls,
including in dry-run mode. Preserve existing receipts; use a separate state directory for another
project. Removed resource receipts do not block reuse.
