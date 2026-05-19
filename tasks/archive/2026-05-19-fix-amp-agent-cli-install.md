# Fix Amp Agent CLI Installation

## Problem

The Amp agent fails with "Error: Amp CLI not found. Please install it with: npm install -g @sourcegraph/amp" when selected in a project chat session.

The root cause: the install command only installs `acp-amp` (the Python ACP bridge via uv) but not the actual `amp` CLI binary (`@sourcegraph/amp` npm package). When `acp-amp run` executes, it tries to invoke the `amp` CLI which doesn't exist in the container.

## Research Findings

1. **Agent install flow** (`packages/vm-agent/internal/acp/gateway.go`):
   - `installAgentBinary()` checks `which acp-amp` - passes because the bridge is installed
   - `acp-amp run` starts but fails because `amp` binary is not in PATH
   - The error comes from inside the `acp-amp` Python process itself

2. **Install command** only installs the ACP bridge via uv, missing the underlying CLI:
   - Current: `uv tool install acp-amp==0.1.3 ...`
   - Missing: `npm install -g @sourcegraph/amp`

3. **Parallel definitions** exist in both:
   - `packages/vm-agent/internal/acp/gateway.go` (Go, used at runtime)
   - `packages/shared/src/agents.ts` (TypeScript, used for catalog display)

## Implementation Checklist

- [x] Update install command in `gateway.go` to chain `npm install -g @sourcegraph/amp`
- [x] Update install command in `agents.ts` to match
- [x] Update test assertions in `gateway_test.go` (both table-driven and dedicated test)
- [ ] Verify Go tests pass
- [ ] Verify TypeScript shared package builds
- [ ] Deploy to staging and test with a real Amp session

## Acceptance Criteria

- [ ] Amp agent can be selected in a project chat and starts successfully
- [ ] The `amp` CLI binary is installed in the container alongside `acp-amp`
- [ ] Go unit tests pass with updated install command assertions
- [ ] No regressions to other agent types
