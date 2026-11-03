# SAM Glass design system

SAM Glass is how the app looks: glass surfaces floating over an open, dark green void. Light catches the edges of the screen and falls quickly into depth, panes catch that light on their rims, and the things you touch sit on the glass as solid objects.

- **Live reference:** the SAM Glass design system artifact (tokens, 16 components with previews in both themes, brand book) and the design canvas "SAM Glass Workspace Explorations" (chat, multiplayer, mobile, and six example pages). Links are in the PR that added this guide; ask Raphaël for access.
- **In code:** `packages/ui/src/glass/glass.css` (the material, shared with the marketing site) and `packages/ui/src/tokens/sam-glass.css` (people, counts, layout). Everything else stays in `packages/ui/src/tokens/theme.css`.
- **For agents:** the `sam-glass` skill (`.claude/skills/sam-glass/`) and the scoped rule `80-sam-glass.md`.

## Principles

1. **The void is the ground.** One per screen, on the app shell (`.sam-void`). Edges glow green, the centre falls to near-black. In light mode it inverts: grey-green edges, a blinding white centre. Nothing sits on the void directly except panes.
2. **Surfaces are glass; elements are solid.** Panes are the only translucent things. Avatars, buttons, chips, counts, switches and inputs are solid, or recessed into the glass as wells. Never fade an avatar or make a button see-through.
3. **Light comes from the edges.** A pane has rim light on its top edge, green bounce on its bottom edge, a sheen and a shadow deep enough to float (`.sam-glass .sam-glass-rim`). Something laid on another pane is a slab (`.sam-glass--slab`) with a deeper shadow and green light underneath.
4. **Leave gaps.** Panes are separated by `--sam-space-gutter` (14px) so the void shows between them. Don't merge columns into one block with borders.
5. **One blur at a time.** Regular panes don't blur what's behind them; their fill keeps text readable. Only one overlay at a time (a drawer, a sheet) gets `.sam-glass-live`. Several blurred panes over animated content made Chrome on macOS flicker the whole page.
6. **People have colours.** You are green (`--sam-person-you`). Teammates get cyan, violet and rose in the order they joined the project (`--sam-person-1` to `-3`), stable per project. Automations are grey (`--sam-person-auto`). A colour says who, never what state.
7. **Amber means it's waiting on you.** `--sam-color-warning` is for "needs input", notification counts and attention. Green is for things working. Neither is decoration.

## Layers

| Layer      | Class                                         | What it's for                                                                                         |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Void       | `.sam-void`                                   | The app shell background. Move its core behind the main content with `--sam-void-x` / `--sam-void-y`. |
| Quiet pane | `.sam-glass .sam-glass--quiet .sam-glass-rim` | A pane other panes sit on (the conversation).                                                         |
| Pane       | `.sam-glass .sam-glass-rim`                   | Sidebar, chat list, each settings group, tool rail.                                                   |
| Slab       | `.sam-glass .sam-glass--slab .sam-glass-rim`  | Page header, message box, mobile app bar.                                                             |
| Overlay    | `.sam-glass .sam-glass-live .sam-glass-rim`   | One at a time: drawers, sheets, popovers.                                                             |
| Well       | `.sam-well`                                   | Inputs, search, segmented controls, grouped icon buttons.                                             |
| Raised     | `.sam-raised`                                 | Secondary buttons, the chosen segment, the current tab.                                               |

Radii: panes `--sam-radius-pane` (20px), slabs `--sam-radius-slab` (22px), controls `--sam-radius-control` (12px). Frame: 16px from the screen edge. Gutters: 14px.

These replace the older glass utilities over time: `.glass-chrome` and `.glass-surface` become a pane, `.glass-modal` becomes an overlay. Don't mix the two systems on one screen.

## Tokens

All existing tokens keep their names and values. New ones:

