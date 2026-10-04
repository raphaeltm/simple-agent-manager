# Tailwind never scans acp-client, so its package-only classes are missing in the app

## Problem

`apps/web/src/index.css` declares `@source "../../../packages/acp-client/dist";` so
Tailwind generates the utility classes used by `@simple-agent-manager/acp-client`
components. That file is not a Tailwind entry (`apps/web/src/app.css` is the one with
`@import 'tailwindcss'`), so the directive is never processed. The production build
passes it straight through: `vite build` logs
`[lightningcss minify] Unknown at rule: @source` for that line.

As a result an acp-client class exists in the shipped CSS only when some file under
`apps/web/src` or `packages/ui/src` happens to use the same class. For example,
`MessageActions` uses `min-w-[44px]`, which works only because `UserMenu.tsx` and
`GlobalAudioPlayer.tsx` also use it, while the message info popover's
`max-w-[calc(100vw-2rem)]` was never generated.

On 2026-10-04, adding `@source "../../../packages/acp-client/dist";` to `app.css` and
diffing the built CSS showed 33 classes that never reach the app:

- `MermaidDiagram.tsx` / `MermaidViewport.tsx`: `h-[180px]`, `h-[260px]`,
  `max-h-[420px]`, `bg-gray-950`, `bg-[#0b1110]`, `bg-red-950`, `text-red-950`,
  `rounded-b-lg`, plus related gray/red border and hover classes
- `AgentPanel.tsx` (workspace chat without a project session): `bg-red-600`,
  `space-x-1.5`, `hover:text-gray-600`, `border-blue-300`
- `AudioPlayer.tsx`: `min-w-[32px]`, `accent-[var(--sam-color-accent-primary,#16a34a)]`
- `VoiceButton.tsx`: `text-orange-500`, `text-blue-500`, `focus:ring-offset-1`
- `UsageIndicator.tsx`: `space-x-3`
- `ToolCallCard.tsx` / `MessageBubble.tsx` file-path links: `decoration-dotted`
- `MessageActions.tsx`: `max-w-[calc(100vw-2rem)]` (now replaced by an inline style)

These styles have never shipped, so turning the scan on changes how those components
look in production.

## Context

Found 2026-10-04 while adding Info and Copy buttons to user chat messages: a `w-max`
class on the message info popover had no effect in the built app, and `bottom-full`
is not generated either. That change used inline styles for the popover's width,
placement and z-index, so it does not depend on this fix.

## Acceptance Criteria

- [ ] acp-client classes are generated: the `@source` lives in the Tailwind entry
      (`app.css`), or the package is otherwise scanned, and the stale directive in
      `index.css` (with its comment) is removed
- [ ] A check fails CI when an acp-client class is missing from the built CSS, so this
      cannot silently regress
- [ ] Every component whose styles change (Mermaid diagrams, AgentPanel, AudioPlayer,
      VoiceButton, UsageIndicator, file-path links) has mobile and desktop Playwright
      screenshots reviewed before merge
- [ ] The inline styles in `MessageActions.tsx` (popover width, placement, z-index) are
      revisited, and their comment keeps pointing here until then
