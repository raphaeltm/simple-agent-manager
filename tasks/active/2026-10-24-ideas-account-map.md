# Ideas on the Account Map

## Problem

The Map has an idea node component but the API returns no ideas or idea to chat relationships.

## Research

- `apps/api/src/routes/account-map.ts` aggregates caller-owned projects, resources and DO sessions.
- `apps/api/src/operations/link-core.ts` batches idea-target link reads per project.
- `ideaTaskPredicateSql` is the single idea identity guard.
- Map UI already has an idea node and edge colors; data mapping and Ideas filter are absent.

## Checklist

- [x] Bound Map aggregation through typed settings and disclose truncation.
- [x] Query caller-owned ideas using the shared predicate and json_each project IDs.
- [x] Batch link reads by project and return idea nodes plus edges to Map chats.
- [x] Map ideas in the web client, filter, navigation, and responsive presentation.
- [x] Add real SQL multi-project attack/control route tests and Ideas filter behavior test.
- [x] Update public docs, review mobile and desktop Playwright screenshots.
- [ ] Run quality, specialist, staging, PR, CodeRabbit, merge, production deploy gates.

## Acceptance

Caller-owned ideas linked to visible chats appear with project and chat edges; foreign ideas never appear. Ideas filter hides and restores nodes and edges. Caps are visible. Map works on phone and desktop.
