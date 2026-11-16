# L5a: outbound-fetch guard (landing slice of the self-host work)

SAM task `01M7FCZD2APNNX1T08Z6ZJGMC7`; coordinator task `01M7FB384QHQ1TQCK95D0SX0TX`.
Branch `sam/task-l5-landing-slice-zjgmc7`. **Do not merge**: behaviour change on main, the owner
approves. When green, mark the PR ready and complete the SAM task.

## Problem

The self-host integration branch `sam/selfhost-pass-2` guards every outbound request whose URL a
user, admin or remote server chose (landing plan idea `01M72M9AEB933ZY8269D376DKC`, part 5 row L5,
items C11 and part of C13, finding F6). This slice brings that guard to main as one small PR,
ported onto main's package layout, with nothing that only the self-host build uses.

## Scope decisions (coordinator, 2026-11-15 ~10:55Z)

The full row was ~45 source files, above the ~30-file cap. Split approved:

- **L5a (this task)**: worker-core `network-hosts` (classifyHost, guardedFetch); admin setting
  `outbound.maxRedirects`; web push save + delivery; deployment-release image resolver uses the
  shared classifier; `check_dns_status` in its own module; agent sign-in JWKS fetch through
  guardedFetch; composable-credentials private-host refusal at save and skip-and-log at use
  (`resolveProxyUpstream`); F6 lint rule.
- **Left for L5b** (separate slice, dispatched by the coordinator): `lib/client-ip` (C9) and
  `lib/constant-time`. Findings for it:
  - `clientIpFromHeaders` trusts only `CF-Connecting-IP`, IP literals only; 13 call sites on the
    branch: `auth.ts` (BetterAuth `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']`),
    `middleware/app-error-handler.ts`, `middleware/rate-limit.ts`, `routes/analytics-ingest.ts`,
    `routes/bootstrap.ts`, `routes/chat-load-diagnostics.ts`, `routes/client-errors.ts`,
    `routes/device-flow.ts`, `routes/node-lifecycle.ts`, `routes/setup.ts`,
    `routes/workspaces/local-forward.ts`, `services/email-sign-in.ts`,
    `services/webhook-ingress-http.ts`. Main still reads `X-Forwarded-For` in
    email-sign-in, webhook-ingress-http, device-flow, analytics-ingest, bootstrap, client-errors,
    rate-limit.
  - `lib/constant-time.ts`: on main its only user would be `services/platform-config-setup-token.ts`
    (inline copy today); the branch's other users are self-host reverse-tunnel files.
- **Left for L12**: `guardedFetch` on the AI-proxy passthrough upstream calls and the
  `ai-proxy-passthrough.ts` split (hottest path; L12 owns the file). Open until then: a custom
  **public** base URL that answers a redirect is followed by the runtime, not re-checked per hop.
  On Cloudflare the follow cannot reach the installation's private network; the credential's own
  key can go to the redirect target. Production has 0 such credentials (pre-check below).
- **Left for L6**: GitLab guard and `integration.gitlab.allowPrivateNetwork`; node
  `redirect: 'manual'`. **Left for L20**: app-deployment R2 presign target changes.

## Research findings

- Main's image resolver (`packages/app-deployment/src/image-resolver-outbound.ts`, 649 lines) had
  its own blocklist; the shared classifier refuses more (single-label, `.lan`, `.home.arpa`, Azure
  WireServer, 6to4/NAT64/Teredo embeddings). The file was over 500 lines, so the OCI helpers move
  to `image-resolver-oci.ts` (branch split) → 437 + 91.
- Web push delivery already used `redirect: 'manual'`; save-time validation only required HTTPS.
- Agent-key never hands a custom base URL to the VM (`routes/workspaces/runtime.ts`: base-URL
  credentials always get `__sam_proxy__` + passthrough config, incompatible → 404), so the Worker
  is the only caller of a stored base URL. A private base URL has never worked on Cloudflare.
- `check_dns_status` lived in `routes/mcp/workspace-tools-direct.ts` and returned raw error text.
- The admin settings cache is per isolate (`admin-settings-resolution.ts` `cache.read` with max age),
  so `resolveOutboundMaxRedirects` costs no I/O on a warm isolate.
- The branch's F6 inventory (`apps/api/tests/unit/lib/outbound-fetch-*.ts`) is a test-time AST
  inventory with a 694-line allowlist; it is not ported. The lint rule replaces it.
- Push subscriptions live only in per-user `NotificationService` DO SQLite: no read-only path.

## Production pre-check (read-only, 2026-11-15 ~10:53Z, counts only)

