---
title: App Deployments
description: Put your app on the internet. Create an environment, let agents deploy to it, see what's running, and fix what goes wrong. Also covers the Docker Compose format agents publish.
---

SAM app deployments are agent-first: you create an environment and decide which agents may deploy
to it, and an agent ships your app there when you ask. You don't run Docker or touch a server.

## Put your app online

1. Open the project and select **Deployments**, then **New environment** (or **New** once you have
   one).
2. Name it, for example `staging` (lowercase letters, numbers and dashes). Nothing runs, and nothing
   costs money, until an agent deploys to it.
3. Under **Which agents can deploy here?**, choose **Any agent in this project** (good for previews
   and staging), **Only some agent profiles** (good for production; then pick at least one), or
   **Nobody yet** (turn it on later from the environment). Select **Create environment**.
4. On the environment's page, select **Ask an agent to deploy**. A new chat opens with the request
   already written; pick the profile and send it. You can also just ask in any chat, for example
   "deploy this to staging".
5. Watch **Recent deploys**: the newest version lists the steps the server reports as it goes. When
   it's **Live**, select **Open app**.

Owners and admins create environments, choose who can deploy, and pause, start or delete them.
Everyone in the project sees the same buttons, but for other members SAM refuses those changes with
"Project capability is required".

## The Deployments page

A project's **Deployments** page lists its environments grouped by what they need from you: **Needs your attention**, **Running**, and **Not running**. Each row shows the address people visit (your own domain when one is working) and who shipped the newest version, with **Open** for an app that's up or **Ask an agent** for a problem an agent can fix.

Opening an environment shows one page, top to bottom:

- **Status in one sentence**, the address with **Open app** and **Logs**, and who shipped the running version from which chat. A deploy in progress says the app is offline until the new version is up, because the server stops the old version before starting the new one.
- **Needs your attention**: each problem in plain words, the raw error under **Show the error**, and its fix (see the table below). **Ask an agent** opens a new chat with a request about this environment already written; you choose the agent and send it.
- **Recent deploys**: every version, who sent it, and the chat it came from (four at first, **Show all** for the rest). While the newest version deploys, or after it fails, it lists the steps the server reported, including which step broke and whether the previous version came back.
- **Who can deploy**: turning agent deploys on asks you to choose **Any agent in this project** or named agent profiles. Nothing changes until you choose, and an **Only these** list with nobody picked shows a warning, because an empty list means any agent may deploy.
- **Settings your app reads** (variables and secrets), **Addresses** (public routes and your own domains), **Saved data** (volumes), and **Behind the scenes** (the server, its hardware, containers and raw signals).
- **Pause or delete** at the bottom. Delete lists what it removes and asks you to type the environment name.

The page refreshes every few seconds while something is changing.

### Problems and their fixes

| Problem                                    | Fix buttons                              |
| ------------------------------------------ | ---------------------------------------- |
| "Version N didn't start"                   | **Ask an agent to fix it**, **See logs** |
| "SAM couldn't get a server for version N"  | **Ask an agent to deploy again**         |
| "Starting didn't finish"                   | **Start again**                          |
| "Pausing didn't finish"                    | **Pause again**, **See the server**      |
| "The server hasn't checked in for N hours" | **See the server**                       |
| A part of the app isn't running properly   | **See logs**, **Ask an agent to fix it** |
| "&lt;your domain&gt; doesn't point here"   | **Check domains**                        |

When agent deploys are off for the environment, each **Ask an agent…** button reads **Let agents deploy here…** instead.

### What the deploy labels mean

| Label                    | Meaning                                                         |
| ------------------------ | --------------------------------------------------------------- |
| **Live**                 | The version that's running now                                  |
| **Deploying**            | On its way; the app is offline until it's up                    |
| **Didn't start**         | It failed; the steps show where                                 |
| **Skipped**              | A newer version arrived before a server picked this one up      |
| **Comes back on start**  | The version that runs again when you start a paused environment |
| **May still be running** | Pausing didn't finish, so it might still be up                  |
| (no label)               | An older version that was replaced                              |

