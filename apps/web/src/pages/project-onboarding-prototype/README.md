# Prototype — Project Onboarding

A throwaway design exploration reimagining project **creation** as project
**onboarding**. Route: `/prototype/project-onboarding` (public, unauthed, mock
data only). Delete before any merge to `main` — see
`.claude/rules/37-prototype-development.md`.

## The gap this explores

Today the two surfaces are mismatched in quality:

- **Account onboarding** (the Choose-Your-Path wizard) is guided, data-driven,
  and polished — it asks a few questions, generates a personalized setup path,
  and ends at *"create your first project."*
- **Project creation** (`/projects/new` → `ProjectForm`) is a flat data-entry
  form. It hands you back an **empty project** with no agent profile, no
  settings, and nothing in motion. The momentum the wizard built evaporates at
  exactly the moment the user should feel most capable.

So the polished onboarding funnels into a cold form. This prototype asks: what
if creating a project *felt like* the onboarding — short, guided, and ending in
motion rather than an empty room?

## The reimagined flow (3 steps)

1. **Bring your code** — search/select a GitHub repo (or "start fresh" with a
   SAM Git repo). The project name auto-fills from the repo and stays editable.
   One decision, pre-filled defaults.
2. **What do you want to do first?** — the novel step. Instead of dropping the
   user into an empty project, we ask their *first intent*: start chatting, hand
   off a task, explore the codebase, or "set it up myself." This both teaches
   what SAM can do and lets us land them on the right screen.
3. **Ready** — a confirmation that lands the user *in motion* (the chosen first
   action), not on an empty project home.

## Design decisions worth noting

- **One conversational profile, taught not seeded.** Per Raphaël's preference,
  SAM starts every project with a single default conversational profile. The
  intent step surfaces this as a small chip ("Default conversational profile ·
  customize later") plus a footer line, rather than asking the user to pick
  among provider-specific profiles up front. The boundary is taught, not
  imposed.
- **Intent → landing, not intent → config.** The first-action choice routes the
  user somewhere useful; it does not turn onboarding into a settings wizard.
- **Borrowed visual language** from the Choose-Your-Path wizard: card options
  with `aria-pressed`, accent icon tiles, the green-glow vignette, progress
  dots, and an accessible focus model.

## Stress-test mock data

`mock-data.ts` includes long repo names, empty descriptions, a single-char repo
(`oss/x`), and a Unicode/emoji/`<script>` injection repo to verify wrapping,
empty-state handling, and XSS-safe rendering (React escapes by default).
