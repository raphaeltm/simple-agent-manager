# Marketing Website for SAM

**Created**: 2026-02-20
**Status**: Active
**Branch**: `feat/marketing-website`

## Objective

Build a beautiful, performant marketing website that highlights SAM's value proposition and deploys to Cloudflare Pages via GitHub Actions.

## Technical Decisions

- **Framework**: Astro (static site, zero JS by default, perfect for marketing)
- **Location**: `apps/www/` in the monorepo
- **Styling**: Custom CSS using SAM brand tokens (forest green dark theme, Chillax font)
- **Deployment**: Cloudflare Pages via `wrangler-action@v3` in GitHub Actions
- **Domain**: `www.${BASE_DOMAIN}` or root `${BASE_DOMAIN}`

## Brand Assets

- Logo: `assets/images/logo.png` (1654x768)
- Icon: `assets/images/icon.png`
- Favicon: `apps/web/public/favicon.svg`
- Font: Chillax (variable, WOFF2) from `assets/fonts/chillax/`
- Colors: Dark forest green theme (canvas: #0b1110, surface: #13201d, accent: #16a34a, text: #e6f2ee)

## Site Structure

### Sections (Single Page)

1. **Hero** - Bold headline, tagline, CTA button, animated terminal/product preview
2. **Social Proof** - "Built on Cloudflare + Hetzner" logos, open source badge
3. **Features Grid** - 6 key features with icons
4. **How It Works** - 3-step visual flow
5. **Comparison Table** - SAM vs GitHub Codespaces
6. **Pricing/Cost** - Cost advantage highlight
7. **Roadmap** - Visual timeline of phases
8. **CTA Footer** - Sign up / Get started + GitHub link

### Design Principles (Inspired by Linear, Vercel, Supabase)

- Dark theme (matches the app itself)
- Thin borders, subtle gradients, glassmorphism accents
- Bold Chillax typography for headings
- Micro-animations on scroll (CSS-only, no JS)
- Mobile-first responsive layout
- Terminal/code aesthetic throughout

## GitHub Actions Deployment

- New workflow: `.github/workflows/deploy-www.yml`
- Triggers: push to main (when `apps/www/` changes), manual dispatch
- Steps: checkout, pnpm install, build Astro, deploy via wrangler pages
- Secrets needed: `CF_API_TOKEN`, `CF_ACCOUNT_ID` (already exist in production environment)

## Implementation Checklist

- [x] Create git worktree and feature branch
- [ ] Scaffold Astro project in `apps/www/`
- [ ] Configure brand fonts, colors, and favicon
- [ ] Build layout component (nav + footer)
- [ ] Build hero section
- [ ] Build social proof section
- [ ] Build features grid
- [ ] Build "how it works" section
- [ ] Build comparison table
- [ ] Build cost/pricing section
- [ ] Build roadmap timeline
- [ ] Build CTA footer
- [ ] Add responsive design for mobile
- [ ] Add scroll animations (CSS)
- [ ] Create GitHub Actions workflow for deployment
- [ ] Update pnpm-workspace.yaml
- [ ] Test build locally
- [ ] Push and open PR
