# SAM Glass Design System

A set of principles and tokens for building glassomorphic interfaces in SAM. These principles are derived from the mobile chat prototype and should guide implementation across the app.

---

## 1. The Glass Hierarchy

Every surface in the UI sits at a specific depth. Glass treatment communicates that depth through three properties that scale together: **blur**, **opacity**, and **shadow**.

| Depth | Role | Blur | Background Opacity | Example |
|-------|------|------|--------------------|---------|
| **0 — Canvas** | The void behind everything | none | 1.0 | `#0a0f0d` solid background |
| **1 — Chrome** | Persistent app structure (headers, input bars) | 20px | 0.55 | App header, session header, follow-up input |
| **2 — Surface** | Temporary overlays that appear over content | 24px | 0.65 | Session details panel, dropdown menus, tooltips |
| **3 — Modal** | Panels that demand focus and dim the background | 24px | 0.55 | Session drawer, nav drawer, command palette |

**The rule**: higher depth = more blur. But modals are *more transparent* than surfaces because they have a backdrop dim behind them doing the heavy lifting for contrast — the glass itself can be lighter.

---

## 2. Backdrop Blur + Saturate

Always pair `blur()` with `saturate()`. Blur alone washes out colors and makes the content beneath look grey and lifeless.

```css
backdrop-filter: blur(24px) saturate(1.4);
-webkit-backdrop-filter: blur(24px) saturate(1.4);
```

- **Blur range**: 20–28px. Below 16px doesn't read as glass. Above 32px looks heavy and "frosted bathroom window."
- **Saturate range**: 1.3–1.5. Restores color vibrancy lost to blur without creating oversaturated artifacts.
- Always include the `-webkit-` prefix. Safari requires it.

---

## 3. Directional Corners

Panels round only the corners on their **exposed edges** — the edges facing the content they float over. Flush edges stay square.

```
┌──────────────┐
│              │  Drawer from right:
│   content    │  round top-left and bottom-left
│              │  right edge is flush with viewport
│              │
└──────────────┘
border-radius: 20px 0 0 20px

┌──────────────────────┐
│    session header     │  Panel dropping down:
├──────────────────────┤  round bottom-left and bottom-right
│                      │  top edge is flush with header
│   details panel      │
│                      │
└──────────────────────┘
border-radius: 0 0 20px 20px
```

**Why**: Rounding all four corners creates a "floating card" look — the panel appears disconnected from its origin. Directional corners make it feel like the panel is physically sliding out from behind the viewport edge or extending from its parent element.

---

## 4. Edge Glow

Each glass panel has a thin luminous accent on its **leading edge** — the edge that enters the viewport or faces the content.

### Implementation

Use a `::before` pseudo-element:

```css
.panel::before {
  content: '';
  position: absolute;
  /* Position on the leading edge */
  top: 5%; bottom: 5%; left: -1px; width: 3px;
  background: linear-gradient(
    180deg,
    transparent 0%,
    rgba(34, 197, 94, 0.5) 25%,
    rgba(22, 163, 74, 0.7) 50%,
    rgba(34, 197, 94, 0.5) 75%,
    transparent 100%
  );
  filter: blur(2px);
  z-index: 1;
}
```

### Rules

- **Width**: 2–4px (before blur). After blur it diffuses to ~6–8px perceived.
- **Max opacity**: 0.5–0.7 at the brightest point. Never 1.0.
- **Gradient**: Always fade to transparent at both ends. No hard starts or stops.
- **Filter blur**: 1–3px. Creates soft light bleed without a hard neon line.
- **Placement**: Inset 5–10% from the ends of the edge so the glow doesn't reach the corners.

### Direction Map

| Panel type | Leading edge | Glow direction |
|------------|-------------|----------------|
| Right drawer | Left side | Vertical gradient (top→bottom) |
| Dropdown/popover | Bottom | Horizontal gradient (left→right) |
| Bottom sheet | Top | Horizontal gradient (left→right) |
| Left sidebar | Right side | Vertical gradient (top→bottom) |

---

## 5. Inner Wash

A `::after` pseudo-element creates a barely-perceptible directional gradient on the leading edge. This simulates light diffusing through the glass.

```css
.panel::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0; left: 0; width: 60px;
  background: linear-gradient(90deg, rgba(34, 197, 94, 0.05), transparent);
  pointer-events: none;
}
```

- **Opacity**: 0.03–0.06. If you can easily see it, it's too strong.
- **Width**: 40–70px. A soft, wide wash.
- **Direction**: Same as the edge glow — from the leading edge inward.
- **pointer-events: none**: Critical. This is decorative and must not intercept clicks.

---

## 6. Borders

Glass panels use a single 1px border in the accent color at low opacity. The border provides a crisp edge that the blur alone can't.

```css
border: 1px solid rgba(34, 197, 94, 0.15–0.22);
```

- **Opacity range**: 0.12–0.25. Enough to define the edge, not enough to draw the eye.
- **Omit borders on flush edges**: If a panel's top edge is flush with a header, use `border-top: none`. The parent's border already defines that edge.
- **Never use border-radius on the border alone** — always pair with the directional `border-radius` on the element itself.

---

## 7. Shadows

Shadows create the primary sense of depth. Each glass panel needs two shadows: a **depth shadow** (dark, large) and an optional **glow shadow** (accent color, subtle).

