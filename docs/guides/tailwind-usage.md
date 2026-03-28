# Quickstart: Using Tailwind CSS in SAM

**Date**: 2026-03-01 | **Branch**: `024-tailwind-adoption`

## Overview

SAM uses [Tailwind CSS v4](https://tailwindcss.com/) for styling. All design tokens are defined as CSS variables in `packages/ui/src/tokens/theme.css` and mapped to Tailwind utility classes via the `@theme` directive in `apps/web/src/app.css`.

## How It Works

1. **`theme.css`** defines CSS variables (`--sam-color-bg-surface`, `--sam-spacing-4`, etc.)
2. **`app.css`** maps those variables to Tailwind's `@theme` block (`--color-surface`, etc.)
3. **Tailwind generates utility classes** (`bg-surface`, `text-fg-primary`, `p-4`, etc.)
4. **Components use utility classes** in JSX `className` props

## Common Patterns

### Colors

```tsx
// Background colors
<div className="bg-canvas">       {/* Page background */}
<div className="bg-surface">      {/* Card/panel background */}
<div className="bg-inset">        {/* Recessed areas (inputs) */}
<div className="bg-accent">       {/* Primary action background */}

// Text colors
<span className="text-fg-primary"> {/* Primary text */}
<span className="text-fg-muted">   {/* Secondary/muted text */}
<span className="text-accent">     {/* Accent-colored text */}
<span className="text-danger">     {/* Error text */}

// Border colors
<div className="border border-border-default"> {/* Standard border */}
```

### Layout

```tsx
// Flexbox
<div className="flex items-center justify-between gap-4">
<div className="flex flex-col gap-2">

// Grid with responsive breakpoints
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
```

### Interactive States

```tsx
// Hover
<div className="hover:bg-surface-hover">
<button className="bg-accent hover:bg-accent-hover text-fg-on-accent">

// Focus
<input className="focus-visible:ring-2 focus-visible:ring-focus-ring outline-none">

// Disabled
<button className="disabled:opacity-50 disabled:cursor-not-allowed">
```

### Spacing

Tailwind uses a 4px base. `p-1` = 4px, `p-2` = 8px, `p-4` = 16px, `p-6` = 24px, etc.

```tsx
<div className="p-4">         {/* 16px padding all sides */}
<div className="px-4 py-2">   {/* 16px horizontal, 8px vertical */}
<div className="mt-4 mb-2">   {/* 16px top margin, 8px bottom */}
```

### Typography

Use the existing SAM typography classes (they coexist with Tailwind):

```tsx
<h1 className="sam-type-page-title">Page Title</h1>
<h2 className="sam-type-section-heading">Section</h2>
<p className="sam-type-body">Body text</p>
<span className="sam-type-caption text-fg-muted">Caption</span>
```

Or use Tailwind text sizing:

```tsx
<span className="text-sm">   {/* 0.875rem */}
<span className="text-base">  {/* 1rem */}
<span className="text-lg">    {/* 1.125rem */}
```

### Shadows

```tsx
<div className="shadow">          {/* Standard card shadow */}
<div className="shadow-md">       {/* Medium elevation */}
<div className="shadow-dropdown">  {/* Dropdown shadow */}
<div className="shadow-overlay">   {/* Overlay/modal shadow */}
```

### Z-Index

Use semantic z-index classes instead of numeric values:

```tsx
<div className="z-sticky">          {/* Sticky headers */}
<div className="z-player">          {/* Audio player bar */}
<div className="z-dropdown">         {/* Dropdowns */}
<div className="z-drawer-backdrop">  {/* Drawer backdrop */}
<div className="z-dialog">           {/* Dialogs/modals */}
```

### Responsive Design

Tailwind uses mobile-first breakpoints: `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px).

```tsx
// Stack on mobile, 2 columns on tablet, 3 on desktop
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

// Hide on mobile, show on desktop
<div className="hidden md:block">

// Different padding by screen size
<div className="p-4 md:p-6 lg:p-8">
```

### Tokyo Night Colors (Terminal UI)

For workspace/terminal-related UI, use the `tn-` prefixed tokens:

```tsx
<div className="bg-tn-bg text-tn-fg">
<div className="bg-tn-surface border border-tn-border">
<span className="text-tn-green">  {/* Success in terminal context */}
<span className="text-tn-red">    {/* Error in terminal context */}
```

## Rules

1. **Never use inline `style={}` for visual styling.** Use Tailwind classes.
2. **Never inject `<style>` tags at runtime.** All CSS goes through Tailwind or static CSS files.
3. **Never hardcode color values.** Always use token-backed utility classes (`bg-surface`, not `bg-[#13201d]`).
4. **`theme.css` is the source of truth** for token values. To change a color, update the CSS variable there.
5. **Use responsive prefixes** (`md:`, `lg:`) instead of media queries or `useIsMobile()` for layout.

## Adding a New Design Token

1. Add the CSS variable to `packages/ui/src/tokens/theme.css`:
   ```css
   :root {
     --sam-color-new-token: #abc123;
   }
   ```

2. Map it in `apps/web/src/app.css`:
   ```css
   @theme {
     --color-new-token: var(--sam-color-new-token);
   }
   ```

3. Use it in components:
   ```tsx
   <div className="bg-new-token">
   ```

## Migration Guide (Inline Styles → Tailwind)

When migrating an existing component:

1. Identify all `CSSProperties` objects and `style={}` props
2. Map each property to a Tailwind class (see contracts/token-mapping.md)
3. Remove the style object, add classes to `className`
4. Remove any runtime `<style>` injections — replace hover states with `hover:` variants
5. Verify visual output matches the original
6. Run tests to confirm no regressions
