# One-box SAM control plane on celld

Status: integration branch work (self-host pass 2). Not a supported install path yet.

The SAM API Worker and web UI run on [celld](https://celld.dev) behind Caddy on one machine,
with no Cloudflare account. Nodes reach the box through frps (the reverse-tunnel transport).
Instant sessions, Workers AI features, Analytics Engine, Artifacts and email sign-in are off.

## What runs

| Service       | Network | Listens on                      | Notes                                                    |
| ------------- | ------- | ------------------------------- | -------------------------------------------------------- |
| `caddy`       | host    | `:80`, `:443`                   | wildcard `*.SAM_DOMAIN`, sets `CF-Connecting-IP`         |
| `celld`       | host    | `127.0.0.1:8080`, `:7001` (ops) | API Worker + web UI (`ASSETS`), cron triggers            |
| `frps`        | host    | `127.0.0.1:7000`                | profile `tunnel`; nodes arrive as frp over wss via Caddy |
| `objectstore` | host    | `127.0.0.1:9000`                | profile `local-store`; otherwise use a GCS/S3 bucket     |

## Install or upgrade

Needs Docker with Compose v2.20+, Node 22+ and pnpm, and a checkout of this repository.

```bash
cp deploy/selfhost/.env.example deploy/selfhost/.env && chmod 600 deploy/selfhost/.env
$EDITOR deploy/selfhost/.env           # SAM_DOMAIN, TLS mode, bucket
pnpm install
pnpm selfhost:deploy --init            # platform keys + .state/gateway.env, once
docker compose -f deploy/selfhost/docker-compose.yml up -d
pnpm selfhost:deploy                   # build web, migrate, deploy; re-run to upgrade
```

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
- The Worker shares the host network, so its outbound `fetch` can reach loopback services
  (celld's operator listener, the bundled store, frps) and, on GCE, the metadata server. There
  is no egress fence yet.

## Code

- `scripts/selfhost/celld-config.ts`: translates `apps/api/wrangler.toml` to celld's
  `wrangler.json` and fails on any key it has no rule for.
- `scripts/selfhost/deploy.ts`: the deploy and upgrade flow above.
- `caddy/sam.d/` and `frps/frps.toml`: node-transport routes and config (reverse tunnel).
