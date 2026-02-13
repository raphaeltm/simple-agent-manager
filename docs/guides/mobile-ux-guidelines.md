# Mobile UX Guidelines

## Critical Requirements for Mobile-First Design

### 1. Viewport Meta Tag (REQUIRED)
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

### 2. Touch Target Sizes
- **Minimum touch target**: 44x44px (iOS) / 48x48px (Android)
- **Buttons must have**: `min-height: 56px` on mobile
- **Use padding**: At least `py-3` or `py-4` for clickable elements

### 3. Typography Scaling
- **Never use fixed large text on mobile**
- **Always use responsive text sizes**:
  ```css
  /* BAD - Fixed size */
  .title { font-size: 2.25rem; }

  /* GOOD - Responsive */
  .title {
    font-size: 1.5rem; /* Mobile */
  }
  @media (min-width: 640px) {
    .title { font-size: 1.875rem; } /* Tablet */
  }
  @media (min-width: 1024px) {
    .title { font-size: 2.25rem; } /* Desktop */
  }
  ```

### 4. Grid Layouts
- **Mobile first**: Start with single column
- **Progressive enhancement**: Add columns at breakpoints
  ```html
  <!-- GOOD -->
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
  ```

### 5. Login/CTA Prominence
- **Primary CTA must be**:
  - Visually prominent (high contrast)
  - Large touch target (min 56px height)
  - Clear labeling
  - Above the fold
  - With helper text explaining the action

### 6. Padding and Spacing
- **Mobile padding**: Use `px-4` (1rem) minimum
- **Vertical spacing**: Use `py-8` for breathing room
- **Content max-width**: Use `max-w-md` or `max-w-lg` for readability

## Testing Checklist

Before deploying any UI changes:

- [ ] Test on actual mobile device or Chrome DevTools mobile view
- [ ] Verify all buttons are easily tappable (56px min height)
- [ ] Check text is readable without zooming (16px base minimum)
- [ ] Ensure login/primary CTA is immediately visible
- [ ] Test landscape orientation
- [ ] Verify forms are usable with mobile keyboard
- [ ] Check loading states work on slow connections

## Enforcement Examples

### 56px Touch Target (Required for Primary CTA)

```tsx
<button
  className="w-full px-4 py-4 text-base font-medium rounded-lg bg-blue-600 text-white"
  style={{ minHeight: '56px' }}
>
  Continue
</button>
```

### 320px Reflow Safety Check

```css
.screen-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 768px) {
  .screen-layout {
    grid-template-columns: 2fr 1fr;
  }
}
```

```tsx
<main className="screen-layout">
  <section style={{ minWidth: 0 }}>{/* content that can wrap */}</section>
  <aside style={{ minWidth: 0 }}>{/* avoid fixed-width cards */}</aside>
</main>
```

Use Chrome DevTools at width `320px` and confirm:
- no horizontal scroll for primary tasks
- no clipped CTA labels
- no overflowing fixed-width panels

## Common Mistakes to Avoid

1. **Fixed large font sizes** - Always use responsive sizing
2. **Desktop-only grid layouts** - Start mobile-first
3. **Small touch targets** - Buttons need proper padding
4. **Hidden login buttons** - Make auth prominent
5. **No visual hierarchy** - Use size, color, spacing to guide users
6. **Assuming desktop context** - Mobile users have different needs

## Implementation Pattern

```tsx
// GOOD - Mobile-first responsive component
function Component() {
  return (
    <div className="px-4 py-8"> {/* Mobile padding */}
      <h1 className="text-2xl sm:text-3xl lg:text-4xl"> {/* Responsive text */}
        Title
      </h1>
      <button className="w-full py-4 text-lg min-h-[56px]"> {/* Large touch target */}
        Sign In
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"> {/* Progressive grid */}
        {/* Content */}
      </div>
    </div>
  );
}
```

## CSS Framework Note

Currently using CSS Variables with semantic design tokens (not Tailwind). The system uses:
- Custom CSS properties in `packages/ui/src/tokens/theme.css`
- Semantic tokens in `packages/ui/src/tokens/semantic-tokens.ts`
- Shadcn-compatible component patterns
- Mobile-first responsive design approach

## Validation Before Deploy

Run this check before any deployment:

```bash
# Check for non-responsive text classes
grep -r "text-4xl\|text-3xl\|text-2xl" apps/web/src --include="*.tsx" | grep -v "sm:\|md:\|lg:"

# Check for non-responsive grids
grep -r "grid-cols-[2-9]" apps/web/src --include="*.tsx" | grep -v "sm:\|md:\|lg:"

# Check for small buttons
grep -r "py-1\|py-2\"" apps/web/src --include="*.tsx" | grep "button"
```

## Memory Hook

Add to CLAUDE.md and MEMORY.md:

> **Mobile UX Check**: Before any UI deployment, verify:
> 1. Login button is prominent and large (56px min height)
> 2. Text scales responsively (mobile → tablet → desktop)
> 3. Grids start single-column on mobile
> 4. Touch targets meet minimum size requirements
> 5. Test on actual mobile viewport

This prevents the "looks awful on mobile" and "can't find login" issues.