| Token                                                                                | Where           | Use                                                         |
| ------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------- |
| `--sam-void-*`                                                                       | `glass.css`     | The void's base, core, core fade, edge, soft edge and wall. |
| `--sam-glass-v2-fill-quiet`, `-depth-quiet`, `-depth-slab`                           | `glass.css`     | Quiet panes and slabs.                                      |
| `--sam-glass-v2-well`, `-well-shade`, `-raised`, `-raised-edge`                      | `glass.css`     | Wells and raised controls.                                  |
| `--sam-person-you`, `-1`, `-2`, `-3`, `-auto`, `-ink`                                | `sam-glass.css` | People colours and the initials on them.                    |
| `--sam-separator`                                                                    | `sam-glass.css` | 2px ring around avatars and counts.                         |
| `--sam-count-active`, `-active-ink`, `--sam-attention-ink`                           | `sam-glass.css` | Count badges: green running, amber waiting.                 |
| `--sam-nav-active-top`, `-bottom`, `--sam-shadow-glow-active`, `--sam-shadow-accent` | `sam-glass.css` | Current nav item, open chat, primary glow.                  |
| `--sam-space-gutter`, `--sam-radius-control`, `-pane`, `-slab`, `--sam-hairline`     | `sam-glass.css` | Layout and dividers inside panes.                           |

Contrast: `--sam-color-fg-primary` and `--sam-color-fg-muted` meet 4.5:1 on panes in both themes. That's why panes keep a 0.74 fill without blur.

## Components to build

Build these in `packages/ui/src/components/` with Tailwind and the tokens above, a story each, exported from `src/index.ts`. The design system artifact has a working CSS version of each (copied in `.claude/skills/sam-glass/reference/components.css`); use it for exact values, not as a stylesheet to import.

**Built so far** (the chat and navigation pass): `Pane` + `PaneSeparator` + `paneClassName()`, `IconButton`, `Count`, `Chip` + `chipClassName()`, `PersonAvatar` + `AvatarStack` + `personSlotFor()`, `SegmentedControl`, `NavItem` + `NavLabel`, `SearchField`, and the `accent` and `raised` `Button` variants. In the app: the shell (`apps/web/src/components/AppShell.tsx`, `shell/DesktopSidebar.tsx`, `shell/MobileAppBar.tsx`), the session row (`pages/project-chat/SessionItem.tsx`) and `shell/GlassSheet.tsx`, the overlay every drawer and side panel uses. Still to build: `PageHeader`, `Tabs`, `Field`, `Switch`, `SettingRow`, `DataTable`, `Notice`.

