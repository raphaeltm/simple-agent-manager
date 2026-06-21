# 06 — Compose Safety Boundary and Manifest Authoring

**Last updated:** 2026-06-19

SAM deployment releases are authored as a constrained Docker Compose YAML file. The control plane parses that Compose subset into the normalized deployment manifest, resolves image tags to immutable `sha256:` digests, validates the manifest, stores the manifest JSON, and renders the node-side Compose file during apply.

Manifest JSON remains accepted by the release API for backward compatibility, but Compose YAML with `x-sam-*` extensions is the primary submission format.

## Submission Contract

Agents submit releases to:

```http
POST /api/projects/:projectId/environments/:envId/releases
Content-Type: text/yaml
```

Minimal single-service example:

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

Accepted YAML media types are `application/yaml`, `text/yaml`, `application/x-yaml`, and `text/x-yaml`. Other media types use the legacy raw manifest JSON path.

## Safety Boundary

The Compose parser is default-deny. It rejects host-level or privileged behavior such as `build:`, `privileged: true`, host networking, Docker socket mounts, bind mounts, `tmpfs`, `devices`, and other fields that would break SAM's control boundary.

Only named volumes are accepted. Secret values are never embedded in the release manifest; `x-sam-secret` references are checked against environment secrets and resolved only when rendering the signed apply payload.

Slice 2 still enforces one service per release. Multi-service Compose parses into the normalized manifest shape, but the release API rejects it with `MULTI_SERVICE_NOT_SUPPORTED` until the control surface and apply path support multi-service releases.