- Custom base URL credentials: **0**. `cc_credentials` by kind: api-key 4, auth-json 2,
  cloud-provider 3, oauth-token 8, openai-compatible 0. `cc_configurations` with `settings.baseUrl`:
  0 of 16. Legacy `credentials`: agent-api-key 13, capacity-source-external-ref 2, cloud-provider 4
  (no base URLs).
- Push subscriptions: **not countable read-only** (reasoning, not a count, accepted by the
  coordinator): endpoints come from browser PushManager (FCM, Mozilla autopush, Apple, WNS, all
  public names); the rule refuses only private/metadata/single-label names and private/reserved
  literals, which a Cloudflare Worker cannot deliver to today. Refused rows are skipped with
  `web_push.endpoint_refused` so the number is readable from logs after deploy.

## Implementation checklist

- [x] worker-core `network-hosts`: classify.ts, guarded-fetch.ts, index; exported from worker-core
- [x] Trim branch-only exports (isAcceptableOperatorEndpoint etc.: consumers are L12/L20)
- [x] Comments describe Cloudflare behaviour; no self-host-only code ships (comments may mention self-hosted runtimes as context)
- [x] `outbound.maxRedirects` admin setting + `outbound-fetch-settings.ts`, registered
- [x] Web push: schema + `validateEndpoint` public-host check; delivery `assertOutboundUrl`
- [x] Composable credentials: save-time refusal; `resolveProxyUpstream` skip + log
- [x] Agent sign-in issuer keys via `guardedFetch` (`maxRedirects: 0`)
- [x] `check_dns_status` module (same-origin hops, fixed categories)
- [x] Image resolver uses `classifyHost`; OCI helpers split out
- [x] Tests through real callers + discrimination checks (passthrough 9 red; resolver 7 red)
- [x] F6: `sam/no-unguarded-outbound-fetch`, ratchet baseline (44 sites / 32 files), RuleTester tests
- [x] Docs: configuration.md section, notifications.md, agent-sign-in.md, quality README, rule doc
- [x] Note on idea `01M72M9AEB933ZY8269D376DKC` for L12 (passthrough per-hop gap): note `01M7FEE8XED8RSW9TG1E0ZX4NY`
- [x] Full quality suite (CI green on af6abe1d, 12a5c760 and f2e651e9; local check:fast + typecheck on each merge)
- [x] Reviewers: security-auditor, cloudflare-specialist, architecture-reviewer, performance-reviewer, test-engineer, task-completion-validator (all PASS/ADDRESSED, see below)
- [x] Staging, on staging2 (`sammy2.party`) under the environment lease: push subscribe + receive; agent sign-in via workload identity; deployment-release image resolve (public image + refused registries); `check_dns_status`; credential with custom public base URL saved + refused private hosts; cleanup. One partial gap: the made-up-key session never showed the upstream answer (see Staging evidence)
- [ ] PR ready (not merged), CodeRabbit requested and waited

## Staging recipe (as planned; superseded, see Staging evidence)

The plan below was written for primary staging with the owner's OpenCode key. The coordinator
withdrew the key (16:05Z: never use it on staging) and primary staging later became locked to
PR #2721's Durable Object migration history (v23), so verification ran on staging2 with a made-up
key and the platform AI proxy instead.

Preparation outside the authenticated job: deploy `deploy-staging.yml` on the frozen head, wait
green, read-only checks (`/health`, deployed version, platform cloud credential row present, no
staging node owned by this task). Late read-only proof after the job: staging D1 shows the owned
node/workspace `deleted`, no `l5a-probe` credential/configuration/environment rows.

Job 1, agent sign-in (separate, short, no browser): `exec_with_secrets` with
`oidc.audience = https://api.sammy.party/api/auth/workload-identity-login`; exchange, `GET
/api/auth/get-session` with the returned cookie (print user id only), `POST /api/auth/sign-out`,
`GET get-session` → null. The cookie never leaves process memory.

