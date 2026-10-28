# SAM installer prototype

An independent Cloudflare Worker with static assets and its own session Durable Object. It does not share SAM API, marketing scripts, data bindings, or login sessions.

**Preview status:** The hosted deployment may still run the earlier bootstrap prototype; check its displayed source revision. This branch adds durable owner recovery to the default bootstrap-only mode. It does not enable full installation by default.

**Experimental full mode:** Source-gated installation and update machinery is under development. It has not completed authenticated end-to-end OAuth, credential-revocation, and full in-account build validation. Do not treat it as a supported installer or infer hosted availability from this source. Use the established self-hosting guide for a complete SAM installation. Fresh deployments start in bootstrap mode. The ordinary deployment command preserves the currently deployed mode and consent scopes; it does not enable full mode on a bootstrap deployment.

Public user instructions: [Installer guide](https://www.simple-agent-manager.org/docs/guides/installer/). Source for that guide is `apps/www/src/content/docs/docs/guides/installer.mdx`.

## Deploy your own installer

Requires Node 22+, pnpm 9.15.9, a Cloudflare account with Workers Paid (SQLite Durable Objects), an active domain in that account, and a deployment token with Account Settings Read, Workers Scripts Write/Edit, and the zone permissions needed for Workers Custom Domains and Workers Routes. Creating an OAuth client or changing its consent scopes also requires OAuth Client Read/Write. An already configured Worker with both OAuth secret bindings and unchanged scopes can redeploy without OAuth client-management access. Use the smallest account/zone scope possible and consult Cloudflare's current permission names.

```sh
pnpm install --frozen-lockfile
# Supply credentials through your shell's secret manager; do not commit them.
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID
export BASE_DOMAIN=example.com
pnpm --filter @simple-agent-manager/installer run deploy
```

The script deploys `sam-installer-self-hosted` at `https://install.example.com`, creates a private OAuth client if none exists, and uploads its client ID/secret directly as Worker secrets. It reads the deployed Worker settings before choosing a capability mode:

| `INSTALLER_MODE`     | Behavior                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preserve` (default) | Keep the existing bootstrap/full mode and exact consent scope set. A fresh Worker starts in bootstrap mode.                                                                                         |
| `bootstrap`          | Remove `INSTALL_SOURCE_COMMIT` and use bootstrap consent scopes. An existing scope change must pass OAuth configuration preflight.                                                                  |
| `full`               | Explicit experimental opt-in. Validate the live scope catalog, configure and verify the private client's expanded consent, then pin `INSTALL_SOURCE_COMMIT` to the exact 40-character `GITHUB_SHA`. |

Every effective full-mode deployment, including `preserve` on an existing full deployment, pins installation source to that deployment's `GITHUB_SHA`. Full mode remains unverified until the authenticated staging installation, update, and credential-lifecycle checks pass; this switch is not proof those checks have passed.

When the deployed Worker has both OAuth secret bindings and the requested scopes are unchanged, reruns preserve those secrets without calling OAuth client-management endpoints. For fresh bootstrap deployments, approved static assets can deploy before OAuth setup fails; the command still exits unsuccessfully and does not claim readiness. Full enablement and scope changes on an existing Worker must configure and verify the client before publishing those requested settings. Permission failures are not silently skipped.

`OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` can override an existing client. An explicit client ID requires its private secret too; the callback must be `https://install.example.com/oauth/callback`. A failed secret write after client creation requires supplying or rotating the client secret before rerunning. Optional `OAUTH_REGISTRATION_TOKEN` supplies separate OAuth client-management authority when an operator already has that managed credential. It is used only for OAuth API calls, never Worker deployment or secrets writes, and is removed from Wrangler's environment. It is not a required deployment secret. OAuth credentials are never printed, placed in CLI arguments, or written to disk by the script.

Full-mode preview also reads the account's `workers.dev` address and includes the exact target in the approved plan. It preserves an existing address. If the account has none, provisioning can create only the previewed, explicitly approved address and reads it back before continuing; a changed address requires a new preview. This changes an account-wide setting. Cloudflare's [create-subdomain endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/) accepts Workers Scripts Write, already included in full-mode consent; Account Settings Write is not required for this operation. The API has no compare-and-set guard: an external administrator changing the setting between the final absence check and PUT remains a race the installer cannot eliminate. Coordinate account-wide changes during installation. Bootstrap-only mode still asks the operator to initialize a missing address.

Private OAuth clients are usable by members of their parent account. To serve other users, follow Cloudflare's [publisher verification and public promotion](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/). Public promotion is permanent and intentionally not automated.

## Development

`pnpm --filter @simple-agent-manager/installer dev` serves localhost:8787. Register a development OAuth client with `http://localhost:8787/oauth/callback`, then place `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` in gitignored `.dev.vars`. Never use production tokens in UI fixtures. Run `typecheck`, `lint`, `test`, and `build` with the same package filter.

Variables: `APP_ORIGIN` (exact origin), `SESSION_TTL_SECONDS` (60–3600, default 900), `OAUTH_SCOPES`, `SOURCE_URL`, `DOCS_URL`, `BUILD_SHA`. Deployment uses `BASE_DOMAIN`, `INSTALLER_ENVIRONMENT` (default self-hosted), `INSTALLER_MODE` (default preserve), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`; optional `OAUTH_REGISTRATION_TOKEN`, credential and source/docs URL overrides. Full mode also requires immutable `GITHUB_SHA`. Provider API origins and protocol parameters are constants, not configurable proxy destinations. Hosted authority budgets: `OAUTH_CLEANUP_RESERVE_SECONDS` (default 180), `MIN_PROVISION_SECONDS` (default 120), and `PROVISION_TIMEOUT_SECONDS` (default 240), each 30–3600 seconds. Short grants or insufficient remaining time are rejected before provisioning; mutation work has a separate deadline from cleanup.

## Repository deployment

`deploy-installer.yml` only runs in `raphaeltm/simple-agent-manager`. Pushes changing `apps/installer/**` on `sam/**` deploy staging; main deploys production. It can also be manually dispatched; production is restricted to main. Workflow-only/docs-only changes do not automatically deploy. It uses existing GitHub `staging`/`production` secrets `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and variable `BASE_DOMAIN`. It does not invoke the main SAM deployment. Both environments create private OAuth clients; public promotion is a separate operator action. Manual dispatch offers `mode: preserve | bootstrap | full`, defaulting to `preserve`. Automatic pushes always preserve the deployed mode/scopes. `full` is an explicit staging-proof opt-in and must not be treated as validated hosted availability. Optional environment secret `OAUTH_REGISTRATION_TOKEN` can supply existing managed OAuth registration authority; no new secret is mandatory.

## Security and lifecycle

Authorization codes use state and PKCE. The server stores tokens in an isolated expiring DO session, never localStorage. Browser gets a random HttpOnly session cookie. Account IDs are constrained to the provider's authorized account list; jobs bind to one account and use stable generated resource names. No arbitrary API proxy or arbitrary callback destination exists. Callback consumption precedes exchange. Sessions expire on access and via alarm, with best-effort token revocation on disconnect/handoff/expiry. Cloudflare authorization can also be revoked in the owner's profile.

The user-owned Worker accepts a short-lived, one-use claim by POST from the exact installer origin. Before submitting, the browser generates a separate recovery credential and asks the owner to save it. The maintenance coordinator stores its hash and issues an independent owner session; the saved credential works after the hosted session expires. Recovery login replaces the previous active maintenance session. Replacement uses prepare → save → confirm: the old credential remains valid until confirmation, so a lost response does not remove the owner's recovery path.

Handoff removes hosted OAuth and deployment-credential copies but retains the bounded claim record until the original installer expiry to permit retries. Access expiry is checked on every request. Cleanup and revocation are attempted on disconnect and expiry; provider failures can delay cleanup, so session expiry is not a guaranteed physical deletion or revocation deadline. No central refresh token is retained. If cleanup outlives the grant, expired credential/claim secrets are removed while a nonsecret token-ID journal and cleanup receipt remain. Reconnect with an authorized grant for the same account and use **Finish cleanup**; transferred service authority is preserved. The browser retains only the nonsecret receipt/account reference in tab session storage, never OAuth or deployment tokens.

In default mode, no ongoing Cloudflare deployment credential is transferred. Experimental full mode creates separate deployment, runtime, and storage principals and transfers authority to the user-owned service. It must prove derived credentials remain usable after bootstrap revocation before claiming independence. Installation credentials initially pass through the hosted bootstrap service; this is not a credentials-never-reach-us design.

Experimental full-mode builds preserve the approved SAM checkout and full Git history in the installation's R2 storage as a content-addressed bundle. An immutable manifest binds its commit, tree, byte count and SHA-256 digest. Same-source retries restore and verify those saved bytes instead of cloning SAM from upstream again; toolchain and dependency downloads can still need network access. A changed or missing accepted bundle stops recovery rather than silently selecting different source. Updates require an ahead, compatible upstream release and a fresh explicit approval; same-source resume retains its recorded validation proof. These source-preservation and update paths still require real installation validation.

The approved source and its build dependencies are trusted deployment code. The account-owned builder holds deployment authority; nested build containers provide toolchain compatibility, not a security boundary against malicious build scripts. The inner runtime build receives no cloud credential environment variables, and its mounted paths exclude the private R2 transport credential file, but it can modify source used by later deployment steps. Review the source and dependency changes before approving an update.

Created resources are retained. No automatic uninstall or database rollback is promised. Application observability is disabled to avoid persisting callback URLs. A hosted operator can change code; separate deployment is not trustlessness.

Maintenance-only variables are `OWNER_SESSION_TTL_SECONDS` (default 86400; accepted 60–2592000), `OWNER_RECOVERY_WINDOW_SECONDS` (default 900; maximum 86400), `OWNER_RECOVERY_MAX_ATTEMPTS` (default 10; maximum 100), and `OWNER_ROTATION_TTL_SECONDS` (default 900; maximum 3600). Real provisioned services require browser-generated recovery through `CLIENT_RECOVERY_REQUIRED=true`. These belong to the user-owned Worker, not the hosted installer. `BOOTSTRAP_OWNER_EMAIL` is an API Worker secret for experimental full installs: only that provider-verified identity can establish the first administrator. Election completion is recorded atomically and survives later owner account changes; ordinary authorization and suspension checks then apply. Preserve it across updates; `SETUP_TOKEN` separately authorizes initial provider configuration.

Deployment adds a hostname-specific `install.${BASE_DOMAIN}/*` Worker route alongside the custom domain, so SAM’s wildcard API route cannot intercept installer traffic. The staging workflow also provisions a temporary bootstrap Worker, checks anonymous rejection and authenticated ownership handoff, and deletes it in a finally block. This check uses the deployment token; it does not substitute for real OAuth consent verification.

## Brand assets

The installer uses the homepage's Chillax display font, green palette, mascot, and
shared glass material. Static copies keep the installer independently deployable:
`public/fonts/Chillax-Variable.woff2` and `public/sam-head.png` come from
`apps/www/public/`, and `public/glass.css` comes from `packages/ui/src/glass/glass.css`.
When those source assets change, refresh the copies and visually compare both sites.

The installer scene uses the **actual** shared glass node renderer from
`packages/ui/src/glass/`, compiled by `scripts/build-scene.mjs` before dev/build/deploy.
Generated browser modules live in gitignored `public/scene/`; no runtime request goes
to the marketing site. The floor is a still composition (including reduced motion),
and the tilted account-to-service panel is explicitly labelled as a preview.

The build-scene preparation also embeds the real font and mascot into the independent maintenance Worker. Its generated `src/maintenance-brand.generated.ts` is ignored by Git and regenerated before checks/dev/build/deploy; maintenance does not fetch brand assets from our hosted installer.
