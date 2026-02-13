# Human Review Required - Non-Code-Verifiable Claims

This document contains claims from the Simple Agent Manager documentation that cannot be validated through code inspection and require human review.

## Code Validation Summary

During the validation process, the following issues were found and corrected:

### Fixed Issues:
1. **VM Sizes** - Completely wrong server types and specs. Fixed:
   - Small: Was CX22 (2vCPU/4GB) → Now CX11 (1vCPU/2GB)
   - Medium: Was CX32 (4vCPU/8GB) → Now CX22 (2vCPU/4GB)
   - Large: Was CX42 (8vCPU/16GB) → Now CX32 (4vCPU/8GB)
   - Fixed in: claims.md, self-hosting.md

2. **TailwindCSS** - Not used. Project uses CSS Variables with semantic design tokens
   - Fixed in: claims.md, mobile-ux-guidelines.md, AGENTS.md

3. **API Endpoints** - Two endpoints don't exist:
   - POST /api/agent/ready - Removed (not implemented)
   - POST /api/agent/activity - Removed (not implemented)
   - PUT /api/credentials → Corrected to POST /api/credentials
   - Fixed in: claims.md, AGENTS.md

4. **Integration Tests** - Directory doesn't exist at apps/api/tests/integration/
   - Removed incorrect path reference in AGENTS.md
   - Marked as not existing in claims.md

5. **Coverage Threshold** - Claim of ">90% for critical paths" not enforced in vitest configs
   - Noted in claims.md but not removed as it's a requirement statement

## Categories Requiring Human Review

### 1. Project Status & Maturity Claims
- "SAM is described as 'fully vibe coded, with some code review, but not a lot yet'"
- "has not yet been tested"
- "The platform is pre-production and not ready for use"

### 2. Cost & Pricing Claims
- "2-3x cheaper than GitHub Codespaces"
- Hetzner VM hourly/monthly costs (€0.006/hour for CX22, etc.)
- Cloudflare free tier limits and overage pricing
- Cost comparison table with GitHub Codespaces

### 3. Performance Claims
- "fast ~1min propagation" for DNS
- "Review completes in <5 minutes for 50-100 docs"
- "Report generation <30 seconds"
- "95% of code references validated for accuracy"
- "Documentation coverage increased by 25%"
- "Time to understand documentation structure reduced by 50%"

### 4. External Service Claims
- GitHub App rate limits (5000/hour per installation)
- Cloudflare service limits and pricing
- Hetzner service specifications and pricing
- "1 hour expiry" for GitHub installation tokens

### 5. Future/Planned Features (Roadmap Phases 3-5)
- All Phase 3 Enhanced UX features (Q1 2026)
- All Phase 4 Multi-Tenancy features (Q2 2026)
- All Phase 5 Enterprise features (Q3 2026)
- Future considerations (GPU instances, Kubernetes workspaces, etc.)

### 6. Historical/Evolution Claims
- "Original decision: CloudCLI (third-party terminal UI)"
- "CloudCLI was unstable and overly complex"
- "Happy Coder dependency: Eliminated via CloudCLI web UI"
- Evolution from stateless to D1-based architecture

### 7. External Standards & Protocols
- "ACP (Agent Client Protocol) - Emerging industry standard"
- "Created by Zed Industries in partnership with Google"
- "As of Feb 2026: v0.14.1 with 160+ downstream dependents"
- List of agents supporting ACP

### 8. Security Best Practices Claims
- "Prevents replay attacks"
- "Prevents information disclosure"
- "Prevents unnecessary charges"

### 9. Design Philosophy Claims
- "Think 'GitHub Codespaces, but built for AI-assisted development'"
- "Green-forward, software-development-focused, low-noise interface aesthetic"
- "Cloudflare-first approach: No complex local testing setups"

### 10. User Experience Claims
- "automatic shutdown to eliminate surprise bills"
- "Login/CTA must be immediately visible without scroll"
- "readable default first" (mobile typography)

## Review Checklist

For each claim above, please verify:
- [ ] Is this claim still accurate and current?
- [ ] Should this claim be updated with new information?
- [ ] Should this claim be removed as no longer relevant?
- [ ] Does this claim need additional context or qualification?

## Notes for Reviewer

These claims fall into categories that require:
- **Business knowledge**: pricing, comparisons, market positioning
- **Historical context**: evolution of the project, past decisions
- **External validation**: third-party service specifications
- **Future planning**: roadmap items and planned features
- **Subjective assessment**: UX claims, design philosophy

Please review each section and provide feedback on accuracy and relevance.