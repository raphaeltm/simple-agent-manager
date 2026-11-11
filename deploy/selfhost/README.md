# One-box SAM control plane on celld

Status: integration branch work (self-host pass 2). Not a supported install path yet.

The SAM API Worker and web UI run on [celld](https://celld.dev) behind Caddy on one machine,
with no Cloudflare account. Nodes reach the box through frps (the reverse-tunnel transport).
Instant sessions, Workers AI features, Analytics Engine, Artifacts and email sign-in are off.

## What runs

| Service              | Network | Listens on                      | Notes                                                    |
| -------------------- | ------- | ------------------------------- | -------------------------------------------------------- |
| `caddy`              | host    | `:80`, `:443`                   | wildcard `*.SAM_DOMAIN`, sets `CF-Connecting-IP`         |
| `celld`              | host    | `127.0.0.1:8080`, `:7001` (ops) | API Worker + web UI (`ASSETS`), cron triggers; uid 7101  |
| `egress-fence`       | host    | none                            | installs and keeps the celld nftables egress fence       |
| `gce-metadata-proxy` | host    | `127.0.0.1:7180`                | profile `gce`; access tokens for a gs:// bucket          |
| `frps`               | host    | `127.0.0.1:7000`                | profile `tunnel`; nodes arrive as frp over wss via Caddy |
| `objectstore`        | host    | `127.0.0.1:9000`                | profile `local-store`; otherwise use a GCS/S3 bucket     |

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

## Known gaps in this pass

- Off on purpose: Instant sessions and guided credential login (Cloudflare Containers), Artifacts
  (SAM-native repos), Analytics Engine, AI Gateway, Workers AI features (TTS, task titles,
  stalled-task classifier), email sign-in. Project creation needs a GitHub App or GitLab.
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

On GCE with a gs:// bucket, celld needs access tokens from the metadata server, which the fence
blocks. The `gce` profile runs a small proxy (`metadata-proxy/Caddyfile`) that serves only the
default service account's access token, only for GET with the `Metadata-Flavor` header, and only
under a random path prefix that is in celld's environment (`.state/celld.env`) and not in the
Worker's. Every other metadata path is 404. Whatever scope the caller asks for, the token is
scoped to Cloud Storage (`GCE_METADATA_PROXY_SCOPES`, default `devstorage.read_write`; only Cloud
Storage scopes are accepted), so it cannot call Cloud DNS even when the VM's service account can.
The scope limits the API, not the bucket: the token reaches every bucket the service account has
IAM access to, so grant that account the fleet bucket only. Caddy's DNS-01 renewals use the
metadata server directly (Caddy is not fenced) and keep the VM's own scopes.

Worker code cannot read the secret path. Verified on celld 0.6.3 with `nodejs_compat`: `process.env`
is an empty stub, `node:fs` is a virtual filesystem (`/proc/self/environ`, `/etc/passwd` and `/`
are not found), `node:os` returns placeholders, there is no `child_process`, and `file://` fetches
fail. celld's own log does not contain it either at `RUST_LOG=info` or `debug`; it appears only in
celld's error output when the proxy is unreachable (operator-visible, never Worker-visible).

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
example `http://10.0.0.5`) is refused for sign-in and API calls until an admin turns on
`integration.gitlab.allowPrivateNetwork` (Admin, Settings, OAuth); sign-in with it is not offered
until then. The fence still rejects the address: add it to `SAM_EGRESS_ALLOW` (for example
`10.0.0.5:443`) and run `pnpm selfhost:deploy --init`, as for a local model server. SAM never
follows a redirect from GitLab to another private host, and celld's TLS client trusts only public
certificate authorities, so a private GitLab must serve a publicly trusted certificate or plain
HTTP on the private network.

Other limits: the loopback lease range (20000-29999 by default) is open to celld, so do not run
other services on those ports. Docker user-namespace remapping changes the host uid the fence
must match; it is not supported (celld then refuses to start). A refused TCP connection fails
after about a second (the kernel reports the reject on the first SYN retransmit), not at once.

## Code

- `scripts/selfhost/celld-config.ts`: translates `apps/api/wrangler.toml` to celld's
  `wrangler.json` and fails on any key it has no rule for.
- `scripts/selfhost/deploy.ts`: the deploy and upgrade flow above.
- `caddy/sam.d/` and `frps/frps.toml`: node-transport routes and config (reverse tunnel).
- `scripts/selfhost/egress-fence.ts`, `egress-fence/`, `celld/start.sh`, `metadata-proxy/`: the
  egress fence; `scripts/selfhost/verify-fence.ts`: `pnpm selfhost:verify-fence`.
