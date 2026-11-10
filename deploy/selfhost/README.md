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
uid 7101; `celld-data-owner` re-owns its data volume on the way.

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
  frps asks the Worker to authorize every login, proxy and heartbeat. Node WebSockets go through
  Caddy forward_auth (`caddy/sam.d/node-ws.caddy`); plain HTTP to nodes stays on the Worker and is
  cut at `CELLD_FETCH_TIMEOUT_S`. The box needs a certificate nodes trust (frpc verifies it).

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
   `resolv.conf` nameservers on port 53, the node lease ports on 127.0.0.1, the object store
   endpoint celld uses (`S3_ENDPOINT`), the metadata token proxy, and Caddy's ports. Everything
   else on the box and every private, link-local and metadata range is rejected. The service
   re-applies the table if a firewall reload removes it. celld's entrypoint (`celld/start.sh`)
   will not start celld until a connection to its own operator port is rejected, so a reboot
   cannot bring celld up unfenced.

Check it after install, after a firewall change, or any time:

```bash
pnpm selfhost:verify-fence             # exits 1 and lists every gap if the fence is not in effect
```

It probes from celld's uid on the host network (every forbidden target must be rejected at once,
every allowed one must not) and repeats one forbidden probe from another uid as a control.

On GCE with a gs:// bucket, celld needs access tokens from the metadata server, which the fence
blocks. The `gce` profile runs a small proxy (`metadata-proxy/Caddyfile`) that serves only the
service-account token and email, only with the `Metadata-Flavor` header, and only under a random
path prefix that is in celld's environment (`.state/celld.env`) and not in the Worker's. Worker
code can reach the proxy port, as celld can, but not that path. Give the VM's service account
access to the fleet bucket only.

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

Other limits: the loopback lease range (20000-29999 by default) is open to celld, so do not run
other services on those ports. Nameservers come from `/etc/resolv.conf` when the deploy runs;
re-run `pnpm selfhost:deploy --init` if they change. celld's entrypoint re-checks the fence every
`SAM_EGRESS_FENCE_CHECK_SECONDS` (5) and stops celld if it is gone (measured: celld stopped
admitting requests 0.6 s after the table was deleted, then drains in-flight work before exiting;
it now acts on two consecutive failed checks, so within 10 s by default). Docker user-namespace
remapping changes the host uid the fence must match; it is not supported (celld then refuses to
start).

## Code

- `scripts/selfhost/celld-config.ts`: translates `apps/api/wrangler.toml` to celld's
  `wrangler.json` and fails on any key it has no rule for.
- `scripts/selfhost/deploy.ts`: the deploy and upgrade flow above.
- `caddy/sam.d/` and `frps/frps.toml`: node-transport routes and config (reverse tunnel).
- `scripts/selfhost/egress-fence.ts`, `egress-fence/`, `celld/start.sh`, `metadata-proxy/`: the
  egress fence; `scripts/selfhost/verify-fence.ts`: `pnpm selfhost:verify-fence`.
