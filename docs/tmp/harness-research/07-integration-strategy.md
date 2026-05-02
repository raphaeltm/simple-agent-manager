# Integration Strategy: Bringing External Code into SAM

**Date:** 2026-05-02

## Requirements

Raphael wants:
1. Everything in the SAM monorepo (no external dependencies at runtime)
2. Ability to modify the code freely
3. Some mechanism to track upstream changes (optional)
4. Clean integration with existing build system (pnpm for TS, go build for Go)

## Strategy Options

### Option 1: Git Subtree

**How it works:** Merges another repo's history into a subdirectory of your repo. The external code becomes part of your repo's history.

```bash
# Initial import
git subtree add --prefix=packages/harness https://github.com/charmbracelet/crush main --squash

# Pull upstream updates
git subtree pull --prefix=packages/harness https://github.com/charmbracelet/crush main --squash
```

**Pros:**
- Code lives in your repo — no submodule headaches
- Can modify freely — changes are just regular commits
- Can pull upstream updates when desired
- Contributors don't need to know about the subtree
- Works well in monorepos

**Cons:**
- Git history gets complex (use `--squash` to mitigate)
- Merge conflicts when pulling upstream if you've modified heavily
- Upstream pulls become impractical after heavy customization

**Best for:** Initial import of a project you intend to modify heavily. Pull upstream a few times, then it becomes your own fork.

### Option 2: Vendor/Copy

**How it works:** Simply copy the source code into your repo. No git relationship maintained.

```bash
# Copy the code
cp -r /path/to/crush/src packages/harness/

# Or use a script
scripts/vendor-harness.sh
```

**Pros:**
- Simplest approach
- No git complexity
- Full control immediately
- Easy to understand

**Cons:**
- No mechanism to track upstream changes
- Manual work to incorporate upstream fixes
- You "own" the code from day one

**Best for:** When you intend to heavily modify the code and don't plan to track upstream.

### Option 3: Fork Repository + Subtree

**How it works:** Fork the upstream repo to your org, then subtree it. Your fork serves as the intermediary.

```bash
# Fork on GitHub: raphaeltm/crush (or smallpath/crush)
# Then subtree from your fork
git subtree add --prefix=packages/harness https://github.com/raphaeltm/crush main --squash
```

**Pros:**
- Can selectively cherry-pick upstream changes to your fork
- Fork provides a clear "adapted version" boundary
- Can contribute fixes back upstream via PRs from your fork

**Cons:**
- Extra repo to manage
- More complex workflow
- Overhead may not be worth it for heavy customization

**Best for:** When you want to maintain a relationship with upstream and potentially contribute back.

### Option 4: Go Module + Replace Directive

**How it works:** For Go projects specifically, use Go modules with a `replace` directive.

```go
// go.mod
require github.com/charmbracelet/crush v0.0.0

replace github.com/charmbracelet/crush => ./packages/harness
```

**Pros:**
- Go-native approach
- Clean dependency management
- Can import specific packages from the harness
- Works with Go toolchain (go get, go mod tidy)

**Cons:**
- Only works for Go code
- The local code still needs to be a valid Go module
- Doesn't handle the initial import (still need subtree or copy)

**Best for:** Complement to subtree/vendor for Go projects. Use this for the `go.mod` integration after importing the code.

### Option 5: Clean-Room Rewrite

**How it works:** Study the target project's architecture and patterns, then write your own implementation from scratch.

**Pros:**
- Zero license concerns
- Optimized for your exact needs from day one
- No dead code or unnecessary abstractions
- Full understanding of every line
- Clean architecture tailored to SAM

**Cons:**
- Most development effort
- Risk of missing edge cases the original handles
- No community fixes or improvements to draw from

**Best for:** When the original project's architecture is too coupled to its own use case, or when you need something fundamentally different.

## Recommended Strategy for SAM

### Phase 1: Study + Prototype (1-2 weeks)
1. Clone Crush and Pi locally
2. Read their internals deeply — understand the agent loop, tool system, LLM abstraction
3. Build a minimal proof-of-concept harness in Go (inspired by both)
4. Test it in the VM agent context

### Phase 2: Integration (depends on Phase 1 findings)

**If Crush's core is cleanly extractable:**
- Use **git subtree** to import Crush into `packages/harness/`
- Strip TUI, add headless mode, add SAM-specific tools
- Use **Go module replace** for internal imports
- Track upstream for a few cycles, then diverge

**If Crush is too TUI-coupled:**
- Use **clean-room rewrite** approach
- Build `packages/harness/` from scratch using patterns learned
- Borrow architectural ideas but write original code
- This is the more likely outcome given SAM's specific needs

**For TypeScript alternative (container/DO agents):**
- Use **Mastra** (already in SAM) as the base
- Study **Pi's** tool system design (read, write, edit, bash)
- Layer coding tools onto Mastra using Pi's minimal patterns
- No import needed — just implement the tool patterns

### Phase 3: Container Packaging
- Build the Go harness into a minimal container image
- Optimize for fast startup (< 2s goal)
- Bake in git, common build tools
- Deploy to Cloudflare Containers for project/top-level agents

## File System Layout in SAM Monorepo

```
packages/
├── harness/              # The coding agent harness (Go)
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/
│   │   └── harness/      # CLI entry point (for VM use)
│   │       └── main.go
│   ├── agent/            # Core agent loop
│   ├── llm/              # LLM provider abstraction
│   ├── tools/            # Tool system
│   ├── prompt/           # Prompt construction
│   ├── sandbox/          # Permission/safety system
│   └── README.md
├── vm-agent/             # Existing VM agent (imports harness)
│   └── internal/
│       └── harness/      # Integration layer
└── shared/               # Existing shared TypeScript types
```

The Go harness would be imported by the VM agent:
```go
import "github.com/raphaeltm/simple-agent-manager/packages/harness/agent"
```

For the TypeScript/container agents, the harness would be compiled to a binary and invoked as a subprocess, or a TypeScript equivalent would be built using Mastra.