## For agents: publishing a release

Agents can discover this whole flow at runtime by calling the `get_deployment_guide` MCP tool, which returns a briefing on the agent-first model and the order in which to call the deployment tools. It takes no arguments and is the recommended starting point whenever a user asks to deploy, launch, publish, ship, or release an app.

Publishing is a two-step, asynchronous flow:

1. `build_and_publish(environment, reference?, workingDir?)` starts a build/publish job on the SAM VM and immediately returns a durable `publishJobId`. The job builds the workspace's Docker Compose stack, pushes built service images with SAM-owned registry credentials, and records the release server-side. Agents never run docker or registry commands and never receive registry credentials.
2. `get_publish_status(publishJobId)` reports progress. Poll it until the status is terminal — `succeeded`, `failed`, `canceled`, or `unknown` — rather than retrying `build_and_publish` blindly.

After a successful publish, agents can verify runtime health with `read_deployment_logs(environment, ...)`.

`build_and_publish` requires the named deployment environment to be active — or in `error`, awaiting a recovery release — agent deployment to be enabled by a user, and the agent profile to satisfy that environment's policy. An environment that a previous release left in `error` stays available to agents precisely so the next release can recover it; environments that are starting, stopping, stopped, or being deleted are not agent-deployable.

Agents can preview route behavior before publishing with `preview_deployment_routes(environment, composeYaml)` and inspect the latest release's generated routes and custom domains with `list_deployment_routes(environment)`.

The release submission format is Docker Compose YAML with SAM extensions. SAM supports multi-service Compose stacks, preserves service topology including Docker Model Runner `provider:` services, and derives route hints from either `x-sam-routes` or compose service `ports:`. Compose long-syntax `ports:` entries with `mode: host` are treated as internal/private route hints; other `ports:` entries are public by default unless an explicit private `x-sam-routes` entry suppresses them.

```yaml
services:
  web:
    image: registry.example.com/my-project/web:v1.2.3
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      PUBLIC_APP_DOMAIN: ${PUBLIC_APP_DOMAIN}
      DATABASE_URL: ${DATABASE_URL}
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '0.50'
          memory: 512M

x-sam-routes:
  - service: web
    port: 3000
    mode: public
```

CPU and memory limits drive deployment placement. SAM sums the limits across services, reuses an
allowed deployment node when the aggregate reservation fits, and otherwise provisions the smallest
sufficient allowed offering. When a service omits the whole `deploy.resources` block, configurable
per-service CPU and memory defaults apply. If the block declares only one limit, Compose parsing uses
its compatibility fallback for the other limit (1 CPU or 512 MB). Placement also reserves a
configurable root-disk allowance per service and adds `x-sam-size-hint-mb` from named volumes.

Submit the file to the release endpoint with a YAML content type:

```http
POST /api/projects/:projectId/environments/:envId/releases
Content-Type: text/yaml
```

SAM accepts `application/yaml`, `text/yaml`, `application/x-yaml`, and `text/x-yaml`. Raw manifest JSON is still accepted for older callers, but Compose YAML is the authoring format.

Configure values on each deployment environment in its **Settings your app reads** section. Use **Add**, and turn on **Keep it secret** for a secret:

- **Variables** are visible after save. SAM supplies them to `build_and_publish` and to deployment-node Compose apply commands, so they can be used for image tags, build args, domains, and runtime environment values.
- **Secrets** are hidden after save. SAM supplies them only to deployment-node Compose apply commands as process environment for Compose interpolation. Secrets are not sent to build nodes and should not be used in build args, image tags, route fields, or other build/publish-control fields.

Compose interpolation only affects placeholders such as `${DATABASE_URL}`. It does not override literal Compose values like `NODE_ENV: production`.

`x-sam-secret` and older explicit secret references remain supported for compatibility, but new deployments should prefer normal Compose `${VAR}` placeholders backed by per-environment Variables and Secrets.

