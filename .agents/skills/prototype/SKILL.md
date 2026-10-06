---
name: prototype
description: "Build a UI prototype for design exploration. Creates a self-contained, unauthed page in the real web app with mock data, exposes it for preview, and runs visual audits. Use when exploring layouts, information architecture, or interaction patterns before committing to production implementation."
---

# UI Prototype Builder

Build a self-contained UI prototype inside the real web app for design exploration and UX iteration.

## Full Rules

Read `.claude/rules/37-prototype-development.md` for the complete prototype development rules. Everything below is a summary workflow.

## Workflow

### 1. Audit the Existing UI

Before building, read the current implementation to understand:
- What components and patterns already exist
- What design tokens and styles are in use
- What the current UX problems are

### 2. Create the Prototype

Create two files:

```
apps/web/src/pages/<name>-prototype/
  ├── index.tsx       # Main component — self-contained, no API calls, no auth
  └── mock-data.ts    # Stress-test mock data (long text, many items, empty states, edge cases)
```

**Critical requirements:**
- Wrap content in a scrollable container: `<div style={{ height: '100vh', overflow: 'auto' }}>`
- Use existing components (`VmSizeCard`, `@simple-agent-manager/ui`, etc.) wherever possible
- Match the app's design tokens and dark theme
- Design mobile-first (375px), then enhance for desktop (1280px)
- Include mock data that pushes UI boundaries — this is how we find where it breaks

### 3. Wire the Route

Add to `App.tsx` in the public routes section:

```typescript
import { MyPrototype } from './pages/<name>-prototype';

// In Routes, alongside other public routes:
<Route path="/prototype/<name>" element={<MyPrototype />} />
```

### 4. Start the Dev Server and Expose

```bash
cd apps/web && npx vite --host 0.0.0.0
```

Then expose the port using the SAM MCP `expose_port` tool (port 5173, protocol http). Share the resulting URL with the user.

### 5. Visual Audit

Run Playwright screenshots at both viewports:
- Mobile: 375x667
- Desktop: 1280x800

Check for: overflow, clipping, text wrapping, interactive element usability, empty states, long content handling.

Save screenshots to `.codex/tmp/playwright-screenshots/`.

## NEVER Deploy to Production

Prototypes may be committed to feature branches for collaboration. They MUST be removed before any merge to main:
- Delete prototype page directory
- Remove route from `App.tsx`
- Remove import from `App.tsx`
