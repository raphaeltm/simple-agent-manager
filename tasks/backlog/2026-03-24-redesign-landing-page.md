# Redesign Landing Page to Clean Sign-In

## Problem

The app landing page (`apps/web/src/pages/Landing.tsx`) is ~397 lines of marketing content (feature grids, agent comparisons, how-it-works steps, roadmaps). Users must scroll past 8 sections to sign in. This belongs on a public www site, not an app login page.

## Research Findings

- **File**: `apps/web/src/pages/Landing.tsx` — single component, no sub-components
- **Auth**: `signInWithGitHub()` from `../lib/auth`, `useAuth()` hook for redirect logic
- **UI components**: `Button`, `Card`, `Typography`, `Container` from `@simple-agent-manager/ui`
- **Styling**: Tailwind CSS v4 with semantic color tokens (`bg-canvas`, `text-muted`, etc.)
- **Agent badges**: Already exist as `span` pills in the hero section
- **GitHubIcon**: Inline SVG helper at bottom of file — keep
- **Auth redirect**: `useEffect` redirects to `/dashboard` if authenticated — keep
- **No existing env var** for public website URL; will use `simple-agent-manager.org` as default

## Implementation Checklist

- [ ] Rewrite `Landing.tsx` to a clean, centered sign-in layout:
  - Keep auth redirect `useEffect` and `handleSignIn`
  - Keep `GitHubIcon` component
  - Vertically center content on viewport
  - App name + 1-line tagline
  - Agent badges (4 pills)
  - Prominent "Sign in with GitHub" button
  - 1-2 line BYOC mention
  - Link to public website
  - Remove all marketing sections
- [ ] Write Playwright visual audit tests per `.claude/rules/17-ui-visual-testing.md`
- [ ] Verify lint, typecheck, and build pass

## Acceptance Criteria

- [ ] Landing page shows only: app name, tagline, agent badges, sign-in button, BYOC note, website link
- [ ] Content is vertically centered on viewport
- [ ] All marketing sections removed (How It Works, Agent Comparison, Features, BYOC detail, Roadmap, CTA, Value Props)
- [ ] Auth redirect to /dashboard still works when authenticated
- [ ] Sign in with GitHub button triggers OAuth flow
- [ ] Page looks correct on mobile (375px) and desktop (1280px) viewports
- [ ] No horizontal overflow on either viewport
- [ ] Playwright visual audit tests pass

## References

- `apps/web/src/pages/Landing.tsx`
- `apps/web/src/lib/auth.ts`
- `apps/web/src/components/AuthProvider.tsx`
- `.claude/rules/17-ui-visual-testing.md`