For compose-publish releases, `build_and_publish` supports safe named Docker Compose volumes when each service mount references a top-level named volume declaration. SAM creates missing provider-backed block volumes for those declarations and rewrites service mounts to SAM-managed volume roots before deployment apply. Host bind mounts, Docker socket mounts, anonymous volumes, undeclared named volumes, `volumes_from`, `tmpfs`, external volumes, custom volume drivers, and driver options are rejected.

```yaml
services:
  web:
    image: registry.example.com/my-project/web:v1.2.3
    volumes:
      - data:/app/data

volumes:
  data:
    x-sam-size-hint-mb: 2048
```

Deployment machines run a restricted subset of Compose. Settings that would give a container power
over the machine itself, such as `privileged`, `cap_add`, `network_mode`, `devices`, and
`use_api_socket` (access to the Docker Engine API), aren't allowed: a release that includes one is
refused with a message naming the setting, and `build_and_publish` removes them from the services it
publishes. A deployment machine can host several of your environments, so this keeps one app from
reaching another.

Use `mode: host` for service ports such as databases, queues, and workers that should be reachable only inside the deployed Compose stack/private network. Public web/API entrypoints should use normal `ports:` entries or explicit public `x-sam-routes`.

If an app needs to know its public hostname before it starts, agents should preview routes before publishing and then write the returned URLs into deployment configuration. Common examples are Django `ALLOWED_HOSTS` / CSRF trusted origins, CORS origins, OAuth callback URLs, webhook callback URLs, and canonical app URL variables.

## Persistent volumes

Provider-backed block volumes give a deployment environment durable storage that survives container restarts and the stop/start lifecycle. They are real cloud block volumes created through the deployment environment's provider and attached to the deployment node.

- Volumes are created automatically from safe Compose named volume declarations during `build_and_publish`. They can also be created, viewed, and deleted in the environment's **Saved data** section, and attached or detached by hand under **Behind the scenes**.
- Each volume is mounted at a SAM-managed path derived from the environment id, and the deployment apply payload tells the node which provider volume to mount where.
- All volumes in one environment must share the same provider **and** the same location. A single VM can only attach volumes that live in its own provider/location, so an environment that mixes providers or regions is rejected before a node is provisioned.
- When an environment has volumes (or is marked as requiring volumes), provisioning is pinned to the volumes' provider and location so the node lands where the volumes can attach.
- The provider must support first-class block volumes. **Hetzner, Scaleway, Vultr, Infomaniak, DigitalOcean, and UpCloud are supported; GCP deployment volumes are not** (`volumeCapabilities.supported` is `false` for the GCP provider), so a GCP-backed environment cannot use persistent deployment volumes. Vultr uses high-performance NVMe Block Storage, which is only offered in a subset of Vultr regions, so a Vultr-backed environment with volumes is pinned to a Block-Storage-capable region. DigitalOcean Block Storage is same-region and uses a deterministic `/dev/disk/by-id/scsi-0DO_Volume_<name>` device path.

## Stop and start lifecycle

A deployment environment can be stopped to release its compute while preserving its volumes and release history, then started again later. In the app this is **Pause** and **Start** at the bottom of the environment page.

- **Stop** tears down the running Compose stack on the node, detaches the environment's provider volumes (the volume data is preserved), clears the node placement, and deletes the node if no other environment is using it. Stop returns `409` while a recent stop is in progress, or if live teardown, volume detachment, or managed node deletion fails. Failed node deletion keeps the placement linked and displays the stop error; retrying Pause resumes cleanup. Scheduled recovery also retries interrupted stops and abandoned deployment teardown with bounded requests and backoff. The environment becomes stopped only after its cleanup succeeds; a shared node continues serving other environments.
- **Start** re-provisions or selects a deployment node, reattaches the environment's volumes, and lets the node's heartbeat reapply the latest release. If the environment requires volumes but no volume records exist, start fails with a `409` rather than booting against empty storage.
- Volume-requiring environments only receive a deployment payload once the node has reported its provider instance id. Until then the deploy-release callback returns `422` and the node retries, which prevents a volume-backed app from ever starting against ephemeral container storage.

