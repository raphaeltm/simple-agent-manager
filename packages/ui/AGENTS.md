# UI Package (packages/ui)

## Purpose

Design system tokens and shared UI components for the control plane app. Provides the foundational visual language (colors, spacing, typography) via CSS custom properties and reusable React primitives.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — all components, primitives, hooks |
| `src/tokens/theme.css` | Design tokens — CSS custom properties (consumed by Tailwind and components); includes the `[data-ui-theme='sam']` dark and `[data-ui-theme='sam-light']` light themes |
| `src/components/` | Shared components (Button, Card, Dialog, Input, Select, Toast, etc.) |
| `src/primitives/` | Layout primitives (Container, PageLayout, Typography) |
| `src/hooks/` | Shared UI hooks |
| `src/styles.css` | Base styles imported by consumers |
| `src/glass/glass.css` | Glass v2 material (`.sam-glass`, `--chrome`, `-rim`, `-sheen`, `-live`), shared by the app and the marketing site; follows `[data-ui-theme]` and `html[data-theme]` |
| `src/glass/node-field.ts` | Framework-agnostic canvas renderer of SAM's node/workspace network as lit glass tiles (`createGlassNodeField`); `field-model.ts` holds its pure geometry and lifecycle |
| `src/components/GlassNodeField.tsx` | React wrapper for the node field (decorative background) |

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

- Glass and the node field are exported as source subpaths (`./glass.css`, `./glass/node-field`) so the Astro marketing site can import them without React. The marketing site's CI and deploy workflows watch `src/glass/**` and `package.json`.
- The package barrel re-exports only the renderer's types. `GlassNodeField` imports the renderer when it mounts, so app routes that never show the field never download it; do not add a static `export *` of `glass/node-field` to `src/index.ts`.
- Three glass vocabularies exist on purpose: the app's utility glass (`.glass-chrome`, `.glass-surface`, `.glass-modal` in `apps/web/src/index.css`, tokens `--sam-glass-*` in `theme.css`) for app chrome and overlays; the marketing site's older `--glass-*` tokens in `apps/www/src/styles/global.css`, still used by its inner pages; and Glass v2 here (`.sam-glass*`, `--sam-glass-v2-*`) for brand surfaces lit by a light source (marketing homepage, app sign-in). Use v2 for new brand-forward surfaces; do not mix vocabularies on one element.
- `glass.css` material rules use `:where()` (zero specificity) so consumer layout and surface rules win; the rim/sheen pseudo-elements need a positioned host. The app imports it into `@layer components` so Tailwind utilities can still override it.
- The node field paints one settled frame under `prefers-reduced-motion`, pauses offscreen and in hidden tabs, caps at 30fps, and is a no-op without a 2D canvas context (jsdom).

- UI changes here trigger mandatory Playwright visual audit on mobile (375px) + desktop (1280px) per rule 17
- Tailwind v4 uses `@tailwindcss/vite` plugin — config is in the consumer's vite config, not a `tailwind.config.js`
- This is a peer-dependency package — consumers must provide React 19+, lucide-react, react-router, tailwindcss
- Token values drive the entire app's visual appearance — changes here cascade everywhere
