---
title: App Deployments
description: Author and submit SAM app deployment releases with Docker Compose.
---

SAM app deployments are agent-first. An agent builds an image in its workspace, pushes it with SAM-scoped registry credentials, then submits a release to a deployment environment.

The release submission format is Docker Compose YAML with SAM extensions. SAM parses the Compose file into a normalized manifest, resolves image tags to immutable `sha256:` digests, validates the result, stores the digest-pinned manifest, and renders the Compose file that the deployment node applies.

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
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
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

Slice 2 supports one service per deployment release. Multi-service Compose files are rejected with `MULTI_SERVICE_NOT_SUPPORTED` until multi-service deployments ship.
