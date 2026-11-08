/**
 * MCP deployment guide tool — deployments_read method guide.
 *
 * Returns a comprehensive briefing on SAM's agent-first app deployment system:
 * how it works, which deployment MCP tools to call in what order, how
 * per-environment Variables and Secrets work, how to read deployment logs, and
 * how to check DNS/routing. Agents should call this whenever a user asks to
 * deploy, launch, publish, ship, or release an app.
 *
 * Modeled after workspace_read method setup_guide: synchronous, no arguments, static
 * markdown content returned as a single text content block.
 */
import { type JsonRpcResponse, jsonRpcSuccess } from './_helpers';

// ─── SAM deployment guide content ────────────────────────────────────────────

const SAM_DEPLOYMENT_GUIDE = `# SAM App Deployment Guide

You are an AI coding agent running inside a SAM (Simple Agent Manager) workspace. The user has asked you to **deploy, launch, publish, ship, or release** an app. This guide explains how SAM's deployment system works and exactly which tools to call, in what order.

Read this whole guide before touching anything. SAM deployments do not work like a normal CI/CD pipeline — if you try to run \`docker push\`, set up a GitHub Actions deploy job, or look for registry credentials, you will waste time and fail. SAM does all of that for you.

---

## Part 1: The Agent-First Deployment Model (read this first)

SAM app deployment is **agent-first** and **never goes through CI**. This is the single most important thing to understand.

- A user creates a **deployment environment** (for example \`staging\` or \`production\`) and enables agent deployment for it.
- If the user asks for a new non-production environment, you may create it with \`deployments_write\` method \`create_environment\`; SAM restricts it to your creator profile by default and the project owner can later change or disable the policy.
- You, the agent, author a **Docker Compose stack** in the workspace and call one tool — \`deployments_write\` method \`publish\` — targeting that environment.
- SAM builds the Compose stack **server-side on the SAM VM**, pushes the built service images to the project-scoped registry **using SAM-owned credentials**, and records the release.
- SAM's deployment nodes then pull the recorded release and run it.

What this means for you:

- **You never run \`docker build\`, \`docker push\`, or any registry command yourself.** \`deployments_write\` method \`publish\` does it.
- **You never receive or need registry credentials.** SAM mints them server-side.
- **You never set up CI to deploy.** Do not create or edit GitHub Actions / CI deploy jobs for app deployment. That is not how SAM ships apps.
- **You author Compose YAML; SAM does the rest.**

If you ever find yourself reaching for \`docker push\` or writing a deploy pipeline, stop — that is a sign you have left the SAM model.

---

## Part 2: The Deployment Tools (your toolbox)

SAM exposes these MCP tools for deployment. They are the only interface you need.

| Tool | Purpose |
| --- | --- |
| \`deployments_write { method: 'create_environment', name }\` | Create a new non-reserved deployment environment for the current task. Requires a real task/profile context; defaults access to this creator profile only. |
| \`deployments_read { method: 'environments' }\` | List the deployment environments this agent profile is allowed to target: the active ones, plus any in \`error\` waiting for a new release to recover. |
| \`deployments_read { method: 'config', environment }\` | List the Variables (values visible) and Secret keys (values never returned) configured for an environment. |
| \`deployments_write { method: 'set_config', environment, key, value, isSecret? }\` | Create or update a Variable or Secret for an environment. |
| \`deployments_write { method: 'publish', environment, reference?, workingDir? }\` | Start an async server-side Compose build/publish job and return a durable \`publishJobId\`. |
| \`deployments_write { method: 'cancel_publish', publishJobId }\` | Cancel a running publish job. Terminal jobs stay unchanged; recorded releases are not rolled back. |
| \`deployments_read { method: 'publish_status', publishJobId, sinceSeq?, limit? }\` | Poll the build/publish job for status, events, release details, and sanitized failure diagnostics. |
| \`deployments_read { method: 'preview_routes', environment, composeYaml }\` | Preview which Compose ports will get public SAM URLs before deploying. \`mode: host\` ports are internal/private; other ports are public unless explicitly marked private. |
| \`deployments_read { method: 'routes', environment }\` | List the public URLs, custom domains, and internal routes derived from the latest release version in an accessible environment. |
| \`deployments_read { method: 'logs', environment, source?, level?, container?, since?, until?, search?, cursor?, limit? }\` | Read deployment-node logs for an environment to verify the release and debug failures. |
| \`workspace_read { method: 'dns' }\` | Check DNS propagation and TLS validity for **this workspace's own** \`ws-*\` URL. It verifies the workspace is reachable at the Cloudflare edge — it does NOT check a deployed app's public route. |

---

## Part 3: The Deployment Flow (do these in order)

### Step 1 — Discover the target environment

Call \`deployments_read { method: 'environments' }\` first. It returns only the environments that your agent profile is allowed to target AND that are either active, or in \`error\` and waiting for a new release to recover.

- An environment listed with \`status: "error"\` is **recoverable, not blocked**. Submitting a new \`deployments_write\` method \`publish\` release for it IS the recovery path — SAM re-places or re-adopts its deployment node when the release arrives. Report the environment's \`observedDeployment.errorMessage\` (alongside \`observedDeployment.status\`) to the user so they know what failed, then proceed with the deployment as normal.
- If the user asked for a new non-reserved environment name, call \`deployments_write { method: 'create_environment', name }\`, then call \`deployments_read { method: 'environments' }\` again and use the newly created environment.
- If the list is **empty** and the user did not ask you to create an environment, ask whether to create one. Reserved names such as production must be created by the project owner from the control surface.
- If an existing environment is missing because agent deployment is disabled or your profile has no access, report that the project owner must update the deployment environment policy. Do not try to work around this.
- If there are multiple environments, pick the one the user named (for example "deploy to staging"). If ambiguous, ask which environment to target.

### Step 2 — Review and set configuration (Variables vs Secrets)

Call \`deployments_read { method: 'config', environment }\` to see what is already configured.

- **Variables** are visible after save. SAM supplies them both to \`deployments_write\` method \`publish\` (build time) and to the deployment-node Compose apply (runtime). Use Variables for image tags, build args, public domains, and non-sensitive runtime values.
- **Secrets** are hidden after save (the value is never returned again). SAM supplies Secrets **only** to the deployment-node Compose apply as process environment for Compose interpolation. **Secrets are NOT sent to build nodes** — never use a Secret in a build arg, image tag, route field, or any build/publish-control field.

Set anything missing with \`deployments_write { method: 'set_config', environment, key, value, isSecret? }\`. Pass \`isSecret: true\` for sensitive values (database URLs, API keys, tokens).

In your Compose file, reference these as normal interpolation placeholders, for example \`\${DATABASE_URL}\`. Compose interpolation only replaces \`\${VAR}\` placeholders — it does not override literal values like \`NODE_ENV: production\`.

### Step 3 — Author the Compose stack

Write a standard Docker Compose YAML file in the workspace. SAM supports multi-service stacks and derives public routes from either \`x-sam-routes\` or each service's \`ports:\`.

\`\`\`yaml
services:
  web:
    image: registry.example.com/my-project/web:\${IMAGE_TAG:-latest}
    environment:
      NODE_ENV: production
      DATABASE_URL: \${DATABASE_URL}
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']
      interval: 30s
      timeout: 5s
      retries: 3

x-sam-routes:
  - service: web
    port: 3000
    mode: public
\`\`\`

Constraints for compose-publish releases:

- \`ports:\` entries are route hints, not raw host publishing. Long-syntax \`mode: host\` ports are treated as **internal/private** and do not get public DNS. Other \`ports:\` entries are public by default.
- Safe named Docker Compose volumes are supported by \`deployments_write\` method \`publish\` when each service mount references a top-level named volume declaration. SAM creates missing provider-backed block volumes for those declarations and rewrites service mounts to SAM-managed volume mount roots before deployment apply.
- **Host bind mounts, Docker socket mounts, anonymous volumes, undeclared named volumes, \`volumes_from\`, \`tmpfs\`, external volumes, custom volume drivers, and driver options are rejected with \`unsupported_compose_volumes\`.**
- Docker Model Runner \`provider:\` services are preserved.
- Prefer normal \`\${VAR}\` placeholders backed by per-environment Variables and Secrets over older explicit secret references. The legacy \`x-sam-secret\` syntax is still supported for compatibility, but new deployments should use \`\${VAR}\` placeholders.

Before publishing, call \`deployments_read { method: 'preview_routes', environment, composeYaml }\` with the exact Compose file you plan to deploy. It returns:

- \`publicRoutes\` with the generated SAM hostname and \`https://...\` URL.
- \`internalRoutes\` for private ports, including \`mode: host\` service ports.
- \`publicUrlPattern\`, the deterministic hostname pattern for that environment.

If the application needs to know its public hostnames before it starts, use this preview output before \`deployments_write\` method \`publish\`. For example, set framework configuration such as Django \`ALLOWED_HOSTS\` / CSRF trusted origins, CORS origins, OAuth callback URLs, webhook callback URLs, or canonical app URLs from the returned public route URLs. If those values are deployment Variables or Secrets, call \`deployments_write\` method \`set_config\` after previewing and before publishing. Do not guess route hostnames by hand when the MCP tool can compute them.

### Step 4 — Build and publish (the deploy action)

Call \`deployments_write { method: 'publish', environment, reference?, workingDir? }\`:

- \`environment\` — the named environment from Step 1.
- \`reference\` — optional release tag/identifier (defaults to "latest").
- \`workingDir\` — optional absolute path under \`/workspaces\` if the Compose file is not at the workspace root.

SAM returns a \`publishJobId\` quickly after the VM accepts the job. The actual Docker Compose build, image export, artifact upload, and release recording continue in the background. You do not run any docker or registry commands.

Publishing requires a VM session; Instant sessions cannot publish yet. Jobs fail with retryable \`stalled\` when a heartbeat-capable executor stops heartbeating (older agents are deadline-only) or \`deadline_exceeded\` after the overall deadline. To cancel, use \`deployments_write { method: 'cancel_publish', publishJobId }\` (also callable as \`cancel_publish\`).

After \`deployments_write\` method \`publish\` returns, call \`deployments_read { method: 'publish_status', publishJobId }\` every 10-20 seconds until the status is terminal:

- \`succeeded\` means the release was recorded. Continue to Step 5 to verify deployment-node apply health.
- \`failed\`, \`canceled\`, or \`unknown\` means publishing did not complete. Read the returned events and failed step before changing files or retrying.
- While polling, pass \`sinceSeq\` from the previous response to receive only new events.

This tool requires the named environment to be active (or in \`error\`, waiting for this release to recover it), agent deployment to be enabled, and your agent profile to satisfy that environment's policy. If it errors for one of those reasons, report it to the user — do not attempt to bypass the policy.

### Step 5 — Verify the release

After the publish job reaches \`succeeded\`:

- Call \`deployments_read { method: 'routes', environment }\` to see the generated public URLs, custom domains, and internal routes for the latest release version. Check \`latestRelease.status\`: a newer non-applied release may not be what Caddy is currently serving. Confirm internal services such as databases or queues were not given public DNS. For custom domains, check the expected \`cnameTarget\`, \`verificationStatus\`, and whether the domain \`willBeIncludedInApplyPayload\`; verified custom domains may still require a later apply/redeploy before they are served.
- Call \`deployments_read { method: 'logs', environment }\` to confirm the deployment node applied the release and the containers are healthy. Deployment nodes also persist release-scoped apply events for phases such as fetch, compose config, artifact load, compose up, health check, Caddy reload, success, failure, and revert. Read the logs/events before guessing at fixes.
- Call \`workspace_read { method: 'dns' }\` to confirm **this workspace's** \`ws-*\` URL is reachable with valid TLS at the edge. Note this checks the workspace itself, not the deployed app's public route — use \`deployments_read\` method \`logs\` to confirm the deployed containers are serving.

---

## Part 4: Common Pitfalls

- **Trying to deploy through CI.** SAM is agent-first. Do not write or edit CI deploy jobs. Call \`deployments_write\` method \`publish\`.
- **Looking for registry credentials.** You never need them; SAM mints them server-side.
- **Putting a Secret in a build arg or image tag.** Secrets never reach build nodes — the value will be empty there. Use a Variable for anything the build needs.
- **Treating job start as success.** \`deployments_write\` method \`publish\` starts a durable job. You must poll \`deployments_read\` method \`publish_status\` until terminal before claiming publish success.
- **Skipping apply verification.** A successful publish job records a release; it does not prove the containers are healthy. Always read deployment logs/apply events to confirm.
- **Guessing when an environment is missing.** If the user asked for a new non-reserved environment, use \`deployments_write\` method \`create_environment\`. Otherwise ask before creating one, or tell the user the project owner must update policy for existing/reserved environments.
- **Using undeclared or unsafe Compose volumes for stateful data.** \`deployments_write\` method \`publish\` supports declared named volumes and rewrites them to SAM cloud volumes. It rejects anonymous volumes, undeclared named volumes, host bind mounts, Docker socket mounts, tmpfs, external volumes, and custom drivers/options.
- **Forgetting route-dependent app config.** Frameworks often reject unknown hosts/origins. Preview routes first, then set allowed hosts, trusted origins, CORS origins, callback URLs, or canonical URL variables before publishing.
- **Accidentally exposing databases or queues.** Use Compose long-syntax \`ports:\` with \`mode: host\` for internal/private route hints, or mark the service/port private in \`x-sam-routes\`. Verify with \`deployments_read\` method \`preview_routes\` before publishing.

---

## Quick Reference (happy path)

1. \`deployments_read { method: 'environments' }\` → pick the target, or \`deployments_write { method: 'create_environment', name }\` if the user asked for a new non-reserved environment.
2. \`deployments_read { method: 'config', environment }\` → review; \`deployments_write { method: 'set_config', ... }\` for anything missing (Secrets via \`isSecret: true\`).
3. Author the Compose stack with \`\${VAR}\` placeholders and route hints.
4. \`deployments_read { method: 'preview_routes', environment, composeYaml }\` → confirm public URLs and internal routes.
5. \`deployments_write { method: 'set_config', ... }\` again if previewed URLs must be written into app config.
6. \`deployments_write { method: 'publish', environment }\` → capture \`publishJobId\`.
7. \`deployments_read { method: 'publish_status', publishJobId }\` until terminal.
8. \`deployments_read { method: 'routes', environment }\`, \`deployments_read { method: 'logs', environment }\`, and \`workspace_read { method: 'dns' }\` → verify it is actually running.`;

export function handleGetDeploymentGuide(requestId: string | number | null): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text:
          'Follow the guide below to deploy, launch, publish, ship, or release an app with SAM.\n\n' +
          SAM_DEPLOYMENT_GUIDE,
      },
    ],
  });
}
