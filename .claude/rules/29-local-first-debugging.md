# Local-First Prototyping and Log-Driven Debugging

## The Core Principle

Every iteration loop you take has a cost. Local loops cost seconds. Staging loops cost minutes and burn through VM quota. Production loops cost users. **Shorten your feedback loop as much as the feature allows — and when staging is unavoidable, never guess twice. Read the logs.**

This rule governs two related behaviors:

1. **Prototype locally first.** Prove as much of a feature as possible on your laptop (or Codespace) before touching staging.
2. **Debug with logs, not guesses.** When something fails on a VM or in the control plane, retrieve the actual logs before changing any code. "Push and see if it works now" is not a debugging strategy.

## Part 1: Local-First Prototyping (Mandatory)

When implementing a feature, you MUST exhaust local verification before deploying to staging. Staging is the integration test, not the development environment.

### What Can Be Verified Locally

Most of a feature's behavior can be proven without ever deploying:

| Layer | Local verification | Tooling |
|-------|-------------------|---------|
| **Pure logic** (parsers, validators, state machines) | Unit tests | `pnpm test` |
| **API route handlers** | Miniflare integration tests | `apps/api/tests/integration/` |
| **Database queries** (D1) | Miniflare D1 with migrations applied | Vitest + `vitest.workers.config.ts` |
| **Durable Object state machines** | Miniflare DO tests | Vitest workers pool |
| **UI components and flows** | Vitest + React Testing Library + Playwright visual audit | `pnpm test`, `.codex/tmp/playwright-screenshots/` |
| **UI against staging API** | `pnpm --filter web dev` pointed at `https://api.sammy.party` via `VITE_API_URL` | Hybrid local-UI / staging-API loop |
| **API Worker against local UI** | `pnpm --filter api dev` (wrangler dev) with web pointed at `http://localhost:8787` | Hybrid local-API / local-UI loop |
| **Cloud-init template output** | Parse generated YAML with realistic PEM/SSH data, assert round-trip integrity | `packages/cloud-init/` tests |
| **VM agent Go code** | Unit tests; run the binary locally against a Docker daemon | `go test ./...`, local `./vm-agent` |

### What CANNOT Be Verified Locally

These genuinely require staging (or at least a real VM + real Cloudflare infrastructure):

- Real OAuth callbacks (GitHub, Google, Codex) — callback URLs must resolve publicly
- Real DNS record propagation (`ws-*.sammy.party` subdomains)
- Real TLS termination at the Cloudflare edge + Origin CA certificate handshake with the VM agent
- Real Hetzner / Scaleway VM provisioning and cloud-init execution
- Real Durable Object alarms firing against persistent storage
- Cross-service interactions that traverse the Cloudflare edge (Worker → Worker, Tail Worker consumption)

Everything else should be proven locally first. If you find yourself pushing to staging to check whether a pure-TypeScript function returns the right value, stop — write a unit test instead.

### Hybrid Local + Staging Loops (Encouraged)

When you genuinely need a piece of real infrastructure but not the whole system, run a hybrid loop:

1. **Local UI, staging API.** Run `pnpm --filter web dev` with `VITE_API_URL=https://api.sammy.party` to iterate on UI against real D1/KV/DO data. Fast reloads, real data.
2. **Local API, local UI, proxy to staging VM agent.** When debugging Worker → VM-agent contracts, run the API Worker locally and let it call a real VM on staging. You get Worker `console.log`s directly in your terminal.
3. **Staging backend, local tunnel for a single endpoint.** When debugging a callback (e.g., OAuth), use a tunnel (cloudflared, ngrok) to expose your local port and register the tunnel URL as a temporary callback URI — only if the provider supports multiple redirect URIs.

Each of these keeps 90% of your iteration on your laptop while using staging only for the piece that truly requires it.

### When to Cross Into Staging

You may deploy to staging when:

1. Every piece of logic that CAN be tested locally HAS been tested locally and passes
2. The remaining verification requires real infrastructure (DNS, OAuth, VM provisioning, edge TLS)
3. You have a specific, named thing you are going to verify on staging — not "let's see if it works"

Deploying to staging to discover what your code does is a sign you skipped local verification. Go back.

### Partial Feature Staging (Acceptable)

When a feature is large, it is acceptable and encouraged to deploy **partial slices** to staging to unblock end-to-end verification of the plumbing, while continuing to develop the rest locally. For example:

- Deploy the API route first; iterate on the UI locally against the deployed route
- Deploy the cloud-init / VM-agent half first; iterate on the Worker glue locally against a real VM
- Deploy a feature-flagged path that is invisible to users, then flip the flag later

