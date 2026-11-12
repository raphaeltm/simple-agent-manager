# One-box SAM control plane on celld

Status: integration branch work (self-host pass 2). Not a supported install path yet.

The SAM API Worker and web UI run on [celld](https://celld.dev) behind Caddy on one machine,
with no Cloudflare account. Nodes reach the box through frps (the reverse-tunnel transport).
Instant sessions, Workers AI features, Analytics Engine and Artifacts are off; guided
credential login is opt-in (see Guided credential login). Email sign-in works
through an SMTP relay or, on a test install, the bundled mail collector (see Email sign-in below).

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

Profile `mail-collector` (off by default, test installs only) adds `mail-collector`: Mailpit on
`127.0.0.1:1025` (SMTP) and `127.0.0.1:8025` (UI, published at `mail.SAM_DOMAIN`). See Email sign-in.

## Install or upgrade

Needs Docker with Compose v2.20+, Node 22+ and pnpm, and a checkout of this repository.

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env && chmod 600 deploy/selfhost/.env
$EDITOR deploy/selfhost/.env           # SAM_DOMAIN, TLS mode, bucket
pnpm install
pnpm selfhost:deploy --init            # platform keys, gateway.env, egress fence files
docker compose -f deploy/selfhost/docker-compose.yml up -d
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
`deploy/selfhost/.state/secrets.env` (`NAME=value`, mode 600). Platform keys are generated into
`.state/platform-keys.json` and never regenerated: back up `.state/` and the bucket.

celld has no secrets store for real nodes. `pnpm selfhost:deploy` renders secrets into the
Worker's `vars` for `celld deploy` only and leaves a secrets-free `wrangler.json` behind, but
celld keeps every deployed version's vars in plaintext under `deploy/` in the fleet bucket. The
bucket credential is therefore the root secret of the install.

Plaintext copies of the Worker secrets live in: the bucket's `deploy/` manifests (every
deployed version), the `celld-data` volume cache, the celld process, and `.state/` on the box.
`REVERSE_TUNNEL_GATEWAY_SECRET` is also in `.state/gateway.env` and the Caddy and frps container
environments (`docker inspect` shows it). Keep the operator out of the `docker` group unless they
are trusted with all of it.

Presigned browser uploads go straight to the fleet bucket. Set `R2_S3_ENDPOINT` in `.env` and a
credential scoped to `<bucket>/<prefix>/r2/<R2 bucket>/*` as `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` in `secrets.env`, never the fleet credential. The deploy derives the
bucket and key prefix. The bundled store has no public `s3.` route yet, so leave it unset there.

Plain Worker var overrides (for example turning one of the self-host switches back on) also go in
`secrets.env`; it is merged last. `--dry-run` prints the rendered config with those values
redacted.

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
docker compose -f deploy/selfhost/docker-compose.yml up -d
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

Code: `scripts/selfhost/mail-settings.ts` (SMTP settings, collector), `caddy/mail-collector/` and
`caddy/start.sh` (collector route), `scripts/selfhost/create-account.ts` (account command).

## Machines for workspaces

Nodes come from a compute pool. A box with a platform cloud credential (for example the GCP
service account in Admin → Integrations) gives every account the installation pool; nobody needs
a cloud account of their own. Connecting the credential adds no machines: open
**Admin → Infrastructure** and add machine types and regions to the installation pool.

Include at least one machine with 8 GB of memory. A default task asks for 2 vCPU, 4 GB of memory
and 15 GB of disk (`PLATFORM_RESOURCE_DEFAULTS` in
`packages/shared/src/constants/resource-defaults.ts`), and placement first subtracts a 1 GiB host
reserve from the machine's memory (`placement-resolver-capacity.ts`), so a 4 GB machine such as
Google Cloud `e2-medium` cannot hold one. With only `e2-medium` in the pool, every default task and
chat fails with "No eligible compute-pool offering is available in the installation default pool
for this task's requirements (2 vCPU, 4096 MB memory, 15 GB disk)". On Google Cloud add
`e2-standard-2` (2 vCPU, 8 GB); keep `e2-medium` for smaller work if you like.

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
pnpm selfhost:deploy --init && docker compose up -d && pnpm selfhost:deploy
```

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
- A container start that can never succeed (runtime not registered, proxy refusal, image gone)
  fails the session within seconds as `sandbox_runtime_unavailable`
  (`apps/api/src/services/sandbox-startup-errors.ts`) instead of after the SDK's ~2.5 minutes of
  start retries. A cancelled, expired or failed session marks its D1 row terminal before any
  sandbox call, so a retry is never blocked by a session whose teardown was interrupted.
- Concurrent sessions are capped by `MAX_CONCURRENT_SETUP_SESSIONS` (default 2), so the
  sandboxes commit at most 2 GiB by default.
- celld's own fence lets the container reach the Internet and nothing on the box, the VPC,
  private ranges or metadata. It does not stop the box's own public address: the container reaches
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

## Known gaps in this pass

- Off on purpose: Instant sessions (Cloudflare Containers; never on a box), guided credential login
  unless turned on (see Guided credential login), Artifacts
  (SAM-native repos), Analytics Engine, AI Gateway, Workers AI features (TTS, task titles,
  stalled-task classifier), agent email (inbound mail and replies; sign-in codes work over SMTP).
  Project creation needs a GitHub App or GitLab.
- Without Cloudflare, voice transcription, server read-aloud and the Workers AI model catalog
  answer `404 FEATURE_UNAVAILABLE`, and the web UI hides the mic and server read-aloud. The SAM
  agent, project agents, task titles and the diagnosis runner need an OpenAI-compatible endpoint:
  set it in Admin settings (`llm.openAICompatible.baseUrl`, `apiKey`, `model`, plus optional
  per-purpose models). The key is stored encrypted. Without an endpoint those features report that
  no model is available, and task titles fall back to the truncated prompt.
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
