# Project Default Provider

**Created**: 2026-03-14
**Status**: Active

## Problem

When tasks auto-provision nodes via the TaskRunner DO, no cloud provider is specified. The `createNodeRecord` call in `handleNodeProvisioning` omits the `cloudProvider` field, leaving it NULL. Users with multiple provider credentials (e.g., both Hetzner and Scaleway) have no way to control which provider is used per project.

## Solution

Add a `defaultProvider` field to projects, following the same precedence pattern as `defaultVmSize`:
- Explicit request override > project default > null (system picks any available)

## Implementation Checklist

- [x] D1 migration: `0026_project_default_provider.sql` adds `default_provider TEXT` to projects
- [x] Schema: `defaultProvider` column in `apps/api/src/db/schema.ts`
- [x] Shared types: `defaultProvider` on `Project`, `UpdateProjectRequest`, `provider` on `SubmitTaskRequest`
- [x] API PATCH route: accepts, validates (against `CREDENTIAL_PROVIDERS`), and persists `defaultProvider`
- [x] Mapper: `toProjectResponse` includes `defaultProvider`
- [x] Task submit: resolves provider with `body.provider ?? project.defaultProvider ?? null`, passes to TaskRunner
- [x] Task run: passes `project.defaultProvider` as `cloudProvider` to TaskRunner
- [x] TaskRunner DO service: accepts and forwards `cloudProvider`
- [x] TaskRunner DO: `TaskRunConfig.cloudProvider`, passed to `createNodeRecord`
- [x] Settings UI: provider selector in `ProjectSettings.tsx` and `SettingsDrawer.tsx`
- [x] UI only shows selector when user has multiple configured providers
- [x] Tests: 24 structural verification tests covering the complete data path
- [x] Fix: added `listCredentials` mock to `project.test.tsx` to prevent test failures

## Acceptance Criteria

- [x] User with multiple provider credentials sees a provider selector in project settings
- [x] Selected provider is persisted and returned in project API responses
- [x] Auto-provisioned nodes use the project's default provider
- [x] Task submit allows per-request provider override
- [x] Provider selector hidden when user has only one provider (no unnecessary UI)
- [x] All tests pass (1164/1164), lint clean, typecheck clean
