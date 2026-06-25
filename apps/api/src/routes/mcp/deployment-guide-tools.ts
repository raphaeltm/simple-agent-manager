/**
 * MCP deployment guide tool — get_deployment_guide.
 *
 * Returns a comprehensive briefing on SAM's agent-first app deployment system:
 * how it works, which deployment MCP tools to call in what order, how
 * per-environment Variables and Secrets work, how to read deployment logs, and
 * how to check DNS/routing. Agents should call this whenever a user asks to
 * deploy, launch, publish, ship, or release an app.
 *
 * Modeled after get_repo_setup_guide: synchronous, no arguments, static
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
- You, the agent, author a **Docker Compose stack** in the workspace and call one tool — \`build_and_publish\` — targeting that environment.
- SAM builds the Compose stack **server-side on the SAM VM**, pushes the built service images to the project-scoped registry **using SAM-owned credentials**, and records the release.
- SAM's deployment nodes then pull the recorded release and run it.

What this means for you:

- **You never run \`docker build\`, \`docker push\`, or any registry command yourself.** \`build_and_publish\` does it.
- **You never receive or need registry credentials.** SAM mints them server-side.
- **You never set up CI to deploy.** Do not create or edit GitHub Actions / CI deploy jobs for app deployment. That is not how SAM ships apps.
- **You author Compose YAML; SAM does the rest.**

If you ever find yourself reaching for \`docker push\` or writing a deploy pipeline, stop — that is a sign you have left the SAM model.

---

## Part 2: The Deployment Tools (your toolbox)

SAM exposes these MCP tools for deployment. They are the only interface you need.

| Tool | Purpose |
| --- | --- |
| \`list_deployment_environments()\` | List the active deployment environments this agent profile is allowed to target. |
| \`list_deployment_environment_config(environment)\` | List the Variables (values visible) and Secret keys (values never returned) configured for an environment. |
| \`set_deployment_environment_config(environment, key, value, isSecret?)\` | Create or update a Variable or Secret for an environment. |
| \`build_and_publish(environment, reference?, workingDir?)\` | Start an async server-side Compose build/publish job and return a durable \`publishJobId\`. |
| \`get_publish_status(publishJobId, sinceSeq?, limit?)\` | Poll the build/publish job for status, events, release details, and sanitized failure diagnostics. |
| \`read_deployment_logs(environment, source?, level?, container?, since?, until?, search?, cursor?, limit?)\` | Read deployment-node logs for an environment to verify the release and debug failures. |
| \`check_dns_status()\` | Check DNS propagation and TLS validity for **this workspace's own** \`ws-*\` URL. It verifies the workspace is reachable at the Cloudflare edge — it does NOT check a deployed app's public route. |

---

## Part 3: The Deployment Flow (do these in order)

### Step 1 — Discover the target environment

Call \`list_deployment_environments()\` first. It returns only the environments that are active AND that your agent profile is allowed to target.

- If the list is **empty**, agent deployment is not enabled for any environment, or your profile has no access. Stop and tell the user: they need to create a deployment environment and enable agent deployment for it from the Deployments page. Do not try to work around this.
- If there are multiple environments, pick the one the user named (for example "deploy to staging"). If ambiguous, ask which environment to target.

### Step 2 — Review and set configuration (Variables vs Secrets)

Call \`list_deployment_environment_config(environment)\` to see what is already configured.

- **Variables** are visible after save. SAM supplies them both to \`build_and_publish\` (build time) and to the deployment-node Compose apply (runtime). Use Variables for image tags, build args, public domains, and non-sensitive runtime values.
- **Secrets** are hidden after save (the value is never returned again). SAM supplies Secrets **only** to the deployment-node Compose apply as process environment for Compose interpolation. **Secrets are NOT sent to build nodes** — never use a Secret in a build arg, image tag, route field, or any build/publish-control field.

Set anything missing with \`set_deployment_environment_config(environment, key, value, isSecret?)\`. Pass \`isSecret: true\` for sensitive values (database URLs, API keys, tokens).

In your Compose file, reference these as normal interpolation placeholders, for example \`\${DATABASE_URL}\`. Compose interpolation only replaces \`\${VAR}\` placeholders — it does not override literal values like \`NODE_ENV: production\`.

### Step 3 — Author the Compose stack

Write a standard Docker Compose YAML file in the workspace. SAM supports multi-service stacks and derives public routes from each service's \`ports:\` by default. Use \`x-sam-routes\` only when you need an explicit override, such as exposing a service port without \`ports:\` or marking a matching \`ports:\` entry as \`private\`.

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
    ports:
      - "3000"

x-sam-routes:
  - service: web
    port: 3000
    mode: private
\`\`\`

Constraints for compose-publish releases:

- Safe named volumes are preserved. **Host bind mounts, Docker socket mounts, \`tmpfs\`, external volumes, and custom volume drivers are rejected.**
- Docker Model Runner \`provider:\` services are preserved.
- Prefer normal \`\${VAR}\` placeholders backed by per-environment Variables and Secrets over older explicit secret references. The legacy \`x-sam-secret\` syntax is still supported for compatibility, but new deployments should use \`\${VAR}\` placeholders.

### Step 4 — Build and publish (the deploy action)

Call \`build_and_publish(environment, reference?, workingDir?)\`:

- \`environment\` — the named environment from Step 1.
- \`reference\` — optional release tag/identifier (defaults to "latest").
- \`workingDir\` — optional absolute path under \`/workspaces\` if the Compose file is not at the workspace root.

SAM returns a \`publishJobId\` quickly after the VM accepts the job. The actual Docker Compose build, image export, artifact upload, and release recording continue in the background. You do not run any docker or registry commands.

After \`build_and_publish\` returns, call \`get_publish_status({ publishJobId })\` every 10-20 seconds until the status is terminal:

- \`succeeded\` means the release was recorded. Continue to Step 5 to verify deployment-node apply health.
- \`failed\`, \`canceled\`, or \`unknown\` means publishing did not complete. Read the returned events and failed step before changing files or retrying.
- While polling, pass \`sinceSeq\` from the previous response to receive only new events.

This tool requires the named environment to be active, agent deployment to be enabled by a user, and your agent profile to satisfy that environment's policy. If it errors for one of those reasons, report it to the user — do not attempt to bypass the policy.

### Step 5 — Verify the release

After the publish job reaches \`succeeded\`:

- Call \`read_deployment_logs(environment)\` to confirm the deployment node applied the release and the containers are healthy. Deployment nodes also persist release-scoped apply events for phases such as fetch, compose config, artifact load, compose up, health check, Caddy reload, success, failure, and revert. Read the logs/events before guessing at fixes.
- Call \`check_dns_status()\` to confirm **this workspace's** \`ws-*\` URL is reachable with valid TLS at the edge. Note this checks the workspace itself, not the deployed app's public route — use \`read_deployment_logs\` to confirm the deployed containers are serving.

---

## Part 4: Common Pitfalls

- **Trying to deploy through CI.** SAM is agent-first. Do not write or edit CI deploy jobs. Call \`build_and_publish\`.
- **Looking for registry credentials.** You never need them; SAM mints them server-side.
- **Putting a Secret in a build arg or image tag.** Secrets never reach build nodes — the value will be empty there. Use a Variable for anything the build needs.
- **Treating job start as success.** \`build_and_publish\` starts a durable job. You must poll \`get_publish_status\` until terminal before claiming publish success.
- **Skipping apply verification.** A successful publish job records a release; it does not prove the containers are healthy. Always read deployment logs/apply events to confirm.
- **Guessing when an environment is missing.** If \`list_deployment_environments()\` is empty, the user must create/enable an environment. Tell them; do not improvise.
- **Using rejected volume types.** Host bind mounts, Docker socket mounts, tmpfs, external volumes, and custom drivers are rejected. Use safe named volumes.

---

## Quick Reference (happy path)

1. \`list_deployment_environments()\` → pick the target.
2. \`list_deployment_environment_config(environment)\` → review; \`set_deployment_environment_config(...)\` for anything missing (Secrets via \`isSecret: true\`).
3. Author the Compose stack with \`\${VAR}\` placeholders and \`ports:\` for public app routes; add \`x-sam-routes\` only for explicit overrides.
4. \`build_and_publish(environment)\` → capture \`publishJobId\`.
5. \`get_publish_status(publishJobId)\` until terminal.
6. \`read_deployment_logs(environment)\` and \`check_dns_status()\` → verify it is actually running.`;

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
