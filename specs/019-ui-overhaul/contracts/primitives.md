# Component Contracts: UI Primitives

**Feature**: 019-ui-overhaul
**Package**: `@simple-agent-manager/ui`
**Location**: `packages/ui/src/components/`

## DropdownMenu

### Import

```typescript
import { DropdownMenu } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}

interface DropdownMenuProps {
  items: DropdownMenuItem[];
  trigger?: React.ReactNode;
  align?: 'start' | 'end';
  'aria-label'?: string;
}
```

### Behavior

| Event | Action |
|-------|--------|
| Click trigger | Toggle menu open/closed |
| Click item | Execute `onClick`, close menu |
| Click outside | Close menu |
| Escape key | Close menu, return focus to trigger |
| Arrow Down | Move focus to next item (wraps) |
| Arrow Up | Move focus to previous item (wraps) |
| Enter / Space | Activate focused item |
| Tab | Close menu, move focus to next focusable element |

### Rendering

- Default trigger: `<button>` with `MoreVertical` icon (lucide-react), 32x32px touch target
- Menu: `position: absolute`, anchored below trigger
- `align="start"`: Left edge aligns with trigger left edge
- `align="end"`: Right edge aligns with trigger right edge
- Mobile: Same behavior (no full-screen variant for menus)
- Danger items: Text color `var(--sam-color-danger)`

### Accessibility

- Trigger: `aria-haspopup="true"`, `aria-expanded="{isOpen}"`
- Menu: `role="menu"`
- Items: `role="menuitem"`, `tabIndex="-1"` (roving tabindex)
- Disabled items: `aria-disabled="true"`, `title="{disabledReason}"`

---

## ButtonGroup

### Import

```typescript
import { ButtonGroup } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface ButtonGroupProps {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}
```

### Behavior

- Renders children in a `display: flex` container with no gap
- First child: `border-radius: var(--sam-radius-sm) 0 0 var(--sam-radius-sm)`
- Last child: `border-radius: 0 var(--sam-radius-sm) var(--sam-radius-sm) 0`
- Middle children: `border-radius: 0`
- Adjacent borders collapse (negative margin or shared border)
- Passes `size` prop to all `Button` children via context or cloneElement

---

## Tabs

### Import

```typescript
import { Tabs } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface Tab {
  id: string;
  label: string;
  path: string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  basePath: string;
  className?: string;
}
```

### Behavior

| Event | Action |
|-------|--------|
| Click tab | Navigate to `basePath + tab.path` |
| Arrow Right | Move focus to next tab |
| Arrow Left | Move focus to previous tab |
| Home | Move focus to first tab |
| End | Move focus to last tab |
| Enter / Space | Activate focused tab (navigate) |

### Rendering

- Container: `display: flex`, `overflow-x: auto`, `border-bottom: 1px solid var(--sam-color-border-default)`
- Each tab: `<NavLink>` with `padding: var(--sam-space-2) var(--sam-space-4)`
- Active tab: `border-bottom: 2px solid var(--sam-color-accent-primary)`, `color: var(--sam-color-fg-primary)`
- Inactive tab: `color: var(--sam-color-fg-muted)`
- Hover: `color: var(--sam-color-fg-primary)`, `background: var(--sam-color-bg-surface-hover)`
- Scroll snap: `scroll-snap-type: x mandatory` on container, `scroll-snap-align: start` on tabs

### Accessibility

- Container: `role="tablist"`
- Each tab: `role="tab"`, `aria-selected="{isActive}"`, `tabIndex="{isActive ? 0 : -1}"`

---

## Breadcrumb

### Import

```typescript
import { Breadcrumb } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface BreadcrumbSegment {
  label: string;
  path?: string;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}
```

### Rendering

- Container: `<nav aria-label="Breadcrumb">`
- Inner: `<ol>` with `display: flex`, `gap: var(--sam-space-1)`, `list-style: none`
- Segments with `path`: `<Link>` with muted color, underline on hover
- Last segment (no `path`): `<span aria-current="page">` with primary color
- Separator: `/` in muted color between segments
- Font size: `var(--sam-type-secondary-size)`

---

## Tooltip

### Import

```typescript
import { Tooltip } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface TooltipProps {
  content: string;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}
```

### Behavior

| Event | Action |
|-------|--------|
| Mouse enter trigger | Start delay timer |
| Delay elapsed | Show tooltip |
| Mouse leave trigger | Hide tooltip |
| Focus trigger | Show tooltip (no delay) |
| Blur trigger | Hide tooltip |
| Escape key | Hide tooltip |

### Rendering

- Wrapper: `<span>` with `position: relative`, `display: inline-flex`
- Tooltip: `position: absolute`, positioned based on `side` prop
- Background: `var(--sam-color-bg-surface)`
- Border: `1px solid var(--sam-color-border-default)`
- Shadow: `var(--sam-shadow-tooltip)`
- Text: `var(--sam-type-caption-size)`, `var(--sam-color-fg-primary)`
- Padding: `var(--sam-space-1) var(--sam-space-2)`
- Border radius: `var(--sam-radius-sm)`
- Max width: `200px`

### Accessibility

- `role="tooltip"` on tooltip element
- `aria-describedby="{tooltipId}"` on trigger

---

## EmptyState

### Import

```typescript
import { EmptyState } from '@simple-agent-manager/ui';
```

### Props

```typescript
interface EmptyStateProps {
  icon?: React.ReactNode;
  heading: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}
```

### Rendering

- Container: `display: flex`, `flex-direction: column`, `align-items: center`, `padding: var(--sam-space-8)`
- Icon: 48x48px, `color: var(--sam-color-fg-muted)`, `margin-bottom: var(--sam-space-4)`
- Heading: `var(--sam-type-section-heading-size)`, `var(--sam-color-fg-primary)`, centered
- Description: `var(--sam-type-secondary-size)`, `var(--sam-color-fg-muted)`, centered, `max-width: 320px`
- Action: `<Button variant="primary">` with `margin-top: var(--sam-space-4)`
