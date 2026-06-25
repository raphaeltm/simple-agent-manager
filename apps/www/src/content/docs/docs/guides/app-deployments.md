---
title: App Deployments
description: Author and submit SAM app deployment releases with Docker Compose.
---

SAM app deployments are agent-first. A user creates a deployment environment and enables agent deployment for that environment. An agent then targets that named environment when it publishes a release.

Agents can discover this whole flow at runtime by calling the `get_deployment_guide` MCP tool, which returns a briefing on the agent-first model and the order in which to call the deployment tools. It takes no arguments and is the recommended starting point whenever a user asks to deploy, launch, publish, ship, or release an app.

Agents publish with a single tool:

- `build_and_publish(environment)` builds the workspace's Docker Compose stack on the SAM VM, pushes built service images with SAM-owned registry credentials, and records the release server-side. Agents never run docker or registry commands and never receive registry credentials.

This tool requires the named deployment environment to be active, agent deployment to be enabled by a user, and the agent profile to satisfy that environment's policy.

The release submission format is Docker Compose YAML with SAM extensions. SAM supports multi-service Compose stacks, preserves service topology including Docker Model Runner `provider:` services, and derives public routes from compose service `ports:` by default. Use `x-sam-routes` only when you need an explicit override, such as exposing a service port without `ports:` or marking a matching `ports:` entry as `private`.

```yaml
services:
  web:
    image: registry.example.com/my-project/web:v1.2.3
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      PUBLIC_APP_DOMAIN: ${PUBLIC_APP_DOMAIN}
      DATABASE_URL: ${DATABASE_URL}
    volumes:
      - app-data:/var/lib/app
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']
      interval: 30s
      timeout: 5s
      retries: 3
    ports:
      - "3000"

volumes:
  app-data: {}
```

To override route behavior explicitly:

```yaml
x-sam-routes:
  - service: web
    port: 3000
    mode: private
```

Submit the file to the release endpoint with a YAML content type:

```http
POST /api/projects/:projectId/environments/:envId/releases
Content-Type: text/yaml
```

SAM accepts `application/yaml`, `text/yaml`, `application/x-yaml`, and `text/x-yaml`. Raw manifest JSON is still accepted for older callers, but Compose YAML is the authoring format.

Configure values on each deployment environment from the Deployments page:

- **Variables** are visible after save. SAM supplies them to `build_and_publish` and to deployment-node Compose apply commands, so they can be used for image tags, build args, domains, and runtime environment values.
- **Secrets** are hidden after save. SAM supplies them only to deployment-node Compose apply commands as process environment for Compose interpolation. Secrets are not sent to build nodes and should not be used in build args, image tags, route fields, or other build/publish-control fields.

Compose interpolation only affects placeholders such as `${DATABASE_URL}`. It does not override literal Compose values like `NODE_ENV: production`.

`x-sam-secret` and older explicit secret references remain supported for compatibility, but new deployments should prefer normal Compose `${VAR}` placeholders backed by per-environment Variables and Secrets.

For compose-publish releases, SAM preserves safe named volumes declared in the Compose file. Host bind mounts, Docker socket mounts, `tmpfs`, external volumes, and custom volume drivers are rejected.

## Custom domains

Each public route gets a SAM-owned hostname such as
`r1-web-3000-env.apps.example.com`. You can attach your own subdomain to that
route from the deployment environment. SAM returns the exact CNAME target to
create, verifies the hostname through DNS-over-HTTPS, and adds the custom
hostname to the next signed deployment apply payload.

Custom domains in this first version are intentionally simple:

- Use a concrete subdomain such as `app.example.com`.
- Create a CNAME from your subdomain to the SAM-owned route hostname shown by
  the environment.
- Run verification after the DNS record propagates.
- Redeploy or reapply the release so the deployment node receives the custom
  hostname and Caddy can provision TLS for it.

SAM does not create or manage your DNS record. Verification succeeds when the
custom hostname resolves to the SAM route hostname, or to the deployment node IP
for DNS providers that flatten CNAMEs to A records.

Root/apex domains, wildcard domains, TXT-record ownership challenges, and
on-demand TLS authorization are out of scope for this version.
