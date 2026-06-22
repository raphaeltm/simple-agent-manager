---
title: App Deployments
description: Author and submit SAM app deployment releases with Docker Compose.
---

SAM app deployments are agent-first. A user creates a deployment environment and enables agent deployment for that environment. An agent then targets that named environment when it publishes a release.

There are two publish paths:

- `build_and_publish(environment)` builds the workspace's Docker Compose stack on the SAM VM, pushes built service images with SAM-owned registry credentials, and records the release server-side. Agents never receive registry credentials.
- `get_registry_credentials(environment)` returns short-lived credentials for advanced direct pushes. Use it only when an agent needs to push images itself.

Both tools require the named deployment environment to be active, agent deployment to be enabled by a user, and the agent profile to satisfy that environment's policy.

The release submission format is Docker Compose YAML with SAM extensions. SAM supports multi-service Compose stacks, preserves service topology including Docker Model Runner `provider:` services, and derives public routes from either `x-sam-routes` or compose service `ports:` depending on the publish path.

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

volumes:
  app-data: {}

x-sam-routes:
  - service: web
    port: 3000
    mode: public
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
