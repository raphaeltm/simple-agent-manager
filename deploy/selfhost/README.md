# One-box SAM control plane on celld

Status: integration branch work (self-host pass 2). Not a supported install path yet.

The SAM API Worker and web UI run on [celld](https://celld.dev) behind Caddy on one machine,
with no Cloudflare account. Nodes reach the box through frps (the reverse-tunnel transport).
Instant sessions, Workers AI features and Analytics Engine are off; guided credential login is
opt-in (see Guided credential login). SAM-hosted git repositories are served by the Worker itself
(see SAM-hosted repositories below). Email sign-in works through an SMTP relay or, on a test
install, the bundled mail collector (see Email sign-in below).

## What runs

| Service              | Network | Listens on                      | Notes                                                    |
| -------------------- | ------- | ------------------------------- | -------------------------------------------------------- |
| `caddy`              | host    | `:80`, `:443`                   | wildcard `*.SAM_DOMAIN`, sets `CF-Connecting-IP`         |
| `celld`              | host    | `127.0.0.1:8080`, `:7001` (ops) | API Worker + web UI (`ASSETS`), cron triggers; uid 7101  |
| `egress-fence`       | host    | none                            | installs and keeps the celld nftables egress fence       |
| `gce-metadata-proxy` | host    | `127.0.0.1:7180`                | profile `gce`; access tokens for a gs:// bucket          |
| `frps`               | host    | `127.0.0.1:7000`                | profile `tunnel`; nodes arrive as frp over wss via Caddy |
| `objectstore`        | host    | `127.0.0.1:9000`                | profile `local-store`; otherwise use a GCS/S3 bucket     |
| `docker-proxy`       | none    | a unix socket shared with celld | guided login only: filters celld's Docker API calls      |
| `key-agent`          | host    | `127.0.0.1:7190`                | opens the sealed Worker secrets for celld only           |

Profile `mail-collector` (off by default, test installs only) adds `mail-collector`: Mailpit on
`127.0.0.1:1025` (SMTP) and `127.0.0.1:8025` (UI, published at `mail.SAM_DOMAIN`). See Email sign-in.

## Install or upgrade

Needs Docker with Compose v2.20+, Node 22+ and pnpm, and a checkout of this repository.

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env && chmod 600 deploy/selfhost/.env
$EDITOR deploy/selfhost/.env           # SAM_DOMAIN, TLS mode, bucket
pnpm install
pnpm selfhost:deploy --init            # key provider, sealed platform keys, gateway.env, fence files
(cd deploy/selfhost && docker compose up -d)   # reads .env there, including COMPOSE_FILE
pnpm selfhost:deploy                   # build web, migrate, deploy; re-run to upgrade
pnpm selfhost:verify-fence             # the egress fence is in effect (see below)
```

Upgrading a box from before the egress fence: add `gce` to `COMPOSE_PROFILES` if the bucket is
gs://, run `pnpm selfhost:deploy --init`, then `docker compose up -d --build`. celld switches to
uid 7101; `celld-data-owner` re-owns its data volume on the way. Every upgrade that changes the
fence needs the `--build`: celld does not start until the rebuilt fence service attests to the
new rules.

`pnpm selfhost:deploy` also builds the vm-agent (in a pinned `golang` image, so the box needs no
Go toolchain) and publishes it into the fleet bucket under the same keys the Cloudflare pipeline
uses (`agents/releases/<release>/vm-agent-linux-<arch>`, immutable), then pins the Worker's
`VM_AGENT_REQUIRED_VERSION` to that release. Nodes download it from `/api/agent/download`.
`--skip-vm-agent` skips this for a control-plane-only box. The release is resolved from git
history, so the checkout must be a full clone (not `--depth 1`).

Worker secrets that are yours to supply (GitHub App, OAuth clients) go in
`deploy/selfhost/.state/secrets.env` (`NAME=value`, mode 600). The deploy seals them, with the
platform keys it generates once, into a bundle only the box's key agent can open (Sealed secrets,
below). Back up `.state/` and the bucket, and keep the key apart from both.

celld has no secrets store for real nodes, and it keeps every deployed version's vars in plaintext
under `deploy/` in the fleet bucket. So the Worker gets its secrets at runtime from the key agent
and the deploy vars carry none. Only `SAM_KEY_PROVIDER=legacy-plaintext` (below) still renders
secrets into `vars`, and then the bucket credential is the root secret of the install.

Plaintext copies of the Worker secrets live in the celld process (the Worker's memory) and, for its
300 s cache, the key agent's memory. `REVERSE_TUNNEL_GATEWAY_SECRET` is also in `.state/gateway.env`
and the Caddy and frps container environments (`docker inspect` shows it). Keep the operator out
of the `docker` group unless they are trusted with all of it.

Presigned browser uploads go straight to the fleet bucket. Set `R2_S3_ENDPOINT` in `.env` and a
credential scoped to `<bucket>/<prefix>/r2/<R2 bucket>/*` as `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` in `secrets.env`, never the fleet credential. The deploy derives the
bucket and key prefix. The bundled store has no public `s3.` route yet, so leave it unset there.

Plain Worker var overrides (for example turning one of the self-host switches back on) also go in
`secrets.env`; it is merged last. `--dry-run` prints the rendered config with those values
redacted.

### Sealed secrets (on by default)

The deploy passes no secret to celld. It seals the platform keys and `secrets.env` into
`.state/key-agent/bundles/<id>.json` (AES-256-GCM under a random data key; the data key is wrapped
by a key provider), and the Worker gets them at runtime from the `key-agent` service on
`127.0.0.1:SAM_KEY_AGENT_PORT` (7190), which answers only celld's uid. The deployed vars carry
only `SAM_KEY_AGENT_URL`, the bundle id and the agent's public verify key, so the bucket's
`deploy/` manifests hold no secret. If the agent is down the API answers 503
`SECRETS_UNAVAILABLE` (`docker compose ps key-agent`). Each fresh Worker isolate pays one loopback
request (about 4 ms); the agent keeps an opened bundle for 300 s. When it reopens a bundle and the key
service is unreachable, or slower than `SAM_KEY_AGENT_STALE_WAIT_MS` (default 1000 ms, below the
Worker's 3 s wait for the agent), it serves the copy it already opened while the refresh continues; a
key service that refuses (`denied`) drops that copy. Measured on Google Cloud: opening a bundle
through Cloud KMS takes about 190-235 ms the first time (metadata token included), about 115-135 ms
on a later reopen.

**Which key provider.** `pnpm selfhost:deploy --init` chooses once, records the choice and why
in `.state/key-agent/choice.json`, and every deploy prints it (`key provider: file (...)`);
`pnpm selfhost:secrets status` shows it later with the key reference and the bundles (never key
material). Without a recorded choice a plain `pnpm selfhost:deploy` stops and asks for `--init`.
The automatic choice:

1. Bundles already on the box decide: only their provider can open them.
2. Otherwise `--init` asks the instance metadata services which cloud this VM is on (Google,
   AWS IMDSv2 and Azure IMDS in parallel, `SAM_METADATA_PROBE_TIMEOUT_MS`, default 1500 ms each;
   an answer counts only with that platform's own marker, never from host names).
3. On a cloud, it tries the key for this install through the VM's own identity: the key set in
   `.env`, else the one the one-time setup below creates (named `sam-<8 hex>` from your domain,
   like the bootstrap's pool id). It is chosen only if a real wrap and unwrap round trip succeeds.
4. Otherwise, and on any other host, the file key. The printed line says why in plain words, for
   example `key provider: file (on Google Cloud (project p), but Cloud KMS key projects/p/... is
not usable (denied: ...); using a key file on this box)`.

Moving to another provider later (for example after setting up a cloud key) is never a silent
change at a deploy:

```bash
pnpm selfhost:secrets switch --to auto --dry-run    # or --to gcp-kms|aws-kms|azure-kv|transit|file
pnpm selfhost:secrets switch --to auto
pnpm selfhost:secrets reseal                        # same provider: new data key, current KEK version
```

`switch` opens the secrets with the current provider, checks the target with a wrap and unwrap
round trip, seals them with it, and moves the running install over without a gap: while the new
Worker version deploys, the agent opens each bundle with the provider its header names (the old one
from `.state/key-agent/previous.env`, removed afterwards). If the first request to the new version
is not healthy it restores the previous provider and redeploys. Remove a `SAM_KEY_PROVIDER` line
from `.env` first; it would override the switch. Keep the old key while older bundles and backups
sealed with it exist. Code: `scripts/selfhost/secrets-switch.ts`.

| `SAM_KEY_PROVIDER` | Key                                                                                                                                                                                                                         | Settings                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| unset (default)    | chosen by `--init`                                                                                                                                                                                                          |                                                                                                                                             |
| `file`             | 32 bytes in `.state/key-agent/kek`, created at the first seal                                                                                                                                                               |                                                                                                                                             |
| `transit`          | Vault or OpenBao transit key, off the box                                                                                                                                                                                   | `SAM_TRANSIT_ADDR`, `SAM_TRANSIT_KEY`, AppRole `SAM_TRANSIT_ROLE_ID` with the secret id in `.state/key-agent/credentials/transit-secret-id` |
| `gcp-kms`          | Cloud KMS key, the VM's service account                                                                                                                                                                                     | `SAM_GCP_KMS_KEY`                                                                                                                           |
| `azure-kv`         | Key Vault key, the VM's managed identity                                                                                                                                                                                    | `SAM_AZURE_KEY_VAULT_URL`, `SAM_AZURE_KEY_NAME`                                                                                             |
| `aws-kms`          | KMS symmetric key, the EC2 instance role through IMDSv2 (or a stored access key in `.state/key-agent/credentials/aws-credentials` off AWS); tested against a fake and AWS's SigV4 vectors, **not yet run against real AWS** | `SAM_AWS_KMS_KEY_ID` (key id, ARN or `alias/...`), `SAM_AWS_KMS_REGION`                                                                     |
| `legacy-plaintext` | **none: LEGACY.** Every Worker secret is a deploy var, stored in plaintext in the fleet bucket for every deployed version and in every backup                                                                               |                                                                                                                                             |

The agent container starts as root only to become the owner of `.state/key-agent` (it keeps no
capability after that); set `SAM_KEY_AGENT_UID` to pin the uid instead.

Backups leave out `.state/key-agent/kek` and `.state/key-agent/credentials/`. **With the file
key, store a copy off the box** (a password manager or offline media): without it the install
cannot be recovered from a backup alone, because its platform keys (`ENCRYPTION_KEY` protects every
stored credential) and `secrets.env` values are sealed with it. The deploy says so once, when it
creates the key. `pnpm selfhost:secrets key-file` prints where the key is and its fingerprint;
`pnpm selfhost:secrets verify-key-copy <path>` checks a copy matches (neither prints the key). Once a deploy has run from the bundle, `platform-keys.json` and
`secrets.env` can be deleted; later edits go in a fresh `secrets.env` and are merged into a new
bundle. A `platform-keys.json` that disagrees with the bundle stops the deploy. Code:
`scripts/selfhost/key-service.ts`, `scripts/selfhost/key-choice.ts`, `deploy/selfhost/key-agent/`,
`apps/api/src/selfhost/runtime-secrets.ts`.

#### Moving an existing install to sealed secrets

A box installed before sealed secrets were the default keeps its secrets in `.state/platform-keys.json`
and `secrets.env`, and its Worker gets them as deploy vars. One command moves it:

```bash
pnpm selfhost:secrets migrate                          # seal, check, switch, verify
pnpm selfhost:secrets migrate --key-copy <path>        # file key: removes the plaintext files
```

It seals the existing files unchanged (`--init` chooses the provider), proves the chain end to end
before anything switches (the agent's code answers the Worker's real loader with every secret the
files hold), starts the key agent and the updated fence, deploys the Worker without secret vars,
makes celld adopt it at once (`POST /reload` on its internal listener) and requires the first
request to the new version to be healthy and the current deploy version in the bucket to hold no
secret. Any failure after the switch redeploys the previous behaviour
(`pnpm selfhost:deploy --key-provider legacy-plaintext`) and removes nothing. The plaintext files go
last, and with the file key only once `--key-copy` proves a matching copy exists: until then they
are the only other copy of the platform keys. `pnpm selfhost:upgrade` never makes this switch by itself: it keeps a box that
still has its plaintext files on plaintext deploy vars and tells you to run `migrate`. Code: `scripts/selfhost/secrets-migrate.ts`.

#### Old plaintext copies: bucket deploy versions and backups

Sealing stops new plaintext. What older deploys and backups already hold stays:

```bash
pnpm selfhost:secrets plaintext [--backups <dir or gs://|s3:// url> ...]   # read-only listing
```

It lists every deploy version under `deploy/<script>/<version>/` in the fleet bucket that holds
secret vars (names only), which versions celld still reads, the local backups (default
`deploy/selfhost/backups/`; repeat `--backups` for more, including a backup bucket, grouped by
folder) holding `platform-keys.json`, `secrets.env`, the key file or plaintext deploy versions
(archives are named, not opened), and how to rotate each exposed secret. Copies it is not pointed
at are not visible to it: treat every backup taken before the box was sealed as holding every
secret.

Rotating is the fix that does not depend on deleting anything: a rotated secret's old copies are
worthless. `ENCRYPTION_KEY` and the generated platform keys cannot be rotated by a SAM command yet;
the listing says what that exposure means.

Deleting old versions: celld (v0.6.3, from its source) reads only the version
`deploy/current.json` names, the ones `deploy/<script>/current.json` name, and the ones a queue
attachment (`deploy/queues/<queue>/consumer.json`) names; it never deletes old versions. But
celld's documentation says operators must not delete objects under `deploy/`. So deletion is
opt-in and narrow:

```bash
pnpm selfhost:secrets plaintext --purge --confirm <CELLD_BUCKET>
```

It runs only with the pinned celld 0.6.3, deletes only versions that hold secret vars and that no
pointer or attachment names (re-read before each deletion), and refuses while the current
version still holds plaintext. Code: `scripts/selfhost/plaintext-scan.ts`.

#### Cloud key, one-time setup

On Google Cloud, AWS or Azure the box can seal with a cloud key through its own VM identity, so no
key is stored on the box: revoking the grant stops new Worker isolates within the agent's 300 s
cache, and the cloud's audit log records every use. Set the key up once, then run
`pnpm selfhost:deploy --init` on a new box (it finds the key by itself), or
`pnpm selfhost:secrets switch --to auto` on a box already sealed with the file key. The key's
default name is `sam-` plus 8 hex digits derived from your domain, the same on every cloud:

```bash
NAME=sam-$(printf 'https://api.%s' "$SAM_DOMAIN" | sha256sum | cut -c1-8)
```

**Google Cloud** (as a project owner; the box VM needs the `cloud-platform` access scope):

```bash
pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.<SAM_DOMAIN> --kms-only \
  --box-instance <box VM> --box-zone <zone> --dry-run    # then again without --dry-run
```

It creates or reuses the key ring `sam-selfhost` (location `global`; `--kms-location`) and the
key `$NAME` labelled `sam-install`, grants `roles/cloudkms.cryptoKeyEncrypterDecrypter` to the box
VM's service account on that key only, and prints `SAM_GCP_KMS_KEY=...`. Use `--kms` instead of
`--kms-only` to also run the node setup above.

**AWS** (the box is an EC2 instance with an instance profile; IMDSv2 is enough):

```bash
REGION=<the box's region>; ROLE=<the box instance profile's role name>
KEY_ID=$(aws kms create-key --region "$REGION" --description "SAM sealed secrets $SAM_DOMAIN" \
  --tags TagKey=sam-install,TagValue="${NAME#sam-}" --query KeyMetadata.KeyId --output text)
aws kms create-alias --region "$REGION" --alias-name "alias/$NAME" --target-key-id "$KEY_ID"
KEY_ARN=$(aws kms describe-key --region "$REGION" --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)
aws iam put-role-policy --role-name "$ROLE" --policy-name sam-sealed-secrets --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"kms:Encrypt\",\"kms:Decrypt\"],\"Resource\":\"$KEY_ARN\"}]}"
```

The default key policy delegates to IAM, so the role policy above is the only grant. The AWS
provider has been tested against a fake of the KMS API and AWS's published SigV4 vectors, not
against real AWS yet.

**Azure** (the box VM gets a system-assigned managed identity; you need rights to create role
assignments):

```bash
RG=<resource group>; VM=<box VM>; VAULT=<a new, globally unique vault name>
az keyvault create --name "$VAULT" --resource-group "$RG" --enable-rbac-authorization true \
  --enable-purge-protection true
az keyvault key create --vault-name "$VAULT" --name "$NAME" --kty RSA --size 3072 \
  --ops wrapKey unwrapKey --tags sam-install="${NAME#sam-}"   # you need Key Vault Crypto Officer
PRINCIPAL=$(az vm identity assign --resource-group "$RG" --name "$VM" --query systemAssignedIdentity -o tsv)
SCOPE="$(az keyvault show --name "$VAULT" --query id -o tsv)/keys/$NAME"
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Crypto Service Encryption User" --scope "$SCOPE"
echo "SAM_AZURE_KEY_VAULT_URL=https://$VAULT.vault.azure.net"   # put this line in .env
```

A vault URL cannot be derived, so on Azure the `.env` line is required; `SAM_AZURE_KEY_NAME`
defaults to `$NAME`. With a user-assigned identity, also set `SAM_AZURE_CLIENT_ID`.

### Removing what setup created

Each setup step has a matching removal. Removing a key is **destructive**: every sealed bundle,
and every backup of the box, that was sealed with it becomes unrecoverable. Keep the key until the
box and its backups are gone.

**Google Cloud.** `pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.<SAM_DOMAIN>
--teardown [--dry-run]` reads `.state/created-resources.json` and removes only what the bootstrap
recorded creating, each proven this install's again first (the provider trusts this issuer, the
pool's and service account's descriptions name it, the key carries its `sam-install` label).
Anything that existed before, fails its proof, or is not in the record is left and listed. It
prints what it removed and what it left. `--keep-kms` leaves the key, its ring and the box's grant on it
(`pnpm selfhost:teardown --keep-data` passes it). Cloud KMS: the grant goes at once. A key version can be
deleted only after it is destroyed, a key only when all its versions are deleted, a key ring only
when all its keys are (Google:
[Delete Cloud KMS resources](https://docs.cloud.google.com/kms/docs/delete-kms-resources),
[Destroy and restore key versions](https://docs.cloud.google.com/kms/docs/destroy-restore)). So
`--teardown --destroy-key-versions <key id>` schedules destruction (30 days by default, billed
until destroyed, `gcloud kms keys versions restore` undoes it until then), and a `--teardown` after
that deletes the versions, the key and the ring. A deleted key's name cannot be reused. Key rings
are free; Google keeps a deleted workload identity pool for 30 days. Enabled APIs stay enabled.

**AWS.**

```bash
aws iam delete-role-policy --role-name "$ROLE" --policy-name sam-sealed-secrets
aws kms delete-alias --region "$REGION" --alias-name "alias/$NAME"
# Destructive: 7-30 day waiting period; `aws kms cancel-key-deletion` undoes it until then.
aws kms schedule-key-deletion --region "$REGION" --key-id "$KEY_ID" --pending-window-in-days 30
```

**Azure.**

```bash
az role assignment delete --assignee "$PRINCIPAL" --role "Key Vault Crypto Service Encryption User" --scope "$SCOPE"
# Destructive: soft-deleted for the vault's retention period; `az keyvault key recover` undoes it.
az keyvault key delete --vault-name "$VAULT" --name "$NAME"
az keyvault delete --name "$VAULT" --resource-group "$RG"   # only a vault created for SAM
```

**The whole install:** `pnpm selfhost:teardown` (see Removing an install) runs these in order.

**The box side** (also destructive). The key agent, the bundles and the file key live in
`.state/key-agent/`. A box cannot go back to plaintext deploy vars once `platform-keys.json` is
gone: `SAM_KEY_PROVIDER=legacy-plaintext` then refuses, because it would generate new platform
keys and every stored credential would become unreadable. To decommission a box:
`(cd deploy/selfhost && docker compose down)`, then `rm -r .state/key-agent` removes
the bundles, the file key and the recorded choice. Without a copy of the key (the file key kept
off the box, or the cloud key), the install's platform keys and every backup are gone with it.

## Email sign-in

SAM emails a six-digit sign-in code. On a box there is no Cloudflare Email Sending, so the Worker
sends through SMTP (`apps/api/src/services/agent-email/smtp-client.ts`). Codes go only to
addresses that already have an account, and to `BOOTSTRAP_OWNER_EMAIL` until that owner exists,
exactly as on Cloudflare. Choose one of:

**A real SMTP relay** (any provider with SMTP submission). In `.env`:

```bash
SMTP_HOST=smtp.example.com
SMTP_TLS=starttls          # or tls (implicit TLS, port 465); default starttls on 587
SMTP_USERNAME=relay-user
SMTP_FROM=sign-in@sam.example.com   # an address the relay lets you send from
```

and `SMTP_PASSWORD=...` in `.state/secrets.env`. The relay needs a certificate from a public CA:
celld trusts only its bundled roots (not the system store or `SSL_CERT_FILE`), and SAM refuses a
relay that does not offer STARTTLS rather than sending in plaintext. Plaintext (`SMTP_TLS=none`) is
accepted only to a loopback host. `pnpm selfhost:deploy` validates the settings with the Worker's
own parser and fails on a bad set.

**The mail collector, for test installs.** [Mailpit](https://mailpit.axllent.org) catches every
message on loopback and shows it at `https://mail.SAM_DOMAIN` behind basic auth.

> **Anyone who can read the collector can sign in to SAM as any account.** Every sign-in code
> lands there. Use it only on a test install, keep the password private, and turn the profile
> off for a real one. Mailpit checks the same password itself (`MP_UI_AUTH`), so the loopback
> port `127.0.0.1:8025` needs it too; anyone who can run `docker inspect` on the box can read it.

```bash
# .env: add the profile (it is off by default)
COMPOSE_PROFILES=tunnel,mail-collector
pnpm selfhost:deploy --init            # generates the UI password and .state/mail-collector*.env
(cd deploy/selfhost && docker compose up -d)
pnpm selfhost:deploy                   # points the Worker at the collector
cat deploy/selfhost/.state/mail-collector-ui-password   # user: collector
```

The deploy refuses the profile until `--init` has generated the password, refuses it together
with `SMTP_HOST`, and Caddy refuses to start with it on and no password (`caddy/start.sh` hashes
the password; Caddy's config and process see only the hash). Messages live in memory and are
gone when the container restarts. To turn it off: remove the profile from `COMPOSE_PROFILES`, run
`pnpm selfhost:deploy`, then `docker compose up -d` and
`docker compose --profile mail-collector rm -sf mail-collector`. Login pages can take a minute to
stop offering email (the public config is cached for 60 s).

The celld egress fence opens the collector's SMTP port on 127.0.0.1 by itself when the profile is
on (`mailEgressEndpoints()` in `scripts/selfhost/mail-settings.ts`, read by the fence renderer);
run `pnpm selfhost:deploy --init` after turning the profile on or off. A relay on the internet
needs no entry; a relay on a private address needs one in `SAM_EGRESS_ALLOW`.

**The first account.** On a fresh box with a sender and no OAuth app, set
`BOOTSTRAP_OWNER_EMAIL=you@example.com` in `.state/secrets.env` before the first deploy; that
address can then sign up by email at `https://app.SAM_DOMAIN` and becomes the administrator.
Without an owner email nobody can sign up by email, because the first person to ask would become
the administrator.

**More accounts, or a box whose first account already exists** (for example a seeded smoke-test
superadmin):

```bash
pnpm selfhost:create-account --email teammate@example.com              # a normal user
pnpm selfhost:create-account --email you@example.com --superadmin      # or an administrator
```

It writes the `users` row BetterAuth reads, through `celld d1 execute`, so the stack must be
running and deployed. It is idempotent: an existing account is left as it is, except that
`--superadmin` promotes it (and approves it if it was pending; it never lifts a suspension). The new account is active and its email verified (you vouch for the
address); it then signs in by requesting a code. Pass `--env-file` as for the deploy, and
`--dry-run` to print the SQL without running it. While `BOOTSTRAP_OWNER_EMAIL` is set and that
owner has never signed in, SAM admits only the owner.

**First run after the owner exists.** A box has no `SETUP_TOKEN` (only the Cloudflare installer
generates one), so `/setup` closes itself once an active superadmin exists and says SAM is set up
(`closeSetupWithoutToken`, `apps/api/src/routes/setup.ts`). Then, as that administrator:

1. **Admin → Integrations → Create GitHub App.** SAM posts a GitHub App manifest (callback, setup
   and webhook URLs for this domain, the usual permissions including **Email addresses: read**),
   you confirm on GitHub, and GitHub returns you to the page; SAM stores the App id, slug, client
   id and secret, private key and webhook secret itself (`services/github-app-manifest.ts`).
   Leave the organization empty for a personal account. Creating a new App replaces an existing
   one, so people who signed in with the old one sign in with GitHub again.
2. **Settings → GitHub → Your account → Connect GitHub.** An account that signs in by email code
   links its GitHub account here (any GitHub email), then installs the App. SAM needs each user's
   own GitHub authorization to start work on a GitHub project.

An account that GitHub sign-in created with an unconfirmed email (GitHub's emails API refused,
usually an App without Email addresses: read) is mailed "sign in with GitHub" instead of a code,
because redeeming a code would disconnect it from GitHub.

Code: `scripts/selfhost/mail-settings.ts` (SMTP settings, collector), `caddy/mail-collector/` and
`caddy/start.sh` (collector route), `scripts/selfhost/create-account.ts` (account command).

## Agent sign-in (test boxes)

A test box can let trusted SAM agents sign in as chosen accounts with a workload identity token
instead of an email code (public guide: `apps/www/src/content/docs/docs/guides/agent-sign-in.md`).
Put the trust on one line in `.state/secrets.env` and deploy:

```bash
AGENT_SIGN_IN_TRUST='{"issuer":"https://api.example.com/oidc","allowedSources":[{"projectId":"…","userId":"…"}],"allowedTargets":["<account id>"]}'
```

The deploy passes every `secrets.env` line to the Worker and rebuilds the whole Worker
configuration each time, so removing the line and deploying again switches it off. It applies the
`0234_agent_sign_ins` migration with the others. The key fetch to the issuer goes through the
guarded outbound fetch (public HTTPS only, no redirects), and the egress fence already allows the
public internet, so a public issuer needs no fence entry. Agents request the audience
`https://api.SAM_DOMAIN/api/auth/workload-identity-login`. The box needs an administrator account
first. Choose targets that are not administrators and not linked to real GitHub organizations.

## Machines for workspaces

Nodes come from a compute pool. A box with a platform cloud credential (for example the GCP
service account in Admin → Integrations) gives every account the installation pool; nobody needs
a cloud account of their own. Connecting the credential adds no machines: open
**Admin → Infrastructure** and add machine types and regions to the installation pool.

To create that credential's Google Cloud side in one step, run as a project owner with `gcloud`
logged in:

```bash
pnpm selfhost:gcp-bootstrap -- --project <gcp-project-id> --api-url https://api.<SAM_DOMAIN> --dry-run
pnpm selfhost:gcp-bootstrap -- --project <gcp-project-id> --api-url https://api.<SAM_DOMAIN>
```

It creates or reuses a workload identity pool for this install alone, an OIDC provider that admits
only tokens whose issuer is this install's API origin, and a `sam-nodes` service account with
`roles/compute.instanceAdmin.v1` and `roles/compute.securityAdmin` that the pool may impersonate.
It prints the five values for **Admin → Integrations → Google Cloud**. Re-running it changes
nothing; it refuses to retarget a provider that trusts another install
(`deploy/selfhost/gcp-bootstrap.sh`).

It records what it created (not what it found) in `.state/created-resources.json` (names,
project, time; no secrets; `--state-dir` to put it elsewhere). `--teardown` removes exactly those
resources and nothing else; see Removing what setup created.

Include at least one machine with 8 GB of memory. A default task asks for 2 vCPU, 4 GB of memory
and 15 GB of disk (`PLATFORM_RESOURCE_DEFAULTS` in
`packages/shared/src/constants/resource-defaults.ts`), and placement first subtracts a 1 GiB host
reserve from the machine's memory (`placement-resolver-capacity.ts`), so a 4 GB machine such as
Google Cloud `e2-medium` cannot hold one. With only `e2-medium` in the pool, every default task and
chat fails with "No eligible compute-pool offering is available in the installation default pool
for this task's requirements (2 vCPU, 4096 MB memory, 15 GB disk)". On Google Cloud add
`e2-standard-2` (2 vCPU, 8 GB); keep `e2-medium` for smaller work if you like.

## Backup, restore and upgrade

```bash
pnpm selfhost:backup                         # -> deploy/selfhost/backups/<UTC time>/ (mode 0700)
pnpm selfhost:restore --from <backup dir>    # into an EMPTY bucket and .state/ only
```

A backup is the fleet bucket (celld's only durable state), `.state/` (without the rebuildable
vm-agent build cache `.state/go-cache`) and `.env`: a live copy,
then celld stopped for the delta copy only, then restarted; the downtime is printed and kept in
`backup-manifest.json`. The live copy may fail on objects celld rewrites while it runs; that is
logged and the delta copy finishes it. The backup is exactly the bucket as celld left it when it
stopped, deletions included. The delta copy writes into a different directory than the live copy
did, so state an aborted `gcloud` pass left behind cannot break it; if the delta copy still
fails, the whole bucket is copied again into a fresh directory before celld restarts (longer
downtime, still recorded). gs:// buckets copy with `gcloud storage rsync`; s3:// buckets (the
bundled store too) with `mc mirror` from the pinned objectstore image. A backup of a sealed box
holds the sealed bundles but not the key file or key-service credentials, so their secrets cannot
be opened without the key kept apart. It still holds `.env`, `.state/gateway.env` and the
metadata-proxy and mail-collector secrets in plaintext, and the bucket's older deploy versions keep
whatever they were deployed with (`pnpm selfhost:secrets plaintext`). A backup of a
`legacy-plaintext` box, or one taken before the box was sealed, holds every Worker secret in
plaintext. Keep backups where only you can read them. Restore refuses a bucket that
holds objects or a `.state/` with platform keys, and leaves celld stopped: start it with the same
SAM checkout the backup recorded (`samCommit` in the manifest), never an older one. There is no
point-in-time recovery: a backup is the recovery point. Code: `scripts/selfhost/backup-lib.ts`.

`pnpm selfhost:upgrade --to <tag|branch|commit>` backs up (skip with `--skip-backup`), checks the
ref out, runs `pnpm selfhost:deploy --init`, restarts the stack only when a compose input changed
(a non-README file in this directory or a generated `.state/` file), runs `pnpm selfhost:deploy`
(D1 and Durable Object migrations, Worker), checks `/health` and prints the rollback: redeploy
the previous ref when no D1 migration ran, otherwise restore the pre-upgrade backup into an
empty bucket. Code: `scripts/selfhost/upgrade-lib.ts`. Use `--box-env` (not `--env-file`, which
Node takes) to point these commands at another `.env`.

## Removing an install

`pnpm selfhost:teardown` removes what this install created or helped create
(`scripts/selfhost/teardown.ts`). Run it on the box, with `gcloud` logged in as a project owner if
nodes ran in Google Cloud (the box VM's own account cannot delete VMs).

```bash
pnpm selfhost:teardown                                          # inventory: read only (the default)
pnpm selfhost:teardown --keep-data --dry-run                    # the plan, changes nothing
pnpm selfhost:teardown --keep-data --confirm <SAM_DOMAIN>
pnpm selfhost:teardown --remove-everything --dry-run
pnpm selfhost:teardown --remove-everything --confirm <SAM_DOMAIN> [--delete-backups] [--destroy-key]
```

The inventory lists every item, where it is (on the box, in the object store, in your cloud made by
the bootstrap, in your cloud made by SAM at runtime, outside SAM), how it is removed, and what each
mode does with it. Without `--confirm`, a terminal asks you to type the domain; anywhere else the
command refuses.

**What it cannot see.** A lookup that fails for any reason other than "not found" (for example the
box VM's own account, which may not read firewall rules, workload identity or KMS key metadata) is
listed as "could not check" and left for you, never read as absent. The Cloud KMS key the box seals
with (`.state/key-agent/choice.json`) is always listed; when the bootstrap ran elsewhere (Cloud
Shell), its record is there, so remove the key and the box's grant from there.

**What it may remove.** Only what `.state/created-resources.json` lists, or what it finds by the
exact names and labels the install itself sets, shown as "discovered, not recorded". The record is
written when things are created: `pnpm selfhost:deploy` (with or without `--init`) records the
installation id and domain, the compose project, `.state/`, `.env` and the bucket; every backup is
recorded when taken; `pnpm selfhost:gcp-bootstrap` records what it created. On an install from
before the record, run `pnpm selfhost:deploy --init` once (it changes nothing else) so the
installation id is recorded, and pass `--adopt-discovered` to remove bootstrap resources found by
name (each still proven by its issuer description or `sam-install` label).

**Proofs before a delete** (security review): the bucket is emptied only under its prefix, or when
the install created it; a bucket you brought with no SAM prefix is left for you with the command.
`.state/` is emptied only when it is recorded as this install's state or holds its keys, and never
when it is `/`, your home or contains the checkout. A backup is deleted only at an absolute path
holding a version-1 `backup-manifest.json`. Node VMs are touched only when the record names exactly
one installation id, for this `.env`'s domain.

**Order** (`teardown-model.ts`): 1. stop the stack (`docker compose stop`), so SAM starts no new
work or VMs; 2. node VMs; 3. cloud identity and keys (the bootstrap's own `--teardown`); 4. bucket
contents; 5. the box. If an item fails, later steps are not attempted (the identity that could still
delete a VM is kept), and running the same command again continues. Each removed item is marked
`removedAt` in the record, which teardown itself keeps as its receipt.

| Mode                  | Removes                                                                                                                                                | Keeps                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `--keep-data`         | node VMs and their disks; the bootstrap's pool, provider, node service account and its roles; containers                                               | bucket, volumes, images, `.state/` (bundles, key file), `.env`, backups, the KMS key and the box's grant on it, DNS, GitHub App |
| `--remove-everything` | the above, plus the KMS grant, every object under `CELLD_BUCKET`, compose volumes (the bundled store's bucket too) and built images, `.state/`, `.env` | the record, the key file and the KMS key (without `--destroy-key`), backups (without `--delete-backups`)                        |

Destructive flags, each only with `--remove-everything`:

- `--delete-backups` deletes the local backups (a directory is deleted only when it holds
  `backup-manifest.json`). A deleted backup can never be restored.
- `--destroy-key` deletes the key file (and a legacy `platform-keys.json`) and schedules
  destruction of the Cloud KMS key's versions (`gcp-bootstrap.sh --destroy-key-versions`). Every
  sealed bundle and every backup sealed with that key becomes unrecoverable. Cloud KMS destroys
  after 30 days by default (`gcloud kms keys versions restore` undoes it until then); run the
  teardown again after that to delete the key and its ring.

**Bringing a `--keep-data` install back:** `docker compose -f deploy/selfhost/docker-compose.yml up
-d`, then `pnpm selfhost:gcp-bootstrap` again. Google keeps a deleted workload identity pool for 30
days and its id cannot be reused until then, so within that window either undelete it
(`gcloud iam workload-identity-pools undelete sam-<hash> --location=global --project <id>`) or pass
a new `--pool-id` and enter the new values in Admin → Integrations. The app still lists the deleted
nodes: delete them in Admin → Nodes once it is up (the provider treats a VM that is already gone
as deleted: `deleteVM` in `packages/providers/src/gcp.ts`).

**Node VMs and their ownership proof** (`teardown-gcp.ts`): a VM is this install's only when its
labels `managed=simple-agent-manager`, `installation=<this install's id>` and `env=selfhost` all
match, the labels SAM's provider sets on every VM (`node-provider-labels.ts`). Right before the
delete it is described again and must still be the same VM (same id) with the same labels. Boot
disks go with the VM; a disk of that VM without auto-delete is deleted afterwards only when no other
VM uses it. Another install's VM is listed as refused and never touched.

**Left for you** (printed with the exact place or command, and listed in the summary):

- the firewall rules `sam-allow-agent` and `sam-allow-app-routes`: SAM's provider uses one fixed
  name per Google Cloud project for every install there, with no install identity on them, so
  teardown cannot prove they are this install's (`gcloud compute firewall-rules delete ...`);
- node VMs on any provider other than Google Cloud: delete the nodes in Admin → Nodes before
  teardown, or the servers labelled `managed=simple-agent-manager` and `installation=<id>` in the
  provider's console;
- the GitHub App made through Admin → Integrations: GitHub → Settings → Developer settings → GitHub
  Apps → the App → Advanced → Delete GitHub App;
- the DNS records (`*.SAM_DOMAIN`, and with inbound mail the MX record and the `sam-smtp-in` rule),
  the bucket itself when you created it, the machine, its service account and bucket grant, OAuth
  clients and SMTP credentials, and an AWS or Azure key (commands under Removing what setup
  created).

**Other clouds today:** the core (`teardown-model.ts`, `teardown-box.ts`) is cloud-neutral: an
AWS, Azure, Hetzner or bare-metal box gets the box, bucket (gs:// or s3://) and backup removal and
the full inventory. Only Google Cloud has an adapter for node VMs and a bootstrap teardown; on other
clouds those items are left for you with the console steps.

## Logs

Caddy writes one JSON access-log line per request, for every SAM host (`app.`, `api.`, `ws-*`,
`mail.`), to its stdout (`caddy/Caddyfile`). Each line has the host, method, path, protocol,
client address, status, response size and `duration` in seconds. For a WebSocket the duration is
the connection's lifetime and the line is written when the socket closes, so a hung or cut
connection shows up with its length. Caddy's own log (proxy errors, certificates) goes to stderr.

Neither log contains a header or a query string (`caddy/log-redaction.caddy`): cookies,
`Authorization`, SAM's `X-SAM-*` gateway headers and the gateway secret are dropped, and every
query string is replaced with `?<redacted>`, because terminal and port-access tokens and OAuth
codes travel there. Routes that carry a credential in the path (the AI proxy's workspace token,
bootstrap and invite tokens, signed preview URLs) have that segment replaced too; the list is in
`caddy/log-redaction.caddy` and must grow with any new route of that kind. Compose caps Caddy's log at about `CADDY_LOG_MAX_SIZE` x `CADDY_LOG_MAX_FILES`
(50 MB x 5). Anyone can add lines by sending requests, so a burst can rotate older lines away
before you read them.

On the box (the operator path is SSH; nothing here adds a listener):

```bash
cd deploy/selfhost
docker compose logs --since 30m caddy 2>/dev/null | grep http.log.access   # access log
docker compose logs --since 30m caddy | grep -v http.log.access            # Caddy's own log
docker compose logs --since 30m celld                                      # celld and Worker logs
```

Reading these without SSH needs something new, so this pass does not build it. Options, for a
later decision:

- **Cloud Logging (GCE boxes).** Docker's built-in `gcplogs` logging driver sends the caddy and
  celld logs to the box's own Google Cloud project, where an operator reads them with
  `gcloud logging read` under their own IAM. No new listener. It needs `roles/logging.logWriter`
  for the VM's service account and a viewer role for the operator, it is GCE-specific, and the
  logs leave the box. Cloud Logging read access is often granted more widely than access to the
  fleet bucket, and celld's log carries whatever Worker code logs, so decide who can read it
  before turning this on.
- **An admin-only SAM route.** Worker code on celld cannot read files or reach Docker, and the
  egress fence keeps it off loopback services on purpose. A route would need a new log service
  on the box that the fence lets celld reach, which is new attack surface for the most privileged
  code path on the box.

## Cold starts

On every 30 s pool tick celld retires one stateless Worker isolate that hosts no Durable Object
whenever no request is executing JavaScript at that instant (`REAP_INTERVAL` and
`celld_logic::isolate::retire` in celld 0.6.3; neither is configurable). A quiet box therefore has
no warm isolate, and the next request waits 1.5-2.4 s while a new one loads the bundle. As a
stopgap Caddy sends `GET /health` to celld every `SAM_KEEP_WARM_INTERVAL` (default `5s`, allowed
`1s`-`6s`) for as long as Caddy runs (`caddy/keep-warm/on.caddy`). A ping cannot prevent a
retirement, but the next ping pays the restart, so a user's request waits only if it arrives in
the window between a tick and the restarted isolate: about half the interval plus the restart
time, out of every 30 s. On the test box the first request after an idle spell went from 8 of 8
cold (1.5-1.7 s) to 1 of 14 cold. A shorter interval narrows the window a little; the restart
time does not change.

The check sits on a route that serves no request, so a failing `/health` cannot take the real
proxy out of service. `/health` reads no storage and is not in SAM's request log or Caddy's
access log. Each tick costs one isolate start (about 1.5 s of CPU every 30 s) whether or not
anyone is using the box. Set `SAM_KEEP_WARM=off` in `.env` and run `docker compose up -d caddy`
to turn it off. The upstream fix (celld keeping a warm stateless isolate, or a retirement
setting) is tracked in `tasks/backlog/2026-11-11-selfhost-celld-isolate-cold-start-slow-page-loads.md`.

**Aborted requests on a cold isolate.** celld 0.6.3 gives every async operation of a Worker (a
fetch, a D1 call, a timer) to the request that started it. When that request's client
disconnects, celld drops those operations without settling them. If Worker code shares one
in-flight promise between requests, every request that joined it would then wait until its own
client gave up or celld's 300 s handler budget ran out. Before task H2 the box saw outages of
about a minute under load. A slow cold start outlasted the timeout of a client (the keep-warm
check, the deploy health check, a monitoring probe), and the request that client dropped had
started the isolate's runtime-secrets load or a settings read.

The API Worker no longer joins another request's load unbounded:

- Each cold request fetches its own runtime secrets (`apps/api/src/selfhost/runtime-secrets.ts`).
- The settings caches, the platform-configuration cache and the ProjectData ensure memo wait on
  another request's read only until that read's own deadline plus a grace, then read for
  themselves (`apps/api/src/lib/shared-flight.ts`).
- A request that joined another's read also resumes on a timer of its own, never on the read's
  settlement. On celld the code that runs when a promise settles belongs to the request that
  settled it: a joiner that simply awaited the read ran the rest of its work as part of the other
  request, and celld dropped that work as soon as the other request answered, with no client
  disconnecting at all (task R6: authenticated requests still hung to the client cap). The celld
  entry module (`celld-main.ts`, generated by `scripts/selfhost/celld-project.ts` in both key
  modes) turns this on at startup; Cloudflare keeps resuming joiners directly.

`scripts/selfhost/live/shared-flight-cancel.live.test.ts` reproduces both hangs on celld 0.6.3.
New Worker code must not await a promise that another request started except through
`joinSharedFlight` / `settleSharedFlight`.

## Guided credential login (opt-in, experimental)

The "sign in with your Claude / ChatGPT subscription" button runs the provider's CLI in a Sandbox
SDK container (`SandboxDO`, `apps/api/Dockerfile.sandbox`). celld's experimental container support
runs it on this box. Off by default; pasting `claude setup-token` output or `auth.json` works
either way. Instant sessions stay off: their vm-agent must call the API on this box, and the
deployment declares `CONTAINER_RUNTIME_AVAILABLE=false` for them whatever the switches say.

```bash
sudo apt-get install runsc && sudo runsc install && sudo systemctl restart docker   # gVisor
# .env:
SAM_GUIDED_LOGIN=on
DOCKER_SOCKET_GID=<stat -c %g /var/run/docker.sock>
COMPOSE_FILE=docker-compose.yml:docker-compose.guided-login.yml
pnpm selfhost:deploy --init && (cd deploy/selfhost && docker compose up -d) && pnpm selfhost:deploy
```

- Run compose from `deploy/selfhost` without `-f`. An explicit `-f docker-compose.yml` replaces
  `COMPOSE_FILE`, so a container recreated that way loses the override and celld its
  `DOCKER_HOST`: every guided login then fails at once with `sandbox_provision_failed`
  (celld logs `no container engine`). `selfhost:upgrade`, `selfhost:backup`, `selfhost:secrets`
  and `selfhost:verify-fence` pass every file `COMPOSE_FILE` lists (`composeFilesFor`,
  `scripts/selfhost/backup-lib.ts`).

- The deploy emits a `containers` entry for `SandboxDO` only, with `runtime` gVisor (`runsc`;
  `SAM_GUIDED_LOGIN_RUNTIME`) and instance type `basic` (1 GiB, 1/4 vCPU;
  `SAM_GUIDED_LOGIN_INSTANCE_TYPE`), and builds the 2.3 GB image into the fleet bucket. It refuses
  to deploy when Docker or the runtime is missing (`assertContainerEngineReady`): without them
  every session fails only after about 2.5 minutes.
- celld never holds the Docker socket, which is root on this host. The compose override adds
  `docker-proxy` (no network, read-only, no capabilities, its own uid in the docker group) and
  gives celld only the proxy's socket. The proxy allows exactly the Engine API calls celld 0.6.3
  makes for its containers, in their exact shapes, and forwards a body rebuilt from the checked
  fields (`docker-proxy/policy.ts`). Its policy, `.state/docker-proxy/policy.json`, is written by
  `pnpm selfhost:deploy`: the sandbox and fence images by content reference (the deploy builds
  both, then checks `celld deploy` tagged the same ones), the runtime, the instance type's memory
  and CPU, and the hash of celld's fence rules. Refusals are logged by `docker compose logs
docker-proxy` (method, path, reason; never a body).
- What a compromised celld can still do through the proxy: start, exec into and remove sandbox
  containers of the deployed image under `runsc` (no capabilities, celld's fenced bridges,
  bounded memory, CPU and PIDs); run celld's own fence container (host network and `NET_ADMIN`,
  but only the pinned image, command and ruleset); create or remove celld's two bridges. What it
  cannot do (each tested against a real daemon in `scripts/selfhost/live/docker-proxy.live.test.ts`):
  start a privileged container, bind or mount any host path, use host networking, a capability, a
  device or a host namespace, use another image or runtime, read, exec into, stop or remove any
  container that is not one of its sandboxes, load, pull, build, tag or commit an image, or reach
  any other endpoint. The sandbox resolver file is bound from `.state/docker-proxy/`, not from
  celld's data dir, so a symlink there cannot expose a host file. The deploy builds the images
  on the box, so celld never loads one: if `docker image prune -a` removes them, sign-in fails at
  once with `sandbox_runtime_unavailable` until the next `pnpm selfhost:deploy`.
- Leftover sandboxes: celld gets a new node id each time it starts and reaps only its own, so the
  proxy removes every other celld sandbox when celld reaps; and every minute it removes sandboxes
  older than `SAM_DOCKER_PROXY_MAX_SANDBOX_AGE_SECONDS` (default 1800; a setup session lives at
  most 15 minutes, so raise both together). A celld restart ends any sign-in in progress: cancel
  it in the UI and start again.
- A container start that can never succeed (runtime not registered, proxy refusal, image gone)
  fails the session within seconds as `sandbox_runtime_unavailable` (1.5 s measured with `runsc`
  unregistered, previously 137 s)
  (`apps/api/src/services/sandbox-startup-errors.ts`) instead of after the SDK's ~2.5 minutes of
  start retries. A cancelled, expired or failed session marks its D1 row terminal before any
  sandbox call, so a retry is never blocked by a session whose teardown was interrupted.
- Concurrent sessions are capped by `MAX_CONCURRENT_SETUP_SESSIONS` (default 2), so the
  sandboxes commit at most 2 GiB by default. That cap lives in the Worker; the proxy holds its own
  (`SAM_DOCKER_PROXY_MAX_CONTAINERS`, default 4 celld containers at once, counted and created one
  at a time), gives every celld container a 1 MB log, and removes anonymous volumes with the
  container, so a compromised celld cannot exhaust memory or disk through sandboxes either.
- Sandboxes reach the Internet and nothing on the box, the VPC, private ranges or metadata.
  celld installs rules for that with its fence container, but nothing makes celld run it, so SAM's
  `egress-fence` service (root, re-applied every 5 s) holds the same boundary itself: chains
  `sandbox_input` and `sandbox_forward` on `celld0`/`celld1` in `.state/egress-fence.nft`
  (`renderSandboxChains` in `scripts/selfhost/egress-fence.ts`). It does not stop the box's own public address: the container reaches
  SAM's public HTTPS like any Internet client. SAM's egress fence lets celld (uid 7101) reach the
  container bridge `celld0` (TCP only) and nothing else in 172.16/12.
- The container runs a pinned vendor CLI and holds the fresh credential until the DO reads and
  stores it encrypted, on the same host as `ENCRYPTION_KEY`. gVisor puts a user-space kernel
  between that CLI and the host kernel. Use it only where the people who can sign in are trusted
  with the box (single trust domain).

Turning it off: remove `docker-compose.guided-login.yml` from `COMPOSE_FILE`, set
`SAM_GUIDED_LOGIN=off`, run `docker compose up -d --remove-orphans` (celld restarts without
the proxy socket) and `pnpm selfhost:deploy` (the Worker stops offering guided login).

Code: `scripts/selfhost/guided-login.ts`, `scripts/selfhost/docker-proxy-policy.ts`,
`docker-compose.guided-login.yml`, `docker-proxy/`, the `containers` rule in `celld-config.ts`,
`hasSandboxContainerRuntime` in `apps/api/src/services/platform-capabilities.ts`.

## Inbound agent email

Agent email gives each email trigger its own address, `agent+<key>@agents.SAM_DOMAIN`. Mail from
an allowed sender starts (or continues) work, and the agent answers with `reply_to_email`. On
Cloudflare that runs on Email Routing; on a box the `mail-in` profile runs **sam-mx**
(`deploy/selfhost/sam-mx`, Go, `emersion/go-smtp` + `go-msgauth` + `blitiri.com.ar/go/spf`, all
MIT), an SMTP receiver on port 25:

- It accepts `RCPT TO` only for agent addresses on `agents.SAM_DOMAIN` (it can never relay), one
  recipient per message, up to `SAM_MX_MAX_MESSAGE_BYTES` (5 MiB by default).
- It requires the From domain to be authenticated: SPF for the envelope sender or a DKIM
  signature, **aligned** with the From domain (DMARC pass). This is stricter than Cloudflare,
  which enforces only the policy a domain publishes, because the trigger's allowed-sender list
  compares From addresses.
- It hands each message, during the SMTP session, to the Worker on loopback
  (`POST /api/self-host/gateway/inbound-email`, authenticated with the gateway secret from
  `.state/gateway.env`; Caddy answers 404 for that path from the internet). The Worker runs the
  same handler as on Cloudflare and requires the From it parses to have the domain sam-mx
  authenticated. Its verdict becomes the SMTP reply: 250, 550 (unknown address, sender not
  allowed, too large, failed authentication) or 451 (SAM unreachable; the sender retries).
  Nothing is ever bounced, so a forged sender gets no backscatter.
- Limits: `SAM_MX_MAX_CONNECTIONS` (20), `SAM_MX_MAX_CONNECTIONS_PER_IP` (3, an IPv6 client counts
  as its /64), `SAM_MX_CONNECTIONS_PER_IP_PER_MINUTE` (30), `SAM_MX_MESSAGES_PER_CONNECTION` (10),
  `SAM_MX_MAX_SESSION` (15m), a 512 MB container memory limit, plus the Worker's own per-trigger
  hourly limit. Header blocks two parsers could read differently (`From :`, a repeated `From`,
  `Subject` or `Message-ID`, bare LF) are refused, a DKIM signature counts only if it signs
  `Subject` and `Message-ID`, and the Worker requires the From it parses to be exactly the address
  sam-mx authenticated.
- It runs as its own uid (`SAM_MX_UID`, 7102) with every capability dropped except binding port 25. It never sends mail: replies go through the Worker's SMTP relay (`SMTP_*`, or the mail
  collector on a test install), From `SMTP_FROM` with `Reply-To` set to the trigger's agent
  address and `In-Reply-To` and `References` set, so the sender's answer returns to the same
  trigger.

```bash
# .env: add the profile (off by default) next to an SMTP relay or the mail collector
COMPOSE_PROFILES=tunnel,mail-in
pnpm selfhost:deploy                      # sets AGENT_EMAIL_INBOUND_SMTP=true for the Worker
(cd deploy/selfhost && docker compose up -d --build sam-mx)
```

The deploy refuses `mail-in` without an SMTP transport for replies. For real mail the box also
needs:

- **DNS**: `agents.SAM_DOMAIN. MX 10 mx.SAM_DOMAIN.` The wildcard `*.SAM_DOMAIN` A record already
  points `mx.` at the box. No PTR record is needed to receive.
- **Firewall**: inbound tcp/25 to the box (GCP: a VPC ingress rule, for example
  `gcloud compute firewall-rules create sam-smtp-in --allow tcp:25 --target-tags <box tag>`).
  Outbound 25 is never used; GCP and Hetzner block it anyway.
- **Optional STARTTLS**: mount a certificate and key and set `SAM_MX_TLS_CERT` and
  `SAM_MX_TLS_KEY`. Without them senders deliver in plaintext.

Then create an email trigger in the app (Automation); its address and allowed senders show there.

**Smoke test without DNS** (from the box itself): add `SAM_MX_TRUSTED_NETWORKS=127.0.0.1/32` to
`.env` and `docker compose up -d sam-mx`. Mail from that network skips SPF/DKIM/DMARC (only
loopback networks are accepted there), so you can inject as an allowed sender:

```bash
swaks --server 127.0.0.1:25 --to 'agent+<key>@agents.SAM_DOMAIN' \
  --from you@example.com --header 'Subject: smoke test' --body 'Say hello by email.'
# 250 = SAM stored it and started the trigger; watch the task appear in the project.
# A sender outside the trigger's allowed list gets "550 5.7.1 Sender not allowed".
```

With the `mail-collector` profile on, the agent's `reply_to_email` lands in the collector at
`https://mail.SAM_DOMAIN`. Remove `SAM_MX_TRUSTED_NETWORKS` afterwards.

The celld egress fence needs no change: it matches celld's uid only, sam-mx calls celld (not the
other way round), and the fence still refuses the Worker any connection to port 25.

Code: `deploy/selfhost/sam-mx/` (receiver and its tests),
`apps/api/src/routes/self-host-gateway-inbound-email.ts` (gateway route),
`apps/api/src/services/agent-email/self-host-inbound.ts` (on-switch, SMTP reply sender),
`scripts/selfhost/inbound-mail-settings.ts` (deploy wiring).

## SAM-hosted repositories

Cloudflare Artifacts does not exist off Cloudflare, so the box serves SAM-native repositories from
its own git server: one `HostedGitRepo` Durable Object per repository, running the vendored dgit
core (`apps/api/src/vendor/dgit/`). The deploy turns it on (`ARTIFACTS_ENABLED=true`,
`HOSTED_GIT_BACKEND=durable-object` in `scripts/selfhost/celld-config.ts`); repositories live in the
fleet bucket like every other Durable Object, so the bucket backup covers them.

- Remote: `https://api.SAM_DOMAIN/git/<repo>.git`, served by the existing catch-all route (no Caddy
  fragment). Every request needs a SAM repository token as the HTTP Basic password (any username).
- Workspaces get a token bound to their workspace from `POST /api/workspaces/:id/git-token`; it stops
  working when the workspace stops. Only nodes created after this deploy attach it (VM agent change).
- People get a token from `POST /api/projects/:id/hosted-git/token` (`?scope=write` to push; project
  members only), then `git clone https://x:<token>@api.SAM_DOMAIN/git/<repo>.git`.
- Caps (code defaults in `apps/api/src/services/hosted-git/limits.ts`, chosen so each request fits
  celld's 300 s handler budget): 64 MiB per push, 30,000 objects and 256 MiB of storage per
  repository. A refused push says why in git's output (`remote: SAM: push refused: ...`). Importing a
  large existing history is not supported.
- No pull requests: agents push branches; review in SAM's repository browser and compare view.
- Smoke test: `scripts/selfhost/hosted-git-smoke.sh` (needs `SAM_DOMAIN` and an API token).

## Known gaps in this pass

- Off on purpose: Instant sessions (Cloudflare Containers; never on a box), guided credential login
  unless turned on (see Guided credential login), Analytics Engine, AI Gateway, the Workers AI model catalog and the
  stalled-task classifier (Clef; an admin may opt the advisory verdict on paused check-in loops
  into the LLM endpoint with `operations.stalledTaskClassifierEndpointAdvisory`). Agent email
  needs the `mail-in` profile (see Inbound agent email); the admin agent-email setup and loopback
  test remain Cloudflare-only. Projects can use a SAM-hosted repository (no GitHub
  or GitLab needed, see SAM-hosted repositories), a GitHub App or GitLab.
- The SAM agent, project agents, task titles and the diagnosis runner use an OpenAI-compatible
  endpoint: set it in Admin settings (`llm.openAICompatible.baseUrl`, `apiKey`, `model`, plus
  optional per-purpose models). The key is stored encrypted. Without an endpoint those features
  report that no model is available, and task titles fall back to the truncated prompt.
- The SAM AI proxy (`sam` provider mode for Claude Code / Codex, and server-side custom-endpoint
  keys) is off until an admin turns on `aiProxy.directUpstreamEnabled` and adds a Claude Code
  (and/or Codex) platform credential in Admin. Calls then go straight to api.anthropic.com /
  api.openai.com; rate limits, daily token budgets, the model allowlist and the tier gate apply as
  on Cloudflare, and SAM prices each call from its model price table so a user's monthly cost cap
  is enforced. Set a spend limit on the provider account too: SAM's figure is a list-price
  estimate.
- Voice transcription and server read-aloud answer `404 FEATURE_UNAVAILABLE` and the web UI hides
  the mic and server read-aloud, unless an admin sets `speech.transcription.*` /
  `speech.synthesis.*` to an OpenAI-compatible speech endpoint.
- `www.SAM_DOMAIN` answers 503 and the apex is not served; only the subdomains above are used.
- `VM_AGENT_TRANSPORT=reverse-tunnel` is set for the box: nodes run a pinned frpc that dials
  `wss://api.SAM_DOMAIN/~!frp` and is exposed on a leased loopback port (20000-29999 by default);
  frps asks the Worker to authorize every login, proxy, heartbeat and work connection. Node
  WebSockets go through Caddy forward_auth (`caddy/sam.d/node-ws.caddy`); plain HTTP to nodes
  stays on the Worker and is cut at `CELLD_FETCH_TIMEOUT_S`. The box needs a certificate nodes
  trust: frpc verifies it against the node's system CA store (`useSystemCa`) and refuses
  anything else (`pnpm selfhost:live-test` runs the real frpc against untrusted, wrong-host and
  trusted certificates). `SAM_TLS_MODE=internal` uses Caddy's private CA, which no node
  trusts, so internal mode supports no remote reverse-tunnel nodes; use a `dns-<provider>` mode.
- A released lease port is not reissued for twice the frps heartbeat timeout (180 s by default),
  so a new node's traffic cannot reach the previous holder's frpc. With every free port cooling
  down, provisioning fails with `port_range_cooling_down` and the time the first port frees up
  (at most that age away); with every port held, `port_range_exhausted`. The deploy refuses a
  lease range that contains any other box listener (celld, celld's operator port, frps, the
  bundled store, Caddy) or holds more than 20000 ports.
- When the deploy changes `.state/gateway.env` (heartbeat timeout, port range, gateway secret)
  it writes the file and stops before touching the Worker: run `docker compose up -d` so frps
  and Caddy load it, then `pnpm selfhost:deploy` again. frps reads `gateway.env` only at start,
  and the Worker must never assume values the running frps is not enforcing. After pulling a
  new release, run the deploy before restarting the stack: an older `gateway.env` can lack a
  variable the new `frps.toml` reads.

## Outbound requests and the egress fence

The Worker shares the host network, so without limits its `fetch` could reach every loopback
service (celld's unauthenticated operator listener, frps's control port, the object store and
its console), any private address, and the cloud metadata server. Two layers stop that:

1. The API checks every URL a user or admin chose before it calls it, and never lets the
   runtime follow a redirect (`apps/api/src/lib/network-hosts`). User URLs must be public HTTPS.
   An admin's OpenAI-compatible endpoint on this machine or its private network (a local model
   server) needs the `llm.openAICompatible.allowPrivateNetwork` admin setting; metadata and
   link-local addresses are refused either way. These checks see names, not DNS answers.
2. The egress fence holds whatever the Worker asks for. celld runs as `CELLD_UID` (7101), and
   the `egress-fence` service installs an nftables table, rendered into `.state/egress-fence.nft`
   by `pnpm selfhost:deploy`, that lets that uid reach only the public internet, the
   nameservers in `resolv.conf` on port 53, the node lease ports on 127.0.0.1, the object store
   endpoint celld uses (`S3_ENDPOINT`), the metadata token proxy, and Caddy's ports on the box's
   own non-loopback addresses. Everything else on the box (loopback, `127.0.0.2`, `::1`, the
   box's own addresses on any other port) and every private, link-local, metadata, reserved and
   IPv6 transition range (6to4, Teredo, NAT64, IPv4-compatible) is rejected. No setting can open
   a metadata, link-local or reserved address: the deploy refuses an `S3_ENDPOINT` that resolves
   to one, and any such `SAM_EGRESS_ALLOW` entry.

The `egress-fence` service re-applies the table within `SAM_EGRESS_FENCE_RECHECK_SECONDS` (5) if
it is missing or differs from the rendered rules, keeps the DNS rule equal to the nameservers in
`resolv.conf` (a resolver change does not cut celld off), and after every exact match writes an
attestation celld requires. celld's entrypoint (`celld/start.sh`) starts celld only when both
hold: a probe per rule class (celld's operator port on every local spelling, one private,
metadata, CGNAT and IPv6 range each) is refused, and the attestation is newer than
`SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS` (20). It repeats the check every
`SAM_EGRESS_FENCE_CHECK_SECONDS` (1) and SIGKILLs celld (no drain, which would let in-flight Worker
code keep connecting) when either fails; Docker restarts it and it waits for the fence again. A
reboot cannot bring celld up unfenced.

Worst-case unfenced window:

- Table removed (`nft flush ruleset`, a firewall reload): at most one check interval plus two
  probe rounds, about 1.2 s by default. Measured on celld 0.6.3: killed 0.12 to 0.76 s after the
  table was deleted (5 runs).
- A rule changed that the probes do not cover, with the fence service running: re-applied within
  its recheck interval (5 s).
- The same with the fence service stopped: celld is killed once the attestation is older than
  its limit (20 s). Stopping the fence service therefore stops celld after 20 s.

Check it after install, after a firewall change, or any time:

```bash
pnpm selfhost:verify-fence             # exits 1 and lists every gap if the fence is not in effect
```

It probes from celld's uid on the host network and repeats every probe as another uid. Each
forbidden target is probed over TCP and UDP: a UDP send the fence refuses fails with "Operation
not permitted", which only the local firewall produces, so a target the network would refuse
anyway still proves the fence. It also checks that celld can resolve a public name, that the
fence's DNS rule opens every nameserver celld uses, and that the attestation is current.
Ports 80 and 443 (`HTTP_PORT`/`HTTPS_PORT`) are open to celld on every non-loopback address of
this host, including Docker's bridge gateway (`172.17.0.1` on docker0), because Caddy listens on
all of them. The rule matches the port, not Caddy: any other service bound to one of those ports
on a specific local address (a VPN or LAN interface) is reachable from Worker code too. The
verifier probes the bridge gateway on celld's operator port, and the private 172.16/12 range at
an address that is not this host's own.

On GCE with a gs:// bucket, celld needs access tokens from the metadata server, which the fence
blocks. The `gce` profile runs a small proxy (`metadata-proxy/Caddyfile`) that serves only the
default service account's access token, only for GET with the `Metadata-Flavor` header, and only
under a random path prefix that is in celld's environment (`.state/celld.env`) and not in the
Worker's. Every other metadata path is 404.

The proxy does NOT narrow what the token can do on GCE. It asks for `GCE_METADATA_PROXY_SCOPES`
(default `devstorage.read_write`), but the GCE metadata server ignores the `scopes` parameter for
the default service account: on a real GCE VM with the `cloud-platform` access scope, a token
fetched through the proxy carried `cloud-platform` (checked with Google's tokeninfo on
2026-11-11; a direct metadata request with `?scopes=…devstorage.read_write` got `cloud-platform`
too). Such a token can do everything the VM's service account may do: on the test box that was read,
write and delete on every bucket in the project and Cloud DNS administration. The protection is
the path secret, so limit what that token is worth:

- Give the box its own service account, granted `roles/storage.objectAdmin` on the fleet bucket
  only (a bucket-level binding, not a project role), plus Cloud DNS rights on the install's zone
  only when `SAM_TLS_MODE=dns-googleclouddns` (Caddy uses the same identity for DNS-01). Even
  that minimum is read, write and delete on the whole control-plane datastore and every deployed
  Worker secret. `roles/storage.objectUser` lacks only object ACL/IAM rights; it has not been
  tested with celld.
- Do not give that account rights on any other bucket, such as backups or hand-off buckets.
- Optionally set the VM's access scopes to `devstorage.read_write` (plus
  `ndev.clouddns.readwrite` for DNS-01) instead of `cloud-platform`. Changing scopes needs the VM
  stopped.

Caddy's DNS-01 renewals use the metadata server directly (Caddy is not fenced).

Worker code cannot read the secret path. Verified on celld 0.6.3 with `nodejs_compat`, locally and
on the real GCE box with a gs:// bucket, from code deployed into the Worker: `process.env`
is an empty stub, `node:fs` is a virtual filesystem (`/proc/self/environ`, `/etc/passwd` and `/`
are not found), `node:os` returns placeholders, there is no `child_process`, and `file://` fetches
fail. celld's own log does not contain it at `RUST_LOG=info` or `debug`; it appears in celld's error
output when the proxy is unreachable (after a redeploy or a proxy crash). Whether a storage error
that reaches Worker code carries that chain is untested for gs:// (with an unreachable S3 store a
Worker saw only `Error: write s3://...`). If one ever did, and the error reached a user, that
user could make the Worker fetch a token through the proxy and send it anywhere (the fence allows
the public internet): the token can do whatever the service account may do (see above). The proxy
refuses everything when its secret is missing or malformed.

What the fence cannot separate: Worker code and celld's storage client are one process. A
Worker can reach the object store endpoint (without the fleet credential it gets nothing; the
bundled store denies anonymous access) and the token proxy port. The deploy refuses a presign
credential (`R2_ACCESS_KEY_ID`) equal to the fleet credential, since the presign credential is a
Worker secret. That check catches a copied key only; it cannot prove a different key is scoped.

A local model server (the admin setting `llm.openAICompatible.allowPrivateNetwork`) is on a
private address the fence rejects. Allow exactly that address and port with `SAM_EGRESS_ALLOW`
in `.env` (for example `127.0.0.1:11434`), then `pnpm selfhost:deploy --init`; the fence service
picks up the re-rendered rules within `SAM_EGRESS_FENCE_RECHECK_SECONDS`. The deploy refuses an
entry that would open celld's, frps's or the store console's port on any local address.

A self-managed GitLab on this machine or the private network (`integration.gitlab.host`, for
example `https://gitlab.example.lan` resolving to 10.0.0.5) is refused for sign-in and API calls
until an admin turns on `integration.gitlab.allowPrivateNetwork` (Admin, Settings, OAuth); sign-in
with it is not offered until then. The fence still rejects the address: add it to
`SAM_EGRESS_ALLOW` (for example `10.0.0.5:443`) and run `pnpm selfhost:deploy --init`, as for a
local model server. SAM never follows a redirect from GitLab to another private host. The host
must be HTTPS (plain HTTP is accepted only for `localhost`), and celld's TLS client trusts only
public certificate authorities, so a private GitLab needs a publicly trusted certificate.

Other limits: the loopback lease range (20000-29999 by default) is open to celld, so do not run
other services on those ports. The start check probes the box's own addresses as they were at
`pnpm selfhost:deploy --init`; if a public address on the NIC changes, celld stops (fail closed)
until you run it again. Docker user-namespace remapping changes the host uid the fence
must match; it is not supported (celld then refuses to start). A refused TCP connection fails
after about a second (the kernel reports the reject on the first SYN retransmit), not at once.

## Code

- `scripts/selfhost/celld-config.ts`: translates `apps/api/wrangler.toml` to celld's
  `wrangler.json` and fails on any key it has no rule for.
- `scripts/selfhost/deploy.ts`: the deploy and upgrade flow above.
- `caddy/sam.d/` and `frps/frps.toml`: node-transport routes and config (reverse tunnel).
- `scripts/selfhost/egress-fence.ts`, `egress-fence/`, `celld/start.sh`, `metadata-proxy/`: the
  egress fence; `scripts/selfhost/verify-fence.ts`: `pnpm selfhost:verify-fence`.
