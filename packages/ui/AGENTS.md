# UI Package (packages/ui)

## Purpose

Design system tokens and shared UI components for the control plane app. Provides the foundational visual language (colors, spacing, typography) via CSS custom properties and reusable React primitives.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — all components, primitives, hooks, tokens |
| `src/tokens/semantic-tokens.ts` | Design token definitions (TypeScript constants) |
| `src/tokens/theme.css` | CSS custom properties (consumed by Tailwind and components) |
| `src/components/` | Shared components (Button, Card, Dialog, Input, Select, Toast, etc.) |
| `src/primitives/` | Layout primitives (Container, PageLayout, Typography) |
| `src/hooks/` | Shared UI hooks |
| `src/styles.css` | Base styles imported by consumers |

## Commands

```bash
pnpm --filter @simple-agent-manager/ui build       # Compile TypeScript
pnpm --filter @simple-agent-manager/ui test        # Run Vitest
pnpm --filter @simple-agent-manager/ui typecheck   # Type check only
pnpm --filter @simple-agent-manager/ui lint        # ESLint
```

## Conventions

- Components use Tailwind CSS v4 utility classes with design tokens from `theme.css`
- All interactive components must meet 44px minimum touch targets (56px preferred for primary actions)
- Export every component from `src/components/index.ts` and re-export from `src/index.ts`
- CSS custom properties use `--sam-` prefix (e.g., `--sam-z-player`, `--sam-color-*`)
- Storybook files use `.stories.tsx` suffix (co-located with components)

## Gotchas

- UI changes here trigger mandatory Playwright visual audit on mobile (375px) + desktop (1280px) per rule 17
- Tailwind v4 uses `@tailwindcss/vite` plugin — config is in the consumer's vite config, not a `tailwind.config.js`
- This is a peer-dependency package — consumers must provide React 19+, lucide-react, react-router, tailwindcss
- Token values drive the entire app's visual appearance — changes here cascade everywhere
