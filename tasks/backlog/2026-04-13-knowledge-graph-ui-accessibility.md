# Knowledge Graph UI Accessibility & UX Fixes

**Created**: 2026-04-13
**Source**: Late-arriving ui-ux-specialist review on PR #693
**Average rubric score**: 2.4/5 — below 4/5 minimum in all categories

## Problem Statement

The Knowledge Browser page (`KnowledgePage.tsx`) has accessibility violations (no keyboard nav for entity cards, no form labels, hidden delete buttons on touch), interaction issues (no error feedback, no delete confirmation), and pattern inconsistencies (raw Tailwind colors, useParams instead of useProjectContext, plain text loading state).

## Checklist

### CRITICAL
- [ ] Replace `<div onClick>` in `EntityCard` with `<button onClick>` + `aria-label={entity.name}` (keyboard/screen reader users cannot activate entities)
- [ ] Make delete buttons visible on touch devices (remove `opacity-0 group-hover:opacity-100`, use `sm:opacity-0` instead)
- [ ] Add delete confirmation dialog before destructive `deleteKnowledgeEntity` calls

### HIGH
- [ ] Add `min-h-[44px]` to all buttons; `min-h-[56px]` to primary "Add Entity" CTA (current: 32px)
- [ ] Add `<label>` or `aria-label` to all form controls (entity name input, type select, description, add observation input)
- [ ] Add `break-words overflow-hidden` to EntityCard description paragraph for unbroken strings
- [ ] Replace `useParams` with `useProjectContext()` consistent with all other project sub-pages
- [ ] Fix hardcoded `confidence: 0.9` for explicit observations — use 1.0 for `sourceType: 'explicit'` or expose a control

### MEDIUM
- [ ] Replace raw Tailwind palette classes (`bg-blue-100`, `text-blue-800`, etc.) with semantic design-system tokens
- [ ] Replace "Loading..." text with `<Spinner>` component from `@simple-agent-manager/ui`
- [ ] Use `minmax()` columns in desktop split panel grid to prevent narrow panels
- [ ] Move `showAddObs`/`newObsContent` state into `EntityDetail` so it resets on entity switch
- [ ] Add `useToast` error feedback on all mutation failures (currently console.error only)
- [ ] Add `role="meter" aria-valuenow aria-valuemin aria-valuemax aria-label="Confidence"` to ConfidenceBar

### LOW
- [ ] `Back to entities` button needs `type="button"` and `min-h-[44px]`
- [ ] Hide filter chips when entity list is empty (no value filtering empty list)
- [ ] Style `<select>` in create form consistently with other selects in the app
- [ ] Replace `'...'` pending text in Add button with `<Spinner size="sm" />` + `aria-busy="true"`

## Acceptance Criteria

- [ ] Entity cards are keyboard-navigable (Tab + Enter/Space activates)
- [ ] Screen readers announce entity cards as interactive elements
- [ ] Delete buttons visible on touch devices without hover
- [ ] Delete actions require confirmation
- [ ] All form inputs have associated labels
- [ ] All buttons meet 44px minimum touch target
- [ ] Mutation failures show toast error messages
- [ ] Page uses `useProjectContext()` pattern

## References

- PR #693: https://github.com/raphaeltm/simple-agent-manager/pull/693
- UI/UX specialist review: full report in task output `ac971411cc109cb12`
- Key file: `apps/web/src/pages/KnowledgePage.tsx`
