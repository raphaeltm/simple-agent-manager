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
2. **Discover what SAM gives you** — *optional and fully skippable.* Modeled on
   the website's self-host setup, which explains *why* each piece matters rather
   than just *what* it is. Highlights the three power surfaces a new user should
   know exist: **Agent profiles**, **Triggers**, and **Skills** — each with a
   "why it matters" line. The task system is intentionally **not** highlighted
   (still maturing).
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
  (agents work off it) so it is a first-class required field; description was
  dropped (it added no value at creation time).
- **Intent does not change where you land.** Earlier iterations routed different
  intents to different screens. Now every path lands *in the project* — the only
  difference is whether you kicked off a task or a conversation.
- **Education over configuration.** Step 2 teaches the feature set with value-prop
  framing instead of forcing setup. Everything is deferrable; nothing past Step 1
  is required.
- **Everything after Step 1 is skippable** for power users.
- **Borrowed visual language:** card options with `aria-pressed`, accent icon
  tiles, the green-glow vignette, progress dots, and the dark glassy composer
  styling from `ProjectChatComposer`.

## Stress-test mock data

`mock-data.ts` includes long repo names, empty descriptions, a single-char repo
(`oss/x`), a Unicode/emoji/`<script>` injection repo, and branch lists with an
extremely long branch name — to verify wrapping, dropdown truncation, empty-state
handling, and XSS-safe rendering (React escapes by default).
