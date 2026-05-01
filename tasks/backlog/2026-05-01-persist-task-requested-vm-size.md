# Persist Task Requested VM Size

## Problem

Task records do not persist the resolved requested VM size used for node selection. When investigating incidents where a task ran on an unexpected node size, the system currently requires reconstructing the resolved size from project defaults, agent profile overrides, explicit task inputs, and code behavior at the time.

Persisting the resolved requested VM size would make future audits direct and less dependent on mutable project/profile configuration.

## Context

Discovered while fixing VM size minimum semantics in PR #875. That fix enforces the requested VM size as a minimum during node reuse, but does not add historical audit persistence for the resolved size.

## Acceptance Criteria

- [ ] Task-run records persist the resolved requested VM size used by TaskRunner.
- [ ] The persisted value distinguishes explicit task override, agent profile default, project default, and platform default where feasible, or documents why source provenance is out of scope.
- [ ] Admin/debug surfaces or logs expose the persisted requested VM size for incident investigation.
- [ ] Tests cover task submission with explicit VM size, project default VM size, and platform fallback.
