# Contributing to Simple Agent Manager

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/simple-agent-manager.git`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feature/your-feature`

## Development Workflow

### Running Locally

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Start development servers
pnpm dev
```

### Code Style

- TypeScript for all code
- ESLint + Prettier for formatting
- Run `pnpm lint` before committing

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new workspace feature
fix: resolve DNS creation bug
docs: update getting started guide
test: add integration tests for cleanup
refactor: extract validation utilities
```

### Pull Requests

1. Ensure all tests pass: `pnpm test`
2. Update documentation if needed
3. Add tests for new features
4. Keep PRs focused and small
5. Fill the PR template completely (including the Agent Preflight block)

### Agent Preflight (AI-Assisted PRs)

AI-assisted changes must include pre-code behavioral evidence in the PR template:

- Change classification (for example `external-api-change`, `cross-component-change`)
- Confirmation that preflight happened before code edits
- External references used (Context7 or official docs for external API changes)
- Codebase impact analysis across affected components
- Documentation/spec synchronization notes
- Constitution and risk check summary

CI validates this section on pull requests.

## Project Structure

```
apps/
  api/             - Cloudflare Worker API (Hono + TypeScript)
  web/             - Control Plane UI (React + Vite)
packages/
  shared/          - Shared types and utilities
  providers/       - Cloud provider abstraction (Hetzner)
  cloud-init/      - VM cloud-init template generation
  terminal/        - Shared terminal component (xterm.js + WebSocket)
  ui/              - Shared UI component library
  vm-agent/        - Go agent for WebSocket terminal + idle detection
  acp-client/      - Agent Communication Protocol client
infra/             - Pulumi infrastructure as code
scripts/
  vm/              - VM-side config templates
  deploy/          - Deployment utilities
docs/
  guides/          - User guides
  adr/             - Architecture Decision Records
  architecture/    - Architecture documentation
specs/             - Feature specifications
```

### Go Development (VM Agent)

The `packages/vm-agent/` directory contains a Go binary that runs on workspace VMs:

```bash
cd packages/vm-agent

# Install Go dependencies
go mod download

# Build for all platforms
make build-all

# Run tests
go test ./...
```

Requirements: Go 1.22+

## Testing

### Unit Tests

```bash
# Run all unit tests
pnpm test

# Run tests for a specific package
pnpm --filter @simple-agent-manager/api test

# Run with coverage
pnpm test:coverage
```

### Integration Tests

Integration tests use mocked APIs. No real cloud resources are used.

```bash
pnpm --filter @simple-agent-manager/api test
```

## Adding a New Feature

1. **Check existing issues** for related discussions
2. **Create an issue** describing the feature
3. **Design first** for significant changes
4. **Write tests** before or alongside implementation
5. **Update docs** if user-facing

## Code of Conduct

Be respectful and constructive. We're all here to build something great together.

## Questions?

Open an issue with the "question" label or reach out to the maintainers.
