# Glassomorphism Prototype: Design Decisions

## Overview

This prototype explores a glassomorphism visual language for the SAM project chat interface on mobile. The goal is to create depth and hierarchy through translucent surfaces with backdrop blur, while maintaining readability and a cohesive dark-theme aesthetic with green accent lighting.

## Core Design Principles

### 1. Glass as Hierarchy Signal

Each layer of the interface has a distinct glass treatment that communicates its z-position:

| Surface | Blur | Opacity | Purpose |
|---------|------|---------|---------|
| Session header (compact) | 20px | 0.55 | Persistent chrome — lightest glass so content beneath is hinted at |
| Session details (overlay) | 24px | 0.65 | Temporary overlay — heavier glass to separate from content below |
| Drawer panels (session/nav) | 28px | 0.72 | Modal panels — heaviest glass for strongest separation from page |

Higher blur + higher opacity = further "in front." This creates a consistent mental model without relying solely on shadows.

### 2. Directional Rounded Corners

Panels only round the corners on their *exposed* edges — the edges facing the content they float over:

- **Drawers** sliding in from the right get `border-radius: xl 0 0 xl` (top-left and bottom-left rounded, right edge flush with viewport)
- **Session details** dropping down from the header get `border-radius: 0 0 xl xl` (bottom corners rounded, top flush with header)

This avoids the "floating card" look and makes panels feel physically connected to their origin edge, like they slide out from behind the viewport boundary.

### 3. Edge Glow Accents (Subtle)

Each glass panel has a thin luminous edge on its "leading" side — the edge that enters the viewport:

- **Drawers**: left-edge vertical glow (3px wide, gradient from transparent through green to transparent)
- **Session details**: bottom-edge horizontal glow (similar gradient)
- **Session header**: bottom-edge subtle glow line (2px)

These are implemented as `::before` pseudo-elements with `filter: blur()` to create a soft light-bleed effect. The glow serves as a subtle depth cue — it suggests light wrapping around the edge of a translucent surface.

### 4. Inner Wash (Directional Light)

Panels have a `::after` pseudo-element creating a very faint directional gradient on their leading edge. This simulates light diffusing through the glass from the direction the panel entered. At 0.05 opacity, it's barely perceptible but contributes to the overall sense of materiality.

## The Subtlety Pass

The initial implementation was too aggressive with green glows and blur intensity. A refinement pass made these adjustments:

### Blur Values Reduced
- Drawers: 36-44px down to 28px
- Session details: 36px down to 24px
- Header: 28px down to 20px

**Rationale**: Heavy blur creates a "frosted bathroom glass" effect that feels cheap. Lighter blur lets you perceive the content beneath is *there* without being able to read it — more sophisticated.

### Background Opacity Increased
- Drawers: 0.48-0.62 up to 0.72
- Session details: 0.52 up to 0.65
- Header: 0.45 up to 0.55

**Rationale**: Lower opacity means more content shows through, which sounds cool but actually makes text harder to read and creates visual noise. The glass should suggest depth, not demand you process two layers of information simultaneously.

### Glow Intensity Reduced
- Edge glow width: 6px down to 3px
- Edge glow max opacity: 0.8-0.9 down to 0.5-0.7
- Box-shadow green component: 0.12-0.15 down to 0.06
- Header bottom glow: opacity 0.5 down to 0.3
- Filter blur on glows: 4px down to 2px

**Rationale**: Green glows are the accent, not the identity. When every surface bleeds green light, the eye has no resting place. Pulling back lets the glow serve as a *punctuation mark* — noticeable when you look for it, invisible when you're reading content.

### Saturation
- Kept at 1.3-1.4x (unchanged)

**Rationale**: `saturate()` in `backdrop-filter` slightly enriches the colors showing through the glass. At 1.3-1.4x it prevents the blur from making everything look grey/washed out without creating oversaturated artifacts.

## Layout Architecture

### Floating Session Details

The session details panel is positioned absolutely within a relative container that also holds the messages area. This means:

- It overlays the messages rather than pushing them down
- Opening/closing it doesn't cause layout shift
- The messages scroll independently beneath it
- A CSS transition on `max-height` and `opacity` creates a smooth reveal

### Drawer Pattern

Session list and nav drawers slide in from the right as fixed-position overlays with a backdrop dim. The glass surface is a child element within the drawer container, allowing the backdrop click-to-close area to be separate from the visual panel.

## Color Palette

All accent colors derive from a single green:
- Primary: `rgb(34, 197, 94)` — Tailwind green-500
- Dark: `rgb(22, 163, 74)` — Tailwind green-600

These are used exclusively at low opacity (0.05-0.5) for glows, borders, and highlights. Text and icons use neutral whites/greys. The green accent identifies SAM's brand without overwhelming the interface.

## What This Prototype Tests

1. Whether glass surfaces create sufficient visual hierarchy on mobile without heavy shadows
2. Whether directional corners feel natural or awkward
3. Whether edge glows at subtle intensity are perceptible and add value
4. Whether the overall aesthetic feels premium or gimmicky
5. Whether readability is maintained across all glass surfaces

## Implementation Notes

- All effects use standard CSS (`backdrop-filter`, `::before`/`::after`, `box-shadow`)
- No JavaScript for visual effects — all transitions are CSS
- `backdrop-filter` has excellent support on modern mobile browsers (Safari 9+, Chrome 76+)
- The prototype is a single HTML file for easy sharing and iteration
