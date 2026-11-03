---
name: sam-glass
description: How to build SAM app screens and components in the SAM Glass style (glass panes over a dark green void). Use when creating or restyling any page, panel, list, header, drawer, form or component in apps/web or packages/ui, or when asked about SAM's design system, glass, the void, people colours or mobile layout.
user-invocable: true
---

# SAM Glass

Read `docs/guides/sam-glass-design-system.md` first; the scoped rule `80-sam-glass.md` lists what is mandatory. This skill is the build recipe.

## Building a screen

1. **Shell.** The app shell carries `.sam-void`. Lay content out with a 16px frame and `--sam-space-gutter` (14px) gaps. Move the void's dark core behind the main content with `--sam-void-x` / `--sam-void-y`.
2. **Panes.** Each region is a pane: `.sam-glass .sam-glass-rim` with `rounded-[var(--sam-radius-pane)]`. Pick the variant:
   - sidebar, list, settings group, tool rail → pane
   - page header, message box, mobile app bar → `.sam-glass--slab`, radius `--sam-radius-slab`
   - a pane other panes sit on (conversation) → `.sam-glass--quiet`
   - one drawer or sheet at a time → add `.sam-glass-live` (the only live blur on screen)
3. **Header.** One page header slab: breadcrumbs, title (24/700), one-sentence subtitle that says what the page is for, at most one primary action, tabs if the page has sections (more than about eight sections → a side pane of nav items instead).
4. **Content.** Group settings in panes with `SettingRow`s (effect on the left, one control on the right, hairlines between). Lists of records → `DataTable` inside a pane. State → `Notice`.
5. **Elements.** Solid, never translucent: buttons (one primary per pane), chips (status tokens), avatars (solid person colour, 2px `--sam-separator` ring), counts (green running, amber waiting). Inputs and segmented controls are wells (`.sam-well`); the chosen option, current tab and secondary buttons are raised (`.sam-raised`).
6. **People.** `--sam-person-you` for the current user, `-1`…`-3` for teammates in join order (cycle past three), `-auto` for automations. Show ownership with a 14px avatar and name; show "shared with" with a 20px stack. Never use a person colour for a status.
7. **Mobile (≤767px).** One app bar slab: menu left (drawer from the left), project name, Recent chats + Notifications grouped in a well, the screen's main toggle raised at the right edge (its drawer from the right). 44px targets everywhere. 16px text in inputs.
8. **Verify.** Both themes and a mobile viewport. No faded avatars, no merged panes, at most one blurred element, text 4.5:1 on panes.

## Exact values

`reference/components.css` is the design system's working CSS for all 16 components (classes prefixed `sg-`, tokens named as in the design system). Copy values from it into Tailwind classes and the shared tokens; do not import it. Token name mapping:

| Reference token                                                                    | In code                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `--sam-glass-pane`                                                                 | `--sam-glass-v2-fill` (code keeps 0.74)                             |
| `--sam-glass-pane-quiet`                                                           | `--sam-glass-v2-fill-quiet`                                         |
| `--sam-glass-pane-thin` (overlay)                                                  | `--sam-glass-v2-fill-chrome`                                        |
| `--sam-glass-sheen`, `--sam-rim-*`                                                 | `--sam-glass-v2-sheen`, `--sam-glass-v2-rim-*`, `-bevel`, `-bounce` |
| `--sam-shadow-pane`, `-slab`, `-pane-quiet`                                        | `--sam-glass-v2-depth`, `-depth-slab`, `-depth-quiet`               |
| `--sam-inset-well`, `--sam-inset-shade`                                            | `--sam-glass-v2-well`, `-well-shade`                                |
| `--sam-raised`, `--sam-raised-edge`                                                | `--sam-glass-v2-raised`, `-raised-edge`                             |
| everything else (`--sam-person-*`, `--sam-count-*`, `--sam-void-*`, radii, gutter) | same name                                                           |

`reference/example-pages.md` describes the six example pages and the chat screens, region by region.
