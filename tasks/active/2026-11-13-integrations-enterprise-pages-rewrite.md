# Rewrite the Integrations and Enterprise marketing pages

## Problem

`/integrations/` and `/enterprise/` on simple-agent-manager.org contain claims the code contradicts, miss shipped
integrations, and read as generic SEO templates. Raphaël asked (2026-11-13) for a review from the target persona's
point of view and then for all of the proposed fixes.

Decisions from Raphaël (2026-11-13):

- There is **no hosted SAM service**. The main instance is his own, for himself and a few friends. Copy must present
  SAM as self-hosted open-source software only.
- Contact path: `support@simple-agent-manager.org`, framed as "get support", never sales.
- Publish an honest "not yet" list of missing enterprise capabilities.
- Keep the commercial-licensing line on the open-source page (he owns the code and repository).

## Research findings

Verified against code (file paths are evidence):

Integrations

- OpenCode inference providers are only `opencode-zen`, `opencode-go`, `custom` (`packages/shared/src/types/agent-settings.ts`).
  The page and `docs/guides/agents.md` still list SAM Platform, Scaleway, Vertex, Anthropic.
- Mistral Vibe offers Mistral Large 3, Mistral Small 4, Codestral, Ministral 3 (14B/8B/3B), Z.ai GLM 5.3
  (`packages/shared/src/model-catalog.ts`). No Devstral. The page is built around Devstral.
- Amp is a supported agent (`AGENT_TYPE_VALUES` in `packages/shared/src/agents.ts`) with no integration entry.
- Gemini CLI offers Gemini 4 Argon; the page omits it.
- SAM AI proxy mode exists only for Claude Code and Codex (`supportsSamProvider` in `apps/web/src/components/AgentSettingsCard.tsx`).
  Custom base URLs: Claude Code (`ANTHROPIC_BASE_URL`), Codex (`OPENAI_BASE_URL`), OpenCode custom provider
  (`packages/shared/src/harness-capabilities.ts`).
- GitHub is filed under "AI Models". GitLab repo hosting and sign-in, Google sign-in exist (`apps/api/src/auth.ts`, `packages/repo-hosting`).
- GCP: "Connect with Google" creates WIF resources automatically, or a service-account JSON key (`docs/guides/google-cloud.md`).
  GCP has no persistent volumes (`GCP_VOLUME_CAPABILITIES.supported = false`).
- Regions: Hetzner 5 (DE, FI, US), Scaleway 8 (FR, NL, PL), Infomaniak 2 (Geneva), Vultr 9, DigitalOcean 10, UpCloud 10
  (incl. US, SG, AU), GCP 8 zones. UpCloud is not "European"; Vultr is not "six continents".
- Workers AI: TTS and transcription do not go through AI Gateway (`apps/api/src/services/tts.ts`, `routes/transcribe.ts`).
- Shipped but unlisted: cron/GitHub/webhook (incl. Slack-signed)/email triggers, SAM Connector for Claude/ChatGPT,
  third-party MCP servers, workload identity, Instant sessions on Cloudflare Containers, app deployments, Web Push.
- Template: "Get started in four steps" hardcoded (`[slug].astro`); UpCloud has 1 step, DigitalOcean 3. Custom inline
  footer instead of `CtaFooter`. Get-started URL hardcoded. Hub meta description omits DigitalOcean/Antigravity.

Enterprise

- "SAM doesn't provision VMs using platform credentials / platform never has access" is wrong: fallback is project →
  user → platform (`resolveCredentialSource()` in `apps/api/src/services/provider-credentials.ts`).
- Agents run in Cloudflare Containers (Instant) when no cloud credential exists (`decideWorkspaceRuntime()`).
- "One agent per workspace" is wrong (`DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE = 10`).
- "Default 3 workspaces per node" is stale (reservation-based placement).
- Firewall is ingress-only (`:OUTPUT ACCEPT` in `packages/cloud-init/src/template.ts`).
- "Zero persistent attack surface" overstated (deployment nodes, user-owned nodes, warm reuse).
- Messages, tool output and workspace snapshots are stored in Cloudflare (ProjectData DO, R2), not only metadata.
- Quota unit is vCPU-hours (`monthly_vcpu_hours_limit`), not node-hours.
- No Bedrock/Vertex/Azure; custom base URLs only.
- Policies are per-project instructions, not enforced controls. No org entity, no audit export.
- No ADR files exist.
- Missing: SSO/SAML, SCIM, organizations, audit-log export, egress allowlisting.
- Sign-in: GitHub, Google, GitLab OAuth, email codes, optional signup approval. Roles: platform superadmin/admin/user;
  project owner/admin/maintainer/viewer.
- Mobile: comparison table shows only the SAM column; subpage back link and label share a line.

## Implementation checklist

- [ ] Integrations data: fix OpenCode, Mistral Vibe, Gemini, Claude Code, Codex, GCP, UpCloud, Vultr, Scaleway,
      Infomaniak formatting, Hetzner/GCP account FAQs, Workers AI, GitHub; add Amp and GitLab; Antigravity uses Google logo
- [ ] Integrations data: new categories (agents, compute, code hosting, platform AI) plus link-only "connect and automate" items to docs
- [ ] Integrations hub: sections by buyer question, agent comparison table, cloud comparison table, no duplicated card labels,
      shared `CtaFooter`, base-domain-derived URLs, accurate meta description
- [ ] Detail template: dynamic step heading, adaptive grids, shared footer, honest external link label, no HowTo JSON-LD
- [ ] Enterprise index: self-hosted framing, what-runs-where, data-location table, security answers, not-yet list,
      real screenshots, mobile-safe comparison, support CTA
- [ ] Enterprise subpages: fix every inaccurate claim; fix header layout; support CTA
- [ ] CtaFooter variant for support framing on enterprise pages
- [ ] Docs sync: `docs/guides/agents.md` OpenCode section; `docs/architecture/security.md` hosted wording
- [ ] Grep rest of www for the same false claims and fix
- [ ] Drift test: every agent in `AGENT_TYPE_VALUES` has an integration entry; listed models exist in the catalog
- [ ] Playwright: add /integrations/, an integration detail page and /enterprise/ to marketing-pages overflow + axe spec

## Acceptance criteria

- [ ] No claim on either page contradicts the code (each table/claim above fixed)
- [ ] Every supported agent and cloud provider has an entry; GitHub is not under AI Models
- [ ] Integrations hub shows comparison tables for agents and clouds
- [ ] Enterprise page states what runs where, where data lives, and an explicit "not yet" list
- [ ] Enterprise contact is support@simple-agent-manager.org with support framing, no sales language, no hosted-service implication
- [ ] No horizontal overflow or serious axe violations at 375px and 1280px on changed pages
- [ ] Drift test fails if an agent is added without an integration entry
- [ ] `pnpm --filter @simple-agent-manager/www lint typecheck test build` pass
