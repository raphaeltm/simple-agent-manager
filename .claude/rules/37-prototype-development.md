# Prototype Development

## When This Applies

This rule applies when building UI prototypes for design exploration, UX iteration, or visual auditing. Prototypes are built inside the real web app (`apps/web/`) with mock data to evaluate layouts, information architecture, and interaction patterns before committing to production implementation.

## Core Principles

1. **Prototypes live in the real app** — build them as pages in `apps/web/src/pages/` with their own route, not in a separate tool or static HTML. This ensures they use the real design system, components, and rendering environment.
2. **Prototypes are throwaway** — they exist to learn, not to ship. When a prototype graduates to production, the learnings are applied to the real feature and the prototype files are deleted.
3. **Prototypes NEVER deploy to production** — they may be committed to feature branches and PRs so other agents can iterate on them, but must be removed before any merge to main.

## Setup Requirements

### Vite Dev Server Configuration

The Vite dev server must be started with `--host 0.0.0.0` so it's accessible from outside the container. The `allowedHosts: true` setting is already configured in `apps/web/vite.config.ts`.

```bash
cd apps/web && npx vite --host 0.0.0.0
```

### Port Exposure

After starting the dev server, expose the port so it's accessible in the SAM environment:

```
# Use the SAM MCP expose_port tool
expose_port(port=5173, protocol="http")
```

The preview URL will be provided by the expose_port response. Share this URL with the user so they can preview in their workspace browser.

### Route Registration

Add prototype routes as **public/unauthed** routes in `App.tsx`, alongside existing prototypes like `/sam`:

```typescript
// In App.tsx — public routes section
<Route path="/prototype/<name>" element={<MyPrototype />} />
```

Prototype routes use the `/prototype/` prefix to clearly distinguish them from real app routes.

## File Organization

```
apps/web/src/pages/<prototype-name>/
  ├── index.tsx       # Main prototype component
  └── mock-data.ts    # Mock data (separate file for clarity)
```

Use kebab-case directory names matching the route: `/prototype/settings` → `pages/settings-prototype/`.

## Self-Contained Components (CRITICAL)

Prototypes MUST be fully self-contained:

- **No API calls** — no `fetch()`, no API hooks (`useProject`, `useNodes`, etc.)
- **No auth dependencies** — no `useAuth`, no `getUserId`, no session checks
- **Mock data only** — all data comes from the co-located `mock-data.ts` file
- **No global side effects** — no writes to context providers, no route guards

## Scrolling Wrapper (CRITICAL)

The app shell's layout can prevent prototype pages from scrolling. Every prototype MUST wrap its content in a scrollable container:

```typescript
<div style={{ height: '100vh', overflow: 'auto' }}>
  {/* prototype content */}
</div>
```

Without this, content that exceeds the viewport height will be clipped with no way to scroll.

## Use Existing Components

Prefer existing components from the codebase:

- `VmSizeCard` for VM size selection
- Components from `@simple-agent-manager/ui` package
- Design tokens from `packages/ui/src/tokens/semantic-tokens.ts`
- CSS variables from `packages/ui/src/tokens/theme.css`

When existing components don't fit the prototype's needs, use inline styles matching the app's design tokens. Do NOT add new CSS files or modify global stylesheets for prototype work.

## Style Guide Adherence

Prototypes must visually match the production app's look and feel:

- Use the app's color palette (CSS custom properties: `--color-*`, `--bg-*`, `--border-*`)
- Use the app's typography scale and font family
- Use the app's spacing rhythm (4px/8px grid)
- Use the app's border-radius and shadow conventions
- Match the app's dark theme (most prototypes will be dark-themed to match production)

This ensures the prototype is an accurate preview of what the production feature would look like, not a throwaway wireframe.

## Mock Data Strategy (CRITICAL)

Mock data must **stress-test the UI**, not just show the happy path. Include data that pushes boundaries:

| Scenario | What to include | Why |
|----------|----------------|-----|
| **Long text** | 200+ char names, 500+ char descriptions, long URLs | Catches overflow, wrapping, truncation issues |
| **Many items** | 15-30+ items in lists | Catches scroll, performance, and pagination issues |
| **Empty states** | Empty arrays, null/undefined optional fields | Catches missing empty-state handling |
| **Special characters** | Unicode, emoji, `<script>` tags, HTML entities | Catches encoding and XSS issues |
| **Single character** | One-letter names, minimal content | Catches minimum-width layout issues |
| **Mixed states** | Items in different states (active/inactive/error/pending) | Catches state-dependent rendering |
| **Realistic variety** | Multiple providers, multiple agents, different configs | Catches real-world diversity issues |

## Mobile-First, Both Viewports (CRITICAL)

SAM's primary use case is mobile. Prototypes MUST work well on both:

- **Mobile**: 375px width minimum — this is the primary viewport
- **Desktop**: 1280px width — must also work well, not just be a stretched mobile layout

Design mobile-first: start with the single-column mobile layout, then enhance for desktop (sidebar nav, multi-column grids, etc.).

### Viewport Testing

Run Playwright visual audits at both viewports before sharing the prototype:

```bash
# Mobile
npx playwright screenshot --viewport-size=375,667 http://localhost:5173/prototype/<name>

# Desktop
npx playwright screenshot --viewport-size=1280,800 http://localhost:5173/prototype/<name>
```

Save screenshots to `.codex/tmp/playwright-screenshots/` (gitignored).

## Production Graduation

When a prototype's design is approved and ready for production implementation:

1. **Extract the learnings** — document what worked, what changed, and key design decisions
2. **Implement in the real feature** — build the production version using real API data, proper auth, error handling, tests
3. **Delete the prototype** — remove the prototype directory, route from `App.tsx`, and any mock data files
4. **Do NOT copy-paste** — prototypes cut corners (no error handling, no loading states, no tests). The production implementation must be built properly.

## What Prototypes Are NOT

- **Not production code** — no tests needed, no error handling required, no staging verification
- **Not a shortcut to shipping** — "the prototype works, let's just ship it" is not acceptable
- **Not a substitute for specs** — prototypes explore UX; specs define requirements and acceptance criteria
- **Not deployed** — committed to branches for collaboration, but NEVER merged to main with the prototype route intact

## Quick Compliance Check

Before sharing a prototype:
- [ ] Route is under `/prototype/` prefix and unauthed
- [ ] No API calls or auth dependencies
- [ ] Scrollable wrapper in place
- [ ] Mock data includes stress-test scenarios (long text, many items, empty states)
- [ ] Works on mobile (375px) and desktop (1280px)
- [ ] Uses existing components and design tokens where possible
- [ ] Dev server started with `--host 0.0.0.0`
- [ ] Port exposed via SAM MCP `expose_port`

Before merging ANY PR to main:
- [ ] All `/prototype/*` routes removed from `App.tsx`
- [ ] All prototype page directories deleted
- [ ] No prototype mock data files remain
