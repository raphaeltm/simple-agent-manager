# Marketing site refresh: new feature pages, homepage copy, mock-data screenshots

**SAM task:** 01M2G89JCFTPMFQ9WQWBSS8VBF
**Branch:** `sam/marketing-site-feature-pages-ss8vbf` (single **draft** PR — do not merge; merging `apps/www/**` to main deploys the live site via `deploy-www.yml`)
**Status:** in progress

## Goal

Bring `apps/www` (marketing site) up to date with the product. Add feature pages and homepage
coverage, with screenshots generated from the real `apps/web` UI using mocked API data, for:

1. Multiplayer projects (invite links, access requests, members/roles, shared profiles/skills/secrets, all-sessions view, credential attribution, offboarding)
2. Comments on files and conversations (message + library-file threads, project Comments inbox, send-to-agent directive, resolve/reopen)
3. Compute pools spanning cloud providers (project/user/installation scopes, provider-native offerings, strategy, exhaustion policy, resource requirements, placement decision) **and** every reporting surface for compute + token usage that actually exists in the app
4. Event streams and triggers (cron + GitHub + webhook triggers with delivery history, project Events page: subscriptions, schedules, standing watches, channels, durable delivery outcomes)
5. Anything else uncommon among competitors: durable sleep/wake sessions, agent-to-agent durable messaging and missions, agent memory/policies (existing), app deployments, self-hostable AGPL control plane.

Constraints: copy must match what the screenshots show (no overselling); keep the dark-green glass +
Chillax + mascot brand; marketing-site changes stay on narrow CI; UI evidence (desktop + mobile
screenshots of every changed www surface) posted on the PR.

## Screenshot pipeline

- Real `apps/web` build served by `vite preview` on `http://localhost:4173` (`VITE_API_URL=http://localhost:4173`).
- Playwright specs in `apps/web/tests/playwright/marketing-shots-*.spec.ts` mock `/api/**` with rich fixture data, then write PNGs to `apps/www/public/images/features/` when `MARKETING_SHOTS=1` (tmp dir otherwise), following `docs-screenshots.spec.ts`.
- WebP siblings generated with `sharp` (Astro dependency) via `apps/www/scripts/optimize-feature-images.ts`.
- Evidence screenshots of the www pages themselves go to `tasks/evidence/2026-09-14-marketing-site-refresh/`.

## Screenshot contract (file names in `apps/www/public/images/features/`)

| Feature | File | Surface |
| --- | --- | --- |
| Multiplayer | `sam-collab-members-access.png` | Project Settings → Access: members, roles, pending request, invite link |
| Multiplayer | `sam-collab-all-sessions.png` | Project chat session list, all-sessions filter, several members |
| Multiplayer | `sam-collab-credential-attribution.png` | Credential Attribution panel |
| Comments | `sam-comments-inbox.png` | Project → Comments page grouped by waiting-on-you |
| Comments | `sam-comments-chat-thread.png` | Chat session with comments rail / thread on a message |
| Comments | `sam-comments-library-file.png` | Library file with comment panel |
| Compute | `sam-compute-pool-editor.png` | Infrastructure compute pool: multi-provider offerings, strategy, exhaustion |
| Compute | `sam-compute-placement-decision.png` | Session infrastructure panel / placement explanation |
| Compute | `sam-usage-tokens.png` | Token usage reporting surface |
| Compute | `sam-usage-compute.png` | Compute usage / node cost reporting surface |
| Events | `sam-triggers-sources.png` | Triggers page with cron, GitHub, webhook triggers |
| Events | `sam-webhook-deliveries.png` | Webhook trigger detail: credential/ingest URL, delivery history |
| Events | `sam-events-subscriptions.png` | Project Events: subscriptions, schedules, standing watches |
| Events | `sam-events-channels.png` | Event channel history |

(Adjust after the surface map confirms what exists.)

## Checklist

- [ ] Surface map of the real app routes/endpoints/types for the four features (explore agent)
- [ ] Playwright marketing screenshot specs written + run; PNG/WebP committed
- [ ] `features.ts` gains new sections; homepage showcase, hero, comparison, roadmap, how-it-works updated
- [ ] `/features/` index page; header nav updated
- [ ] Enterprise cost-control page reconciled with real reporting surfaces
- [ ] `pnpm --filter @simple-agent-manager/www lint/typecheck/build/check:links/test:browser` green
- [ ] Desktop + mobile Playwright screenshots of every changed www page reviewed and committed under `tasks/evidence/`
- [ ] Draft PR opened with preflight block, screenshot evidence, and a comment with images

## Notes

- Knowledge searched: BrandAssets (mascot-forward, #16a34a, Chillax, "SAM / simple agent manager" lockup), DeploymentTopology (www deploys from main only), ProductVision (usage reporting direction).