From the user's perspective, **Pause** (stop) is the safe way to tear down compute without deleting the deployment environment. Use it when a preview app is idle but you may need its latest release, variables, secrets, domains, or volumes again. Use destructive delete controls only when the environment and its managed resources are no longer needed.

## Recovering from a failed release

If a release cannot be placed (for example, the cloud provider has no room for that server type in that region right now), the environment page says SAM couldn't get a server for that version, with the reason under **Show the error**. Either of these recovers it:

- **Ask an agent to deploy again** (the button on that problem, or ask in any chat). The new version gets a server, and the page goes from **Down** to **Deploying vN**, then **Live**, clearing the old error. If there's still no server, the problem comes back with the new reason. (Since 22 October 2026, or v2026.10.23 on a self-hosted instance; before that, every later version stayed stuck behind the old error.)
- **Pause, then Start.** Start finds a server for the latest version and shows **Starting** until the server reports it's running.

If SAM has to give up before any server is created, for example because the person who deployed lost access to the project, the version is marked failed and **Show the error** reads "Deployment node placement stopped before a server was created: &lt;reason&gt;. Deploy again to retry." A placement replaced by a newer release, or by a Stop or delete of the environment, is left to that newer release or action instead.

## Custom domains

Each public route gets a SAM-owned hostname such as
`r1-web-3000-env.apps.example.com`. You can attach your own subdomain to that
route from the **Addresses** section of the environment page. SAM shows the exact
CNAME target to create, verifies the hostname through DNS-over-HTTPS, and — once
verified — activates the custom hostname on the running app **without a full
redeploy**.

Custom domains attach to an already-published public route, so publish a release
with at least one public route first. Then:

1. Open the deployment environment and choose **Your domain** under **Addresses**.
2. Pick the part of the app (public route) you want to expose and enter a
   concrete subdomain such as `app.example.com` (apex/root domains are not
   supported in this version).
3. Create the **CNAME** record shown, from your subdomain to the SAM route
   hostname. If your DNS provider puts a proxy or CDN in front of records (for
   example Cloudflare's orange-cloud toggle), turn it off for this record so
   verification can see the real target.
4. Select **Add domain and check DNS**. If the record hasn't propagated yet, the
   domain waits for DNS; use **Check again** once it has. Verification succeeds
   when the custom hostname resolves to the SAM route hostname, or to the
   deployment node IP for DNS providers that flatten CNAMEs to A records.

That's it — you do not need to republish the release. A successful verification
queues a **route-only** activation to the deployment node, which reloads its
router and provisions TLS for the new hostname automatically.

![The "Use your own domain" sheet: step 1 picks the part of the app, step 2 is the subdomain, and step 3 shows the exact DNS record to add (type CNAME, the subdomain as the name, the SAM route hostname it points to) with Copy buttons, a note to turn off Cloudflare's proxy for the record, and an "Add domain and check DNS" button.](/images/docs/deployment-custom-domains.png)

### Domain states

The **Addresses** section shows each domain's state in words, and shows nothing
extra while a domain works:

| State                | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Waiting for DNS**  | The record isn't there yet, or has never resolved to the route target. Use **Check again**. |
| **Turning on**       | DNS is verified and route activation is queued to the node.                                 |
| _(no label)_         | The node is serving the hostname with TLS.                                                  |
| **Points elsewhere** | The domain worked before, but its record or the route target changed. Re-check the record.  |
| **Not attached**     | The route this domain was attached to no longer exists in the latest release.               |
| **Paused**           | The environment is paused; the saved domain is preserved.                                   |
| **Removing**         | The domain is being removed and the node is dropping the route.                             |

Saved domains stay visible even when the environment is **stopped** or in an
error state, so a stop/start cycle does not lose your DNS setup. Removing a
domain queues a route-only deactivation and finalizes once the node has dropped
the route.

SAM does not create or manage your DNS record. Root/apex domains, wildcard
domains, TXT-record ownership challenges, and on-demand TLS authorization are out
of scope for this version.
