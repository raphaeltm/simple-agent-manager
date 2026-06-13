# App-Deployment System — Where We're At (post-#1308)

> Snapshot taken 2026-06-13 on branch `sam/resume-land-caddy-routingtls-01ktyg`.
> Captures the end-to-end user-app deployment pipeline after PR #1308
> ("Productionize Caddy routing + TLS for app-deployment nodes") merges.
> This is the **user-app deployment** feature, NOT the platform self-host deploy
> (spec `005-automated-deployment`).

## Pipeline overview

```mermaid
flowchart TD
    subgraph CP["Control plane — Cloudflare Worker (Hono) @ api.sammy.party"]
        ENV["Environment CRUD<br/>POST / GET / GET :id / DELETE :id<br/>(deployment-environments.ts)"]
        REL["Release create + list + detail + compose preview<br/>(deployment-releases.ts)"]
        CB["Apply payload endpoint<br/>GET /api/nodes/:id/deploy-release?seq=N&environmentId=E<br/>(deploy-release-callback.ts, callback JWT scope 'node')"]
        DNS["Grey-cloud DNS<br/>upsert / delete app-route A records<br/>(dns.ts + deployment-routing.ts)"]
        SIGN["Sign apply payload<br/>(compose + route targets)"]
        D1[("D1<br/>environments / releases /<br/>secrets / volumes / routes")]
    end

    subgraph NODE["Deployment node — Hetzner VM (Go vm-agent, deploy mode)"]
        CI["cloud-init: install Docker + Caddy<br/>(runtime.go EnsureRuntime)"]
        HB["Heartbeat loop → reports appliedSeq,<br/>receives pendingReleaseSeq"]
        ENG["Apply engine (engine.go)<br/>verify signature → render compose<br/>→ docker compose up"]
        CADDY["Render Caddyfile + reload via admin API :2019<br/>(caddy.go)"]
        TLS["Let's Encrypt HTTP-01 ACME<br/>per public route hostname"]
        APP["Release container<br/>on loopback host port"]
    end

    USER(["User"]) -->|create env, push release| ENV --> REL --> D1
    REL -->|first release provisions node| NODE
    HB -->|seq < pending| CB
    CB --> DNS
    CB --> SIGN --> HB
    HB --> ENG --> APP
    ENG --> CADDY --> TLS
    TLS -->|public route serves HTTPS| USER
    ENV -->|DELETE| DNS

    classDef done fill:#1b3a1b,stroke:#4caf50,color:#e8f5e9;
    class ENV,REL,CB,DNS,SIGN,D1,CI,HB,ENG,CADDY,TLS,APP done
```

## Status legend

```mermaid
flowchart LR
    DONE["DONE — staging-verified"]:::done
    OPEN["NEEDS DEALING WITH — backlog"]:::open
    GATE["HUMAN GATE"]:::gate
    classDef done fill:#1b3a1b,stroke:#4caf50,color:#e8f5e9;
    classDef open fill:#3a2f1b,stroke:#ffb300,color:#fff8e1;
    classDef gate fill:#3a1b1b,stroke:#e53935,color:#ffebee;
```

### DONE (verified on staging)
- Environment CRUD incl. ownership-checked `DELETE` with DNS + cascade cleanup.
- Release create/list/detail (single-service slice-2 constraint, secrets stored by name).
- First-release node provisioning; seq-based heartbeat apply loop.
- Signed apply payload (compose + route targets); signature verify on node.
- Grey-cloud app-route A record provision **and** teardown (idempotent, 404-tolerant).
- Caddy install via cloud-init; Caddyfile render + admin-API **reload** (not restart).
- Let's Encrypt HTTP-01 TLS per public route hostname.
- 3 staging-verified runtime fixes (caddy ownership normalize, restart-when-reload-down,
  startup preflight + ACME global options).

### NEEDS DEALING WITH (open follow-ups)

```mermaid
flowchart TD
    A["Per-env host-port offset collision<br/>buildDeploymentRouteTargets uses route index only;<br/>two envs on one node both grab 35000.<br/>engine.go skips composeDown of prior release.<br/>(tasks/backlog/2026-06-13-deployment-per-env-host-port-offset.md)"]:::open
    B["Compose preview omits route-target ports<br/>GET .../compose renders without routeTargets;<br/>preview != real node payload.<br/>(tasks/backlog/2026-06-13-compose-preview-endpoint-route-targets.md)"]:::open
    C["Compose-parser test coverage<br/>(tasks/backlog/2026-06-11-compose-parser-test-coverage.md)"]:::open
    D["Deployment-provisioning route tests<br/>(tasks/backlog/2026-06-12-deployment-provisioning-route-tests.md)"]:::open
    E["docker-exec env token exposure<br/>(tasks/backlog/2026-03-18-docker-exec-env-token-exposure.md)"]:::open
    F["Route-level error message leakage<br/>(tasks/backlog/2026-04-10-route-level-error-message-leakage.md)"]:::open
    classDef open fill:#3a2f1b,stroke:#ffb300,color:#fff8e1;
```

### HUMAN GATE
- PR #1308 carries the `needs-human-review` label by design (DO NOT MERGE until a
  human removes it). Preflight Evidence + SonarCloud now PASS; that label is the only
  remaining red check and it is the intentional merge gate.

## Notes
- App-route hostname scheme: `r{index+1}-{service}-{port}-{envIdLower}.apps.{baseDomain}`
  using the FULL 26-char ULID. Record IDs are not persisted — teardown reconstructs
  hostnames from each release manifest via `collectEnvironmentRouteHostnames`.
- The host-port collision (item A) is currently *masked* because `sam-internal` became a
  bridge network (commit 5b0765bd); it will resurface for multi-env-per-node.
