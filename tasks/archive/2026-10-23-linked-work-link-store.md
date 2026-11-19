# Linked work link store and automatic links

## Problem

SAM stores only manually created session to idea links. Work across ideas, chats, files and PRs needs a bounded, project scoped relationship store and read contracts.

## Research

- ProjectData owns existing `chat_session_ideas` in migration 012; `project-data/ideas.ts` and `services/project-data.ts` expose it.
- Workspace idea tools call shared operations; library tools have separate handlers.
- Human upload provenance currently trusts multipart form fields in `routes/library.ts`.
- The linked work program assigns DO migration `067-resource-links` and shared link types to T1.

## Checklist

- [x] Add shared types and migration with safe legacy backfill.
- [x] Add bounded generic DO link write/read operations.
- [x] Add project scoped operation layer and three composed read models with REST routes.
- [x] Switch legacy idea links and add automatic and explicit MCP links.
- [x] Guard human upload provenance.
- [x] Add real trigger, SQL, migration and read contract tests.
- [x] Update public docs and pass quality and specialist review.
- [x] Address coordinator review: JSON-array SQL binding, cheap weak-link count and cleanup,
      per-route auth, consistent file path, and composed Worker route verification.
- [x] Claim staging, verify end to end, release and clean up.
- [x] Open PR, pass CI and CodeRabbit wait, and merge.
- [x] Watch production deploy to completion (run 40062885912 succeeded for d9910c6ed).

## Acceptance

All requirements in idea 01M5NG4ZJAD6AZ1YSD1TA676WE, using shared type contract in idea 01M5NG3W2ZMDFD797SQF8DWNHR.