A partial staging deploy is NOT a merge-ready state. Rule 22 (infrastructure merge gate) and Rule 13 (staging verification) still apply before PR merge — you must verify the *complete* feature on staging before merging.

## Part 2: Log-Driven Debugging (Absolute Requirement)

When something fails on staging, production, or any real VM, you MUST retrieve the relevant logs before changing code. This is not optional. This is not negotiable. This is the single highest-leverage debugging habit.

### The Prohibited Anti-Pattern

```
1. Deploy to staging
2. Feature doesn't work
3. Guess at what's wrong
4. Change code
5. Deploy again
6. Still broken
7. Guess differently
8. Change code
9. Deploy again
... (3 hours later)
```

This wastes staging quota, wastes CI minutes, wastes your budget, and frequently ships code that "happens to work" without you ever understanding why it was broken. If you catch yourself on step 3 (guessing), STOP. Read the logs.

### Required Procedure When Staging Behavior Is Wrong

1. **Query staging infrastructure directly via the Cloudflare API.** Before reading logs, before changing code, use `CF_TOKEN` to check the actual state: query D1 for data/migration status, read KV for feature flags, check DNS records. This takes seconds and often reveals the issue immediately. See `.claude/rules/32-cf-api-debugging.md` for the full cheat sheet.
2. **Identify the layer that's failing.** Is it the browser? API Worker? Durable Object? VM agent? Cloud-init? Agent subprocess inside the container?
3. **Pull logs for that layer before changing anything.** (Sources below.)
4. **Read the logs in full** — not just the first error line. The root cause is often several messages before the visible symptom.
5. **Form a hypothesis grounded in a specific log line or CF API query result.** If you can't quote a log line or query result that justifies your next change, you are still guessing.
6. **Only then change code.**

### Where the Logs Actually Live

| Layer | How to read logs |
|-------|------------------|
| **API Worker (live stream)** | `cd apps/api && npx wrangler tail --env staging` |
| **API Worker (historical, last 7 days)** | Admin UI → `/admin/logs` (backed by Cloudflare Observability API) |
| **API Worker (errors, structured)** | Admin UI → `/admin/errors` (D1-backed error store) |
| **Worker real-time dashboard** | Admin UI → `/admin/stream` (Tail Worker via `AdminLogs` DO) |
| **VM agent (live stream)** | Admin UI → Node detail page → `LogsSection` component (streams from VM agent `/logs` endpoint backed by `journalctl`) |
| **VM agent (via SSH)** | `ssh root@<node-ip> journalctl -u vm-agent -n 500 --no-pager` |
| **Container stdout/stderr** | `ssh root@<node-ip> docker logs <container-id> --tail 500` — container IDs come from VM agent workspace metadata |
| **Cloud-init** | `ssh root@<node-ip> cat /var/log/cloud-init-output.log` and `/var/log/cloud-init.log` |
| **Analytics / events** | Admin UI → `/admin/analytics` or direct Workers Analytics Engine query |
| **VM debug package (everything)** | `GET /api/nodes/:id/debug-package` — single tar.gz with cloud-init logs, journald, docker logs, system info, events DB, metrics DB, provisioning timings, network config, firewall rules, disk usage, process tree. **Use this first for any VM issue.** |
| **D1 database state** | Direct query via CF API: `curl -s -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" -d '{"sql":"<query>"}' "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"` |
| **KV state (feature flags, rate limits)** | Direct read via CF API — see `.claude/rules/32-cf-api-debugging.md` |
| **DNS records** | Direct query via CF API — see `.claude/rules/32-cf-api-debugging.md` |

### VM-Specific Failure Playbook

When a workspace/node misbehaves on staging:

1. **Download the debug package first.** This is the single most useful debugging tool for VM issues. It bundles everything into one tar.gz — no SSH required:
   ```bash
   # Download the debug package for a node (requires auth cookie)
   # Via staging API:
   curl -s -b "session=<cookie>" "https://api.sammy.party/api/nodes/<nodeId>/debug-package" -o debug.tar.gz
   tar xzf debug.tar.gz
   ```
   The archive contains: cloud-init logs, full journald (50k lines), VM agent logs, Docker container logs, docker ps/inspect, system info, events DB, metrics DB, provisioning timings, boot events, dmesg, syslog, iptables rules, network config (IP/routes/sockets), disk usage, and full process tree. This is everything you'd get from 15+ separate SSH commands in one download.