| Component                                         | Replaces or extends                       | Notes                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Pane` (`variant`: default, quiet, slab, overlay) | `page-kit` `Panel`, `.glass-surface`      | Optional `title`, `hint`, `actions`; hairline separator helper.                                                            |
| `PageHeader`                                      | `page-kit` `PageHeader`                   | A slab: breadcrumbs, `title`, `subtitle`, `action`, optional tabs.                                                         |
| `Tabs`                                            | `packages/ui` `Tabs`                      | Current tab raised with a 2px green underline. More than about eight? Use a side pane of nav items (Admin).                |
| `NavItem`                                         | sidebar rows in `NavSidebar`              | Icon, label, optional count; current item raised and lit.                                                                  |
| `Button`                                          | `packages/ui` `Button`                    | Same variants and sizes; secondary becomes raised. One primary per pane.                                                   |
| `IconButton` + `Count`                            | ad hoc header buttons                     | 44px targets; counts green (`active`) or amber (`attention`); count in the `aria-label`.                                   |
| `Chip`                                            | `StatusBadge`                             | Same status tokens; mono text; `sm` size for rows.                                                                         |
| `Avatar`, `AvatarStack`                           | `packages/ui` `Avatar`                    | Solid fill in the person's colour, initials in `--sam-person-ink`, 2px separator ring; sizes 14/20/26/32; `selected` ring. |
| `SegmentedControl`                                | the My/All toggle in `ProjectChatSidebar` | A well with raised choices and optional counts.                                                                            |
| `Field`, `Search`                                 | `Input`, `Select`                         | Inputs are wells; visible labels; 16px text on mobile.                                                                     |
| `Switch`                                          | ad hoc toggles                            | Green with glow when on.                                                                                                   |
| `SessionRow`                                      | `SessionItem`                             | See "Chat list" below.                                                                                                     |
| `SettingRow`                                      | settings sections                         | Label and effect on the left, one control on the right, hairline between rows.                                             |
| `DataTable`                                       | admin tables                              | Mono uppercase headers, hairline rows, numbers right-aligned in mono.                                                      |
| `Notice`                                          | `page-kit` `Notice`, `LoadError`          | Info, warning, danger; keep the app's wording.                                                                             |
| `AppShell` void + gutters                         | `AppShell`                                | `.sam-void` on the shell; 16px frame; panes with 14px gutters.                                                             |

## Screens

**Desktop chat (A1).** Four panes over the void: sidebar, chat list, conversation column, tool rail. The conversation column is three panes: a slab for the session info, the message history, and a slab for the message box. Routed pages that are not chat surfaces sit in one content pane the shell provides (`isFullBleedRoute()` in `apps/web/src/lib/shell-routes.ts` lists the chat surfaces, which lay out their own panes).

**Chat list.** Each row: status icon (spinning green when working, moon when idle, amber when it needs you), one-line title, "shared with" avatars and a pull request badge on the right, then a meta line with the owner's 14px avatar and name ("You" for yours) and the age in mono. Rows someone else started get a thin light on the left edge in the owner's colour, so your own rows are the plain ones. Above the list: a segmented control (Mine / Others / All, with counts) and, beside it, small teammate avatars that filter to one person's sessions.

**Mobile (767px and below, as `useIsMobile`).** One floating app bar slab replaces today's two bars: menu on the left (its drawer slides from the left); project name; Recent chats and Notifications grouped in a well, because both work across projects; and the chat list button raised at the right edge, where its drawer slides in. The chat list drawer is the one overlay with live blur. Search and project settings move into the menu drawer.

**Settings, project and admin pages.** A page header slab with tabs, then panes for each group of settings using `SettingRow` and `DataTable`. Admin's 18 sections go in a side pane grouped as People (Users, Trials, Quotas), Platform (Settings, Integrations, Credentials, Infrastructure, Storage, AI Proxy), Spend (Costs, Usage) and Health (Overview, Errors, Diagnoses, Logs, Stream, Analytics, Eventing). Examples on the canvas: Project settings → Access, Automation, Settings → Agents, Settings → Infrastructure, Admin → Shared compute pool, Admin → Users.

## Data the designs need

| Design                                        | Status                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Owner on each session (`createdBy`, `isMine`) | Exists.                                                                                           |
| Mine / All filter                             | Exists (`scope=my` or `scope=all`).                                                               |
| Others, and one person's sessions             | Needs an API option; filtering "all" in the browser can miss sessions because the list is capped. |
| "Shared with" avatars on rows                 | Grants exist (`SessionAccessSummary`), but the list response doesn't include them yet.            |
| Stable person colours                         | Needs a per-project join order (or a stored colour index per member). Until then `personSlotFor()` hashes the user id, so a person keeps one colour on every screen. |
| "Jonas is writing", live cursors              | New realtime presence. Not designed into data yet.                                                |

## Writing

Plain and specific, saying what will happen. Settings say their effect ("New agents go to the least busy machine."), states say what to do next ("No machines are allowed, so SAM can't start any from this pool."), buttons are verbs ("Use here", "Replace…", "New automation"), your own things say "You", sentence case everywhere.

## Icons

Lucide (`lucide-react`) at 18–20px, 1.75 stroke, inheriting `--sam-color-fg-muted`; the current nav item's icon turns `--sam-status-success-fg`. No emoji in the UI.
