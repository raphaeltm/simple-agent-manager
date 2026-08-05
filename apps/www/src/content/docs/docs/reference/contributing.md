---
title: Contributing
description: Contribution workflow, quality expectations, and pull request requirements for SAM.
---

## Getting Started

1. Fork the repository.
2. Clone your fork: `git clone https://github.com/your-username/simple-agent-manager.git`.
3. Install dependencies: `pnpm install`.
4. Create a branch: `git checkout -b feature/your-feature`.

## Development Workflow

Run the standard checks before opening a pull request:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

For local development:

```bash
pnpm dev
```

This starts the API and web UI development servers. Local development has known limitations around OAuth, DNS, and real VM provisioning; use staging when validating those paths.

## Code Style

- TypeScript is used for the API, web app, shared packages, scripts, and infrastructure.
- Go is used for the VM agent and CLI packages.
- ESLint and Prettier handle TypeScript formatting.
- Keep changes focused and include tests for new behavior.

## Commit Messages

Use Conventional Commits:

```text
feat: add new workspace feature
fix: resolve DNS creation bug
docs: update getting started guide
test: add integration tests for cleanup
refactor: extract validation utilities
```

## Pull Requests

1. Keep the PR focused and small.
2. Ensure the relevant checks pass.
3. Update docs when user-facing behavior changes.
4. Fill the pull request template completely, including the Agent Preflight section.

## Agent Preflight

AI-assisted changes must include pre-code behavioral evidence in the PR template:

- Change classification, such as `external-api-change` or `cross-component-change`.
- Confirmation that preflight happened before code edits.
- External references used, with official docs for external API changes.
- Codebase impact analysis across affected components.
- Documentation and spec synchronization notes.
- Constitution and risk check summary.

CI validates this section on pull requests.

## Go Development

The VM agent lives in `packages/vm-agent/`:

```bash
cd packages/vm-agent
go mod download
make build-all
go test ./...
```

The CLI package lives in `packages/cli/` and should be held to the same quality bar: simple command parsing, scenario-driven tests, and careful secret redaction.

## Dependency Pin Updates

CI and development bootstrap dependencies are pinned so tool or image drift is reviewed through pull requests:

1. Let Dependabot open routine npm, GitHub Actions, devcontainer, Docker, and Go module updates when possible.
2. For Docker base images, use digest-pinned references, for example `image@sha256:...`. Record the reviewed tag or source version in nearby comments when it matters, and verify the digest with registry metadata before changing it.
3. For workflow or bootstrap tools installed outside the project lockfile, update the version variable in the workflow or script instead of switching back to `latest`.
4. Run `pnpm quality:dependency-governance` after any dependency-governance change.
5. Preserve existing platforms and commands unless the PR is explicitly scoped to a behavior change.

## Adding a Feature

1. Check existing issues and task records for related discussion.
2. Design first for significant changes.
3. Write tests before or alongside implementation.
4. Update the www docs for user-facing behavior.
