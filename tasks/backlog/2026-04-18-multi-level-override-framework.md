# Multi-Level Override Framework (Meta-Spec)

**Priority:** MEDIUM (strategic framing — feeds follow-up phases)
**Parent idea:** `01KNKRCS8DSX8FREC02AJV23QH`
**Related phases:**
- Phase 1 (shipped): per-project `model` + `permissionMode` — PR #748
- Phase 2: per-project credential overrides — `2026-04-18-project-credential-overrides.md`

## Vision

**Any parameter that defines how an agent + chat session + workspace behave should be overridable at every level of specificity.** The resolution chain should be consistent across parameters:

```
Session/Trigger (most specific)
  > Profile (if attached)
  > Project
  > User default
  > Platform default (least specific)
```

When a user sits down to start work, they shouldn't be forced to set up a profile just to try a one-off config tweak, and they shouldn't be forced to change their personal defaults just because one project needs a different setup.

## The Parameter Surface

Every parameter currently (or potentially) passed when starting an agent session falls into one of these buckets. Today, each one has a *different* and *inconsistent* override story. The goal is a single framework covering all of them.

| Parameter | User | Project | Profile | Session | Trigger |
|---|---|---|---|---|---|
| Agent model | user `agent_settings` | **Phase 1 ✅** | profile.model | task submit | trigger config |
| Permission mode | user `agent_settings` | **Phase 1 ✅** | profile.permissionMode | task submit | trigger config |
| Agent credentials (API keys / OAuth) | `credentials` table | **Phase 2 (planned)** | — | — | — |
| System prompt / system-prompt-append | user setting | ❌ | profile.systemPromptAppend | ❌ | ❌ |
| Max turns | env default | project scaling | profile | ❌ | ❌ |
| Timeout | env default | project scaling | profile | ❌ | ❌ |
| VM size / workspace profile | platform default | project.defaultVmSize | ❌ | task submit | trigger config |
| Infrastructure provider | platform default | project.defaultProvider | — | task submit | trigger config |
| Infrastructure location | platform default | project.defaultLocation | — | task submit | trigger config |
| Infrastructure credentials (Hetzner token, etc.) | user `credentials` | ❌ (partial via `project_deployment_credentials`) | — | — | — |
| Sub-task limits, warm-node timeouts | env default | project scaling | ❌ | ❌ | ❌ |
| Environment variables injected into agent | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP server list | user config | ❌ | ❌ | ❌ | ❌ |

❌ = not overridable at that level today. This table should be the source of truth for planning subsequent phases.

## Design Principles

1. **Resolution chain is identical for every parameter.** A developer implementing a new config field follows the same recipe: declare it at each tier with nullable "inherit" semantics.
2. **"Inherit" is always represented as `null`/absent**, never a magic string. Users see "Inherit from <next tier up>" in the UI at every level.
3. **Override scope is discoverable in UI.** When a session runs with a project-scoped credential, the chat header should show "using project credential" (or similar). A user should never be surprised by *where* a value came from.
4. **Session-level override is a first-class path, not a bolt-on.** A "Start Session" dialog should let the user inspect and override any resolvable parameter before the workspace boots.
5. **Triggers are just pre-canned session configs.** Any override a user can make in the session dialog should be expressible in a trigger definition.

## UX Concept — Session Override Panel

When starting a new chat session (or editing a task submission), surface a collapsible "Advanced / Override" panel showing:

- **Agent & model** — current resolution source (e.g., "claude-opus-4-7 from project default") + override input
- **Permission mode** — same pattern
- **Credential** — which credential will be used + override dropdown (user-level credentials + project-level if any + "use a different one for this session")
- **Workspace** — size, provider, location + override inputs
- **Runtime** — system prompt append, max turns, timeout + override inputs

Each row shows: resolved value → source → override control. Changing a value for a single session does not mutate the project/profile/user default. Optional "Save these settings as a profile" or "Save to project defaults" buttons let users promote ad-hoc overrides into persistent tiers.

## Phases (proposed sequencing)

1. **Phase 1 ✅** — per-project `model` + `permissionMode`
2. **Phase 2** — per-project agent credentials (separate task, high priority)
3. **Phase 3** — per-project system-prompt-append, max turns, timeout; unify with existing `project_scaling` fields
4. **Phase 4** — session-level override panel UI (covers any parameter already overridable at project level)
5. **Phase 5** — trigger-level overrides (mostly a UI project — triggers already carry config; formalize and expand)
6. **Phase 6** — profile ↔ project coupling (should profiles be attachable to projects? inherit from them?)
7. **Phase 7** — infrastructure credential scoping (project-level Hetzner/Scaleway token selection; ties into the `project_deployment_credentials` work)
8. **Phase 8** — MCP server list overrides per project / session

Each phase is independently valuable and shippable; none block the others except 4 depending on 1–3.

## Open Questions

- **Profile vs project precedence:** Phase 1 put project above profile for *model/permissionMode* because profiles are user-global — a project setting should win for that project. Is this right for every parameter? For credentials, we likely want project > profile too. For system-prompt-append, less clear — user might want profile-level personality to always win.
- **Should profiles be user-scoped, project-scoped, or both?** Today they're user-scoped. Making them project-scoped (or both) opens more sharing patterns but complicates the UI.
- **Session-level persistence:** When a user overrides a value in the session dialog, should the override persist if they re-open that session? Probably yes for in-progress sessions; probably no for new sessions starting from the same project.
- **Audit trail:** Should every resolved value at session-start time be logged so a user can answer "why was this model used for this task?"

## Non-Goals (Meta)

This task is a framing document — it does **not** itself ship code. Use it to plan, prioritize, and avoid divergent designs across phases. Each real implementation phase gets its own task file with a concrete checklist.

## Action

Break this down into phase tasks as capacity allows. Phase 2 (credentials) is already written as its own backlog task and is the next concrete unit of work. After that, pull Phase 3 or Phase 4 depending on user demand.
