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
      NODE_ENV: production
      DATABASE_URL:
        x-sam-secret: database-url
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

Use `x-sam-secret` for environment secrets. The release stores the secret name only; values are injected server-side when SAM renders the signed apply payload.

For compose-publish releases, SAM preserves safe named volumes declared in the Compose file. Host bind mounts, Docker socket mounts, `tmpfs`, external volumes, and custom volume drivers are rejected.
