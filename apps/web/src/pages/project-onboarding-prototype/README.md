# Prototype — Project Onboarding

A throwaway design exploration reimagining project **creation** as project
**onboarding**. Route: `/prototype/project-onboarding` (public, unauthed, mock
data only). Delete before any merge to `main` — see
`.claude/rules/37-prototype-development.md`.

## The gap this explores

Today the two surfaces are mismatched in quality:

- **Account onboarding** (the Choose-Your-Path wizard) is guided, data-driven,
  and polished — it asks a few questions and ends at *"create your first
  project."*
- **Project creation** (`/projects/new` → `ProjectForm`) is a flat data-entry
  form. It hands you back an **empty project** with no momentum and nothing in
  motion — at exactly the moment the user should feel most capable.

So the polished onboarding funnels into a cold form. This prototype asks: what
if creating a project *felt like* onboarding — short, guided, educational, and
ending in motion rather than an empty room?

## The reimagined flow (3 steps)

1. **Connect your code** — search/select a **GitHub** repo (GitHub is the only
   working source today — the internal "SAM Git" option has been removed). Once
   a repo is chosen, the **required** details appear pre-filled: project name
   (derived from the repo, editable) and a **working-branch** selector. These
   three — repo, name, branch — are the only things collected up front.
2. **Set up** — a *hand-held, skippable* walkthrough that actually **creates**
   things rather than describing them. Three sub-steps, each individually
   skippable:
   - **Conversational profile** ("Your everyday agent") — pick an agent + model;
     SAM wires it up as a lightweight workspace in conversation mode.
   - **Task profile** ("Your task runner") — pick an agent + model, then tell it
     *how to finish a task* (which branch, commit, open a PR, always push). An
     amber callout explains that **workspaces are ephemeral** — unpushed work is
     gone for good when the VM is destroyed.
   - **Trigger** (optional) — "Anything you want done regularly?" Sets up a
     **cron-only** schedule that runs the task profile. GitHub event triggers
     are intentionally excluded (untested — "schedules only for now").
3. **Kick off** — an isolated, centered version of the project-chat composer
   (with voice input) lifted to center stage. A mode toggle starts either a
   **task** ("describe exactly what you want your agent to do") or a
   **conversation** ("start a conversation"). Either way the user lands *inside
   the project, in motion* — never on an empty home. A "skip — just open the
   project" escape hatch is always available.

## Design decisions worth noting

- **GitHub only.** The internal SAM Git "start fresh" path is non-functional and
  was removed entirely.
- **Required info is minimal and up front:** repo + name + branch. Branch matters
  (agents check out and work on it) so it is a first-class required field;
  description was dropped (it added no value at creation time).
- **Branch protection is the user's job, not SAM's.** Agents work *directly on*
  the chosen branch (the default branch by default). The copy makes clear that
  if you want a branch protected, you set branch protection rules in GitHub —
  SAM respects whatever you define rather than inventing its own guard rails.
- **Setup creates, it doesn't lecture.** An earlier iteration was a static
  feature-education screen. It is now an interactive walkthrough that stands up a
  conversational profile, a task profile, and (optionally) a trigger — so the
  user leaves onboarding with real, usable configuration.
- **Skills are deliberately excluded** from onboarding (still untested).
- **Real platform data, no claims.** The agent picker shows the user's *enabled*
  agents only (mock: Claude Code, OpenAI Codex, Gemini CLI) with a muted "N more
  available in your profile settings →" link to the rest of the real catalog
  (Mistral Vibe, OpenCode, Amp). Agent and model labels are factual names from
  `packages/shared/src/agents.ts` and `model-catalog.ts` — no marketing or
  quality positioning ("big context window", "good at X").
- **Triggers are cron-only** in onboarding. GitHub event triggers are simply not
  shown — there is no copy mentioning or teasing them.
- **Everything after Step 1 is skippable** for power users — each sub-step has a
  "Skip" button and the whole setup has a "Skip setup →" link.
- **Education over configuration where it counts:** the ephemeral-workspace
  warning teaches the single most surprising thing about SAM (unpushed work
  disappears) at the exact moment it matters — while configuring the task
  profile.
- **Borrowed visual language:** card options with `aria-pressed`, accent icon
  tiles, the green-glow vignette, progress dots, and the dark glassy composer
  styling from `ProjectChatComposer`. The shared `Button` component from
  `@simple-agent-manager/ui` is used for primary actions (correct
  `text-fg-on-accent` contrast).

## Stress-test mock data

`mock-data.ts` includes long repo names, empty descriptions, a single-char repo
(`oss/x`), a Unicode/emoji/`<script>` injection repo, and branch lists with an
extremely long branch name — to verify wrapping, dropdown truncation, empty-state
handling, and XSS-safe rendering (React escapes by default). The agent/model
options in `index.tsx` mirror the real catalog: all six agent types
(`claude-code`, `openai-codex`, `google-gemini`, `mistral-vibe`, `opencode`,
`amp`) with the first three flagged enabled, and real model IDs/display names —
the disabled ones surface only through the "more in settings" link.