2. **Check VM agent heartbeats** via `/admin/overview` or `/admin/stream` — if heartbeats aren't arriving, the problem is cloud-init, networking, or TLS. Do NOT edit API Worker code until you've confirmed heartbeats are flowing.
3. **If you don't have an auth cookie**, SSH is the fallback: `ssh root@<node-ip> journalctl -u vm-agent -n 500 --no-pager` for agent logs, `docker logs <container-id>` for container logs, `cat /var/log/cloud-init-output.log` for provisioning.
4. **For container / agent failures**, check `docker-logs.json` in the debug package or `docker logs` via SSH — the Claude Code / Codex process writes its own stderr there.
5. **For ACP / session failures**, correlate the sessionId across API Worker logs (wrangler tail), VM agent logs (`vm-agent.log` in the debug package), and container logs (`docker-logs.json`) — the same ID should appear in all three.
6. **For slow boot issues**, check `provisioning-timings.txt` in the debug package — it shows per-step durations and total wall-clock time for the entire provisioning sequence.

### Control Plane Failure Playbook

When the API Worker or a Durable Object misbehaves on staging:

1. **Start a `wrangler tail --env staging` stream before reproducing** — many failures don't leave a durable trace; you need the live stream.
2. **Reproduce the failure while tail is running.** Capture every log line from the request.
3. **Check `/admin/errors` for any structured errors** that were written to D1 — these include full stack traces.
4. **For DO alarms / cron failures**, check `wrangler tail` at the moment the alarm was scheduled to fire. If nothing appears, the alarm didn't register.
5. **For cross-service failures** (Worker → VM agent, Worker → external API), log the outbound request URL and auth format — most cross-boundary bugs are contract mismatches (see rule 23).

### When Logs Are Insufficient

Occasionally the logs themselves are the problem — the code you need to debug isn't logging enough. In that case:

1. Add the log line (`console.log` / `slog.Info`) that would have made the bug diagnosable
2. Deploy once
3. Reproduce
4. Read the new log
5. Fix the real bug

This is still log-driven debugging — you're making the system more observable so you can see the truth, not guessing at fixes.

### Never Do This

- "Let me just try adding `await` here and see if that fixes it"
- "Maybe if I change the port to 8081 it'll work"
- "The last deploy didn't pick up — let me redeploy"
- "I'll just add a retry loop in case it's a timing issue"

Every one of these is a guess. Every one of these costs a deploy cycle. Every one of these can be ruled in or out by reading a specific log line. Read the log first.

## Assumption Verification Before Reporting Blockers

Do not tell the human you are blocked because of an environment assumption you have not tested. Before declaring that something cannot be done, you MUST try the cheapest direct verification step available.

### Required Procedure Before Reporting a Blocker

1. **Name the suspected blocker.** Example: "GitHub CLI may not be authenticated" or "the API tests may fail because dependencies are missing."
2. **Run the direct check.** Examples: `gh auth status`, `git remote -v`, `pnpm install`, documented package build order, `test -f <path>`, `which <binary>`.
3. **Try the obvious local recovery path** if the first failure has a standard remedy documented in the repo or tool output.
4. **Only then report the blocker**, including the exact check performed and why the result really prevents progress.

### Never Do This

- Assume GitHub auth is missing without running `gh auth status`
- Assume validation cannot run without trying `pnpm install` or the repo's documented build order
- Assume a file/path/config is absent without checking the filesystem
- Give up after the first failed command when the failure itself points to the next verification step

## Quick Compliance Check

Before deploying to staging for the first time on a feature:
- [ ] Every pure-logic branch has a unit test that passes
- [ ] Every API route has at least one integration test (Miniflare) that passes
- [ ] Every UI flow you can render locally has been rendered locally
- [ ] You have a specific question staging will answer — not "does this work?"

Before your second or later staging deploy on the same feature:
- [ ] You have read the logs from the most recent failure in full
- [ ] You can quote a specific log line that justifies the next change
- [ ] You are not guessing

Before telling the human you are blocked:
- [ ] You ran a direct environment check for the suspected blocker
- [ ] You tried the obvious documented recovery step when one existed
- [ ] You can quote the command/result that proves the blocker is real

## References

- Local dev guide: `docs/guides/local-development.md`
- Deployment troubleshooting: `docs/guides/deployment-troubleshooting.md`
- Admin observability: `specs/023-admin-observability/` + `/admin/*` routes
- VM agent log endpoint: `specs/020-node-observability/contracts/vm-agent-logs.md`
- Rule 13 (staging verification) — applies *in addition* to this rule; local-first does not exempt you from the final staging gate
- Rule 21 (timeout merge guard) — guessing wastes the execution budget and triggers this rule
