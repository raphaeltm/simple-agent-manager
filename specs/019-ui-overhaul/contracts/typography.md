# Component Contracts: Typography Scale

**Feature**: 019-ui-overhaul
**Package**: `@simple-agent-manager/ui`
**Location**: `packages/ui/src/tokens/theme.css`

## Typography Scale Definition

### Token Format

Each tier defines three CSS custom properties:
- `--sam-type-{tier}-size` — font size in rem
- `--sam-type-{tier}-weight` — font weight (numeric)
- `--sam-type-{tier}-line-height` — unitless line height

### Scale

| Tier | Size | Weight | Line Height | CSS Class | Use Cases |
|------|------|--------|-------------|-----------|-----------|
| Page Title | 1.5rem (24px) | 700 | 1.2 | `.sam-type-page-title` | Top-level page headings (Dashboard, Projects, Settings) |
| Section Heading | 1.125rem (18px) | 600 | 1.3 | `.sam-type-section-heading` | Section headers within pages, card group labels |
| Card Title | 1rem (16px) | 600 | 1.4 | `.sam-type-card-title` | Entity names in lists, form section labels, dialog titles |
| Body | 0.9375rem (15px) | 400 | 1.5 | `.sam-type-body` | Primary content text, form descriptions, paragraphs |
| Secondary | 0.875rem (14px) | 400 | 1.5 | `.sam-type-secondary` | Supporting text, input labels, table headers, nav items |
| Caption | 0.75rem (12px) | 400 | 1.4 | `.sam-type-caption` | Timestamps, metadata labels, status text, help text |

### CSS Custom Properties

```css
:root {
  --sam-type-page-title-size: 1.5rem;
  --sam-type-page-title-weight: 700;
  --sam-type-page-title-line-height: 1.2;

  --sam-type-section-heading-size: 1.125rem;
  --sam-type-section-heading-weight: 600;
  --sam-type-section-heading-line-height: 1.3;

  --sam-type-card-title-size: 1rem;
  --sam-type-card-title-weight: 600;
  --sam-type-card-title-line-height: 1.4;

  --sam-type-body-size: 0.9375rem;
  --sam-type-body-weight: 400;
  --sam-type-body-line-height: 1.5;

  --sam-type-secondary-size: 0.875rem;
  --sam-type-secondary-weight: 400;
  --sam-type-secondary-line-height: 1.5;

  --sam-type-caption-size: 0.75rem;
  --sam-type-caption-weight: 400;
  --sam-type-caption-line-height: 1.4;
}
```

### CSS Utility Classes

Provided in `packages/ui/src/tokens/theme.css`:

```css
.sam-type-page-title {
  font-size: var(--sam-type-page-title-size);
  font-weight: var(--sam-type-page-title-weight);
  line-height: var(--sam-type-page-title-line-height);
}

.sam-type-section-heading {
  font-size: var(--sam-type-section-heading-size);
  font-weight: var(--sam-type-section-heading-weight);
  line-height: var(--sam-type-section-heading-line-height);
}

/* ... etc for each tier */
```

### Migration Guide

**Before** (inline fontSize):
```tsx
<h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Dashboard</h1>
<h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Section</h2>
<p style={{ fontSize: '0.875rem' }}>Description text</p>
<span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>Updated 2h ago</span>
```

**After** (typography tokens):
```tsx
<h1 className="sam-type-page-title">Dashboard</h1>
<h2 className="sam-type-section-heading">Section</h2>
<p className="sam-type-body">Description text</p>
<span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>Updated 2h ago</span>
```

### Section Spacing Token

Standard vertical gap between major page sections:

```css
:root {
  --sam-space-section: 2rem;
}
```

Usage:
```css
.page-sections {
  display: grid;
  gap: var(--sam-space-section);
}
```

### Responsive Behavior

Typography tokens are fixed (no responsive scaling). The sizes are designed to work at both mobile and desktop viewports. The existing `clamp()` pattern used in some page titles should be replaced with the fixed `--sam-type-page-title-size` token for consistency.