Job 2, the ONE authenticated job (`.tmp/l5-scripts/staging-l5a.mjs`, primary smoke user,
`SAM_PLAYWRIGHT_PRIMARY_USER` + `SELFHOST_TEST_OPENCODE_API_KEY` in memory only), project
`01KWHD8XS7MQ7R6KWXJYRHDVH4` (Potato, smoke user's own):

1. token-login once in a Playwright browser context; dashboard, projects, settings load.
2. Push: read VAPID key; register a real Mozilla autopush channel (Node client, no browser push);
   `POST /api/notifications/push/subscriptions` (expect 200); refused `127.0.0.1` and
   `169.254.169.254` endpoints (expect 400).
3. Credential: refused `https://10.0.0.5/v1` and `https://169.254.169.254/v1` (expect 400);
   create `l5a-probe-opencode-zen` with base URL `https://opencode.ai/zen/v1` (owner's
   OpenCode test key, free model `deepseek-v4.1-flash-free` only); configuration for `opencode`;
   refused configuration `https://localhost/v1` (400).
4. Image resolver: create environment `l5a-probe-*`; JSON release with `docker.io/library/busybox:1.36`
   → `MANIFEST_VALIDATION_FAILED` (digest resolved, no node, no release row); `10.0.0.5:5000/...`
   and single-label `registry/...` → `IMAGE_RESOLVE_FAILED` "not a public registry endpoint".
5. Session: one VM conversation task (`agentType: opencode`, the probe configuration via
   `agentConfigurationId`) asking the agent to call `check_dns_status` and then
   `request_human_input`; wait for the push on the autopush socket and decrypt it; read the DNS
   result from the session messages. Uses the custom public base URL through the passthrough.
6. Cleanup in `finally`, restore-first: stop session, close task, delete workspace, delete node,
   delete environment, configuration, credential, our push subscription; verify none left;
   sign out (200), `get-session` null, browser closed, job terminal.

Cutoffs: admission cutoff 50 min after job start (no new step starts after it), cleanup reserve
12 min, session wait at most 20 min. Ledger of owned ids: `.tmp/l5-staging/ledger.json`
(ids only), rerunnable with `--phase=cleanup`.

Resources and cost: one platform Hetzner node at the project default size (small, cx23-class,
about EUR 0.006/h) for under 40 min, no deployment node (the resolver check creates no release).
All-in upper bound under USD 0.10 including Worker requests, D1/DO operations, R2 (none written)
and egress (a few MB). Zero VMs at rest afterwards.

## Staging evidence (staging2, 2026-11-15 23:28Z to 2026-11-16 00:44Z)

Why staging2: no Shepherd grant for the 16:10-17:50Z window (NOFIT 16:43Z, zero effects); primary
staging then ran PR #2721's unmerged DO migration v23 / D1 0242, which every branch built from
main (v22 / 0241) fails the deploy preflight against. Coordinator moved L5a to staging2.

- Lease: staging2 acquired 23:28:08Z by deploy run 43774931811 (head f2e651e9, a second merge of
  main for #2766, no L5a file changed; smokes PASS); renewed once (run 43778837053); released
  00:44:28Z (run 43782130599, deployment 7812670003 `released`).
- Harness: `staging-l5a.mjs` v9.3 (library `/l5a-staging/`, sha256 d6eb9d31...), 8 runs. Every run
  ended with cleanup resolved and a verified sign-out (200, then `get-session` null).
- Agent sign-in via workload identity (runs 1-2, as `staging2-agent-user`): exchange 200, session
  user matches. This is the path whose issuer-key fetch now goes through `guardedFetch`.
- Push, as `staging2-agent-admin` via the staging smoke token (coordinator option (a), 00:45Z;
  workload-identity sessions are refused push subscription by design, `rejectAgentSignInSession`):
  subscribe 201 (Mozilla autopush endpoint); `127.0.0.1` and `169.254.169.254` endpoints refused
  400 at save (runs 3, 4, 5, 6); one real push decrypted on the autopush channel for session B
  (run 6). Later runs hit the push-subscription rate limit (429), which is expected.
- Credentials: private `10.0.0.5` and metadata `169.254.169.254` base URLs refused 400; public
  `https://opencode.ai/zen/v1` saved 201; private configuration refused 400 (every run).
- Image resolver: public GHCR image resolved to a digest (MANIFEST_VALIDATION_FAILED after
  resolution, the expected outcome); private and single-label registries IMAGE_RESOLVE_FAILED.
- `check_dns_status` (run 6, claude-code on the platform proxy, agent settings untouched): structured
  result `status ok`, httpStatus 522 (workspace still starting), no raw error text.
- Partial gap, custom base URL at use time: the OpenCode session on the made-up-key configuration
  ran a turn (run 8: `awaiting_followup`) but produced no assistant message in 6 minutes, so the
  upstream 401 never surfaced in chat and the reach could not be observed. Save-time refusal and
  acceptance are proven above; the use-time skip-and-log of a private stored row is covered by
  `apps/api/tests/unit/ai-proxy-passthrough.test.ts`.
- Late proofs (`late-proof.py` v4) PASS for every node created: `DELETE /api/nodes/:id` removes the
  row only under `runtime_termination_confirmed_at` (`routes/nodes/delete.ts:removeManagedNodeRecords`).
  Final D1 sweep: 0 run-tagged projects/credentials/configurations/environments, 0 live Hetzner
  nodes, admin owns 0 projects, both users' agent settings unchanged.
- Harness findings (not product defects): Docker Hub answers the Worker's anonymous manifest requests
  with 429 (GHCR used instead); `cx23` is pool size `small` while `POST /api/nodes` defaults to
  `medium` (filed: `tasks/backlog/2026-11-16-node-create-native-offering-size-mismatch-message.md`);
  a default task's reservation does not fit `cx23` after the 1 GB host reserve (cx33 used); the
  pre-existing staging2 project is `repo_provider=github`, so task submit needs a GitHub token (own
  Artifacts project used); a task submitted 5 s after the first heartbeat got "Specified node is
  not reachable" (45 s settle added).
- Cost: 6 Hetzner VMs (one cx23 x2, cx33 x4), each alive under 10 min; under USD 0.05 in VM time
  plus one short Claude Code session on the platform proxy.

## Evidence log

- Lint probe (2026-11-15): a throwaway `apps/api/src/zz-probe.ts` with `fetch(u)`, `(0, fetch)(u)`,
  `Reflect.apply(fetch, …)`, `globalThis.fetch(u)` and `{ fetchFn: fetch }` gave 5
  `sam/no-unguarded-outbound-fetch` errors (run from `apps/api`, as turbo does); `typeof fetch`
  gave none. Appending one `fetch` to `apps/api/src/auth.ts` (baseline 2) gave 3 errors.
- Discrimination: passthrough refusals 9 red against main's `isHttpsUrl`; multi-candidate skip red
  with `continue` → `return null`; image resolver 7 red against main's blocklist; push DO save red
  without the `classifyHost` check; push DO stored-row test red without the delivery
  `assertOutboundUrl` (the VAPID signer also rejects the host, but only after retries and without
  `web_push.endpoint_refused`); lint acknowledged-line and type-query guards red when removed.
- Full API unit suite (before review fixes): 15,440 / 15,446 passed, 4 skipped; the 2 failures were
  tests added mid-run for code not yet saved, green on rerun.

## Review outcomes

- architecture-reviewer: no HIGH. Fixed: stale comment, setting description, unneeded exports.
  Kept the custom baseline over ESLint bulk suppressions (turbo runs ESLint per workspace with a
  different cwd, and the suppressions file is cwd-relative; one repo-wide JSON is reviewable).
  Kept `outbound.maxRedirects` (the row and the brief ask for the admin setting).
- performance-reviewer: no HIGH. check_dns_status may wait up to 5 s on a D1 stall before the
  settings fallback (accepted: agent tool call, rare). Refusal log per request on a refused
  credential (accepted: 0 such credentials in production).
- cloudflare-specialist: no HIGH. Fixed: docs state the passthrough gap; `httpStatus` kept on
  `redirect_refused`; unused `deadlineMs` removed; admin-settings guide mention.
- security-auditor: no CRITICAL/HIGH/MEDIUM; passthrough gap rated LOW on Cloudflare. Fixed: lint
  directive matching by rule id; destructuring/`Reflect.get` aliases; unreadable setting falls
  back to 0 hops. Not done here: `global_fetch_strictly_public` (changes every Worker fetch,
  including own-zone hosts; needs its own change and staging check).
- test-engineer: no HIGH. Added: push DO save refusal, stored private row through the DO fan-out,
  PATCH configuration base URL, multi-candidate skip, message assertions.
- task-completion-validator: no CRITICAL/HIGH. Fixed: idea note, probe evidence, wording.

## I/O per request (rules 59/60)

| Call site                                                | Runs on                                          | Extra I/O                                                                          |
| -------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Push save (`POST /api/notifications/push/subscriptions`) | user subscribes a browser                        | 0 (pure check)                                                                     |
| Push delivery                                            | each notification fan-out per endpoint           | 0 (pure check before the existing POST)                                            |
| Credential save/update                                   | user saves a credential                          | 0                                                                                  |
| `resolveProxyUpstream`                                   | every AI-proxy passthrough request               | 0 (pure check on the already-resolved row)                                         |
| Agent sign-in key fetch                                  | key-cache miss (default every 600 s per isolate) | 0 extra; same one fetch, now `redirect: 'manual'`                                  |
| Image resolver                                           | deployment release with tag-based images         | 0 (pure check replaces the old blocklist)                                          |
| `check_dns_status`                                       | agent calls the MCP tool                         | +1 admin-settings read, served from the per-isolate cache (0 D1 on a warm isolate) |

## Acceptance criteria

- [x] A private/metadata host is refused at every listed site; a public host still works (tests + staging2)
- [x] A stored refused credential is skipped and logged, never a 500 (test)
- [x] A new unguarded global fetch in Worker source fails lint (RuleTester + probe)
- [x] Defaults change nothing that works on an existing Cloudflare install (pre-check + reasoning)
- [x] Nothing self-host-only ships in the Worker