```css
box-shadow:
  /* Depth: large, dark, directional */
  -12px 0 48px rgba(0, 0, 0, 0.3),
  /* Glow: subtle accent light bleed */
  -4px 0 20px rgba(22, 163, 74, 0.06);
```

### Direction

Shadow direction should match the panel's origin:
- **Right drawer**: shadows cast to the left (`-12px 0 ...`)
- **Dropdown**: shadows cast downward (`0 16px ...`)
- **Bottom sheet**: shadows cast upward (`0 -12px ...`)

### Restraint

The accent glow shadow should be barely visible — at 0.04–0.08 opacity. Its job is to prevent the shadow from looking like a harsh black void. If it's noticeable as green, it's too strong.

---

## 8. The Backdrop Dim

Modal-depth panels (drawers, command palette) need a backdrop overlay that dims the content behind them.

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
```

- **Background**: `rgba(0, 0, 0, 0.3)`. Enough to reduce contrast of background content, not so much that it looks like a blackout.
- **Blur**: 2px. A very slight blur takes the "crispness" off background text and makes the foreground panel feel like the focus point. More than 4px competes with the panel's own glass effect.
- **Click to close**: The backdrop should always be a dismiss target.

---

## 9. Color Palette

All accent color derives from a single green hue. This constraint prevents visual noise.

### Accent Greens

| Token | Value | Use |
|-------|-------|-----|
| `--green-700` | `#15803d` | Darkest accent (rare) |
| `--green-600` | `#16a34a` | Gradients, strong accents |
| `--green-500` | `#22c55e` | Primary accent — active states, badges, buttons |
| `--green-400` | `#4ade80` | Gradient endpoints, highlights |
| `--green-300` | `#86efac` | Very light accents (rarely used) |

### Accent Usage Rules

- Accent greens are used **exclusively at low opacity** (0.03–0.5) for glows, borders, tints, and highlights.
- Full-opacity accent is reserved for **interactive elements**: active badges, send buttons, active nav indicators.
- **Text and icons use neutral whites/greys**, not green. The accent is environmental lighting, not a text color.

### Backgrounds

| Token | Value | Use |
|-------|-------|-----|
| `--bg-canvas` | `#0a0f0d` | Root background — very dark green-black |
| `--bg-surface` | `#0f1a17` | Cards, raised surfaces |
| `--bg-surface-hover` | `#162b25` | Hover state for surfaces |
| `--bg-inset` | `#0b1310` | Recessed areas (code blocks, inputs) |

### Foreground

| Token | Value | Use |
|-------|-------|-----|
| `--fg-primary` | `#e8f5ef` | Primary text — slightly green-tinted white |
| `--fg-muted` | `#7a9f8e` | Secondary text, labels, metadata |
| `--fg-dimmed` | `#4a7565` | Tertiary text, placeholders, disabled states |

---

## 10. Animation

Glass panels should animate in a way that reinforces their physical origin.

### Entrance

- **Drawers**: `translateX(100%)` → `translateX(0)` with `cubic-bezier(0.16, 1, 0.3, 1)` (overshoot ease-out). Duration: 250ms.
- **Dropdowns**: `translateY(-8px)` + `opacity: 0` → settled. Duration: 200ms.
- **Backdrop**: Simple `opacity: 0` → `opacity: 1`. Duration: 150ms. Should finish before the panel arrives.

### Easing

Use `cubic-bezier(0.16, 1, 0.3, 1)` for panel entrances. This slightly overshoots and settles, giving a sense of physical weight to the glass.

### Exit

Exits should be faster than entrances (150–200ms) and use a simpler ease-in curve. Panels that linger on exit feel sluggish.

---

## 11. Restraint Principles

These are the guardrails that prevent the glass aesthetic from becoming garish.

### The Green Budget

Imagine each screen has a "green budget." Every green glow, border, accent, and tint spends from that budget. When the budget is exhausted, the screen looks like a sci-fi prop from 2004.

- **One strong green element per viewport** (the active nav indicator, or the send button, or the status badge — not all three at max intensity)
- **Edge glows are background radiation** — they should be felt, not seen. If someone says "cool glow effect," it's too strong.
- **Borders are structure**, not decoration. They define edges. Keep them at 0.12–0.2 opacity.

### The Blur Test

Squint at the screen. If you can immediately identify every glass panel by its blur halo, the blur values are too high or too varied. The panels should feel like natural layers, not spotlight effects.

### The Screenshot Test

Take a screenshot and show it to someone unfamiliar with the app. Ask them what they notice first. If they say "the green glow" or "the frosted glass," the effects are too prominent. They should say "the chat" or "the message" — the content, not the chrome.

---

## 12. Applying to New Components

When creating a new glass component, follow this checklist:

1. **Determine depth** (chrome / surface / modal) → sets blur + opacity
2. **Identify the leading edge** → determines corner rounding direction, glow placement, shadow direction
3. **Add the backdrop-filter** with blur + saturate, including `-webkit-` prefix
4. **Add a single border** at 0.15–0.22 opacity, omitting flush edges
5. **Add directional shadow** — dark depth shadow + subtle accent glow
6. **Add edge glow** via `::before` on the leading edge (if the component is large enough to warrant it — skip for small tooltips)
7. **Add inner wash** via `::after` if the panel is modal-depth (skip for chrome-depth)
8. **Animate from origin** — slide/fade from the direction the panel conceptually comes from
9. **Check the green budget** — does this new element tip the screen into "too much glow"?
10. **Test with real content** — glass effects look different with text and data behind them vs. empty space
