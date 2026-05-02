# Cloudflare Containers as Agent Runtime

**Date:** 2026-05-02

## Executive Summary

Cloudflare Containers offer a compelling runtime for SAM's project-level and top-level agents. Cold starts of 1-3 seconds, scale-to-zero pricing, full file system access, and Worker/DO integration make them well-suited for lightweight agent containers. The **Cloudflare Sandbox SDK** (built on Containers) provides a higher-level abstraction purpose-built for AI agent sandboxes with `sandbox.exec()`, file system APIs, git checkout, PTY support, and backup/restore. The main limitations are HTTP-only networking and ephemeral disk.

## What Are Cloudflare Containers?

Cloudflare Containers run OCI-compatible container images on Cloudflare's global network, tightly integrated with Workers and Durable Objects. Each container:
- Runs in an isolated VM (not just a namespace)
- Is addressed via a Durable Object (each container has its own DO)
- Accepts HTTP requests routed through Workers
- Has full Linux file system access
- Can run any `linux/amd64` binary

## Key Specs for SAM's Use Case

### Instance Types

| Type | vCPU | RAM | Disk | Best For |
|------|------|-----|------|----------|
| **lite** | 1/16 | 256 MB | 1 GB | Lightweight orchestration |
| **standard-1** | 1 | 2 GB | 10 GB | Single-agent coding tasks |
| **standard-2** | 2 | 4 GB | 20 GB | Multi-tool agent sessions |
| **standard-4** | 4 | 12 GB | 50 GB | Heavy workloads, large repos |

**Recommendation for SAM:** `standard-1` for project-level agents (sufficient for git clone + coding), `lite` for orchestration-only containers.

### Startup Time
- **Cold start: 1-3 seconds** (depends on image size and entrypoint execution time)
- Pre-fetched images across CF network enable faster starts
- Scale-to-zero with configurable `sleepAfter` timeout

### Capabilities
- Full file system access (ephemeral)
- Can run CLI tools (git, npm, go, etc.)
- Can clone git repos
- Can run any Linux binary compiled for amd64
- FUSE mounts to R2 for persistent storage (with performance tradeoff)
- Docker-in-Docker: rootless DinD is supported (per knowledge graph)

### Networking
- HTTP requests only (inbound)
- Outbound HTTP/HTTPS calls are allowed
- No raw TCP/UDP inbound (must go through Worker)
- Worker <-> Container communication via HTTP

### Resource Limits
- Configurable CPU, RAM, and disk per instance type
- Memory billed per GiB-second (provisioned)
- CPU billed per vCPU-second (active use only)
- Disk billed per GB-second (provisioned)

### Lifecycle
- `onStart()` -- hook when container starts
- `onStop()` -- hook when container shuts down
- `onActivityExpired()` -- hook when sleep timeout fires
- `onError()` -- hook for error handling
- SIGTERM -> 15 min grace -> SIGKILL on shutdown

### Pricing (Workers Paid Plan - $5/month base)
| Resource | Included | Overage |
|----------|----------|---------|
| RAM | 25 GiB-hours/month | $0.0000025/GiB-second |
| CPU | 375 vCPU-minutes/month | $0.000020/vCPU-second |
| Disk | 200 GB-hours/month | $0.00000007/GB-second |
| Network (NA/EU) | 1 TB | $0.025/GB |

### Limitations
- **Ephemeral disk** -- restarts wipe the file system. Need R2 FUSE mount or Sandbox SDK backup/restore for persistence.
- **HTTP-only inbound** -- no raw TCP (but fine for agent API communication)
- **No co-location guarantee** -- container and its DO may be in different locations
- **Image must be linux/amd64** -- no ARM support yet

---

## Cloudflare Sandbox SDK (Key Finding)

The **Sandbox SDK** (`@anthropic-ai/cloudflare-sandbox` / `cloudflare:sandbox`) is a higher-level abstraction built on top of Containers, purpose-built for AI agent sandboxes. It was developed by Anthropic in collaboration with Cloudflare and is available as a first-party Cloudflare SDK.

### Why This Matters for SAM

The Sandbox SDK eliminates the need to build custom HTTP APIs for container communication. Instead of building a `harness serve` HTTP server inside the container, SAM can use the Sandbox SDK directly from a Worker or DO to:

- Execute commands inside the container
- Read/write files
- Clone git repos
- Get interactive PTY sessions
- Create/restore filesystem snapshots

This dramatically simplifies the **Container Mode** deployment path.

### Core API

```typescript
import { Sandbox } from 'cloudflare:sandbox';

// In a Worker or DO:
const sandbox = env.SANDBOX; // Declared in wrangler.toml

// Execute commands
const result = await sandbox.exec('git', ['clone', repoUrl, '/workspace']);
// result.stdout, result.stderr, result.exitCode

// File operations
const content = await sandbox.files.read('/workspace/src/main.go');
await sandbox.files.write('/workspace/output.txt', 'Hello');
const listing = await sandbox.files.list('/workspace/src/');

// Git checkout (built-in convenience)
await sandbox.gitCheckout({ repo: 'https://github.com/user/repo', branch: 'main' });

// PTY for interactive sessions
const pty = await sandbox.pty.open({ cols: 80, rows: 24 });
pty.write('npm test\n');
pty.onData((data) => stream.write(data));

// Filesystem snapshots (persist across restarts)
const backupId = await sandbox.createBackup();
// ... later, after container restart:
await sandbox.restoreBackup(backupId);
```

### Sandbox SDK vs Raw Containers

| Capability | Raw Containers | Sandbox SDK |
|-----------|---------------|-------------|
| Command execution | Must build HTTP API inside container | `sandbox.exec()` from Worker/DO |
| File read/write | Must build HTTP API inside container | `sandbox.files.read/write()` from Worker/DO |
| Git clone | Must include git in image + HTTP API | `sandbox.gitCheckout()` built-in |
| PTY / interactive | Must build WebSocket bridge | `sandbox.pty.open()` built-in |
| Filesystem persistence | R2 FUSE mount (slow) | `createBackup()` / `restoreBackup()` |
| Image requirements | Custom image with your server | Minimal base image -- SDK handles communication |
| Complexity | Build full HTTP server + auth | Call SDK methods directly |

### Impact on Architecture

With the Sandbox SDK, the recommended architecture changes significantly:

**Without Sandbox SDK (original plan):**
```
Worker/DO -> HTTP -> Container (runs harness serve on port 8080)
                     harness binary handles commands, files, git
```

**With Sandbox SDK (recommended):**
```
Worker/DO -> Sandbox SDK -> Container (minimal base image)
             SDK handles command exec, file I/O, git, PTY
             Harness logic runs IN the Worker/DO, using SDK for I/O
```

This means the Go harness binary may not need an HTTP server mode at all for the Container deployment path. Instead:

1. **VM mode** -- Go harness runs as a binary in the VM workspace (unchanged)
2. **Sandbox mode** -- Worker/DO uses Sandbox SDK for file/command access; the agent loop (LLM calls, tool dispatch, context management) runs in the Worker/DO using TypeScript/Mastra
3. **CLI mode** -- Go harness runs standalone for local development (unchanged)

This is a simpler architecture than building a Go HTTP server inside the container.

---

## How SAM Would Use Containers

### Option A: Sandbox SDK (Recommended for Project/SAM Agents)

Use the Sandbox SDK from a Worker or DO for lightweight orchestration agents:

```typescript
// In ProjectOrchestrator DO or SamSession DO
const sandbox = env.SANDBOX;

// Clone the repo
await sandbox.gitCheckout({
  repo: `https://github.com/${project.owner}/${project.repo}`,
  branch: project.defaultBranch,
});

// Read code for analysis
const files = await sandbox.files.list('/workspace/src/');
const mainFile = await sandbox.files.read('/workspace/src/main.go');

// Run tests
const testResult = await sandbox.exec('go', ['test', './...'], {
  cwd: '/workspace',
  timeout: 120000,
});

// Make changes
await sandbox.files.write('/workspace/src/fix.go', newCode);

// Commit and push
await sandbox.exec('git', ['add', '.']);
await sandbox.exec('git', ['commit', '-m', 'Fix: description']);
await sandbox.exec('git', ['push', 'origin', 'fix-branch']);
```

### Option B: Custom Container Image (For Heavy Workspace Agents)

For workspace-level agents that need the full Go harness:

```dockerfile
FROM golang:1.24-alpine AS builder
# Build the Go harness binary
COPY packages/harness/ /src/
RUN cd /src && go build -o /harness ./cmd/harness/

FROM alpine:3.20
# Install essential tools
RUN apk add --no-cache git openssh-client curl jq

# Copy the harness binary
COPY --from=builder /harness /usr/local/bin/harness

# Optionally pre-install Node.js for TypeScript projects
# RUN apk add --no-cache nodejs npm

ENTRYPOINT ["/usr/local/bin/harness", "serve"]
```

Target image size: **< 100 MB** for fast cold starts.

### Workflow (Sandbox SDK Path)

1. **User sends message to SAM** (project chat or top-level)
2. **Worker receives request**, routes to SamSession or ProjectOrchestrator DO
3. **DO uses Sandbox SDK** -- `sandbox.gitCheckout()`, `sandbox.exec()`, `sandbox.files.read()`
4. **Agent loop runs in the DO** -- Mastra/TypeScript handles LLM calls, tool dispatch
5. **Sandbox SDK handles all I/O** -- file reads, command execution, git operations
6. **Container sleeps** after configurable idle timeout
7. **Filesystem can be backed up/restored** via `createBackup()`/`restoreBackup()`

### Cost Estimate

For a project-level agent that runs ~30 min/day:
- RAM (1 GiB x 30 min x 30 days): ~15 GiB-hours -> within included allowance
- CPU (0.5 vCPU x 30 min x 30 days): ~225 vCPU-minutes -> within included allowance
- Disk (5 GB x 30 min x 30 days): ~75 GB-hours -> within included allowance

**Result: Most users would be covered by the $5/month Workers plan** for light-to-moderate use.

---

## Comparison with Alternatives

| Platform | Cold Start | Sticky Sessions | CF Integration | File System | Scale-to-Zero | Agent Fit |
|----------|-----------|-----------------|---------------|-------------|--------------|-----------|
| **CF Containers + Sandbox** | 1-3s | Yes (DO-backed) | Native | Full (ephemeral + backup) | Yes | Excellent |
| **Fly.io Machines** | ~300ms | Yes | None | Persistent volumes | Yes | Good |
| **Google Cloud Run** | ~112ms (Go) | No | None | Ephemeral | Yes | Fair |
| **Modal** | 1-5s | Yes | None | Ephemeral | Yes | Fair (Python-first) |
| **AWS Lambda** | 2-10s | No | None | /tmp only, 15min limit | Yes | Poor |
| **Current (Workers + DOs)** | <50ms | Yes | Native | None | Always on | Insufficient |

### Detailed Alternative Analysis

**Fly.io Machines**
- **Startup:** ~300ms (faster than CF Containers)
- **Pricing:** $0.0000015/s for shared-1x, $31.10/month dedicated
- **Pros:** Faster start, persistent volumes, raw TCP support
- **Cons:** Not integrated with CF ecosystem, separate billing
- **Verdict:** Faster but adds complexity (separate provider)

**Google Cloud Run**
- **Startup:** ~112ms for Go binaries (very fast)
- **Pros:** Scale-to-zero, generous free tier, fast Go starts
- **Cons:** No sticky sessions (each request may hit different instance), not integrated with CF
- **Verdict:** Fast but no session affinity makes it poor for stateful agent sessions

**Modal**
- **Startup:** ~1s for warm, ~5s for cold
- **Pros:** Excellent for ML workloads, Python-native
- **Cons:** Overkill for agent orchestration, Python-focused, expensive
- **Verdict:** Not a good fit for this use case

**AWS Lambda (Container Images)**
- **Startup:** 2-10s cold start
- **Cons:** Slow cold starts, 15 min max execution, not integrated with CF
- **Verdict:** Too slow and max execution time kills long agent sessions

---

## Recommendation

**Cloudflare Sandbox SDK is the recommended path** for SAM's project-level and top-level agents because:

1. **Purpose-built for AI agent sandboxes** -- `exec()`, `files.read/write()`, `gitCheckout()`, `pty.open()` are exactly what coding agents need
2. **Native CF integration** -- no separate provider, unified billing, Worker/DO orchestration
3. **Simplifies architecture** -- no need to build HTTP server inside container; agent loop stays in Worker/DO
4. **1-3s cold start** -- acceptable for agent interactions (user doesn't expect instant response from an "agent thinking")
5. **Filesystem snapshots** -- `createBackup()`/`restoreBackup()` solves the ephemeral disk limitation
6. **Scale-to-zero** -- no cost when idle
7. **Included in Workers plan** -- light use is essentially free ($5/month base)

The main trade-off is that Fly.io Machines would be faster (~300ms vs 1-3s), but the CF integration advantage and the Sandbox SDK's purpose-built agent APIs outweigh the startup time difference.

### Optimization Strategies for Faster Starts

1. **Minimal container image** -- Alpine-based, < 100MB
2. **Use Sandbox SDK `createBackup()`** -- snapshot cloned repos, restore instead of re-cloning
3. **Keep containers warm** -- use `sleepAfter` with a generous timeout for active projects
4. **Pre-fetch images** -- CF does this automatically across its network
5. **Lazy tool loading** -- only install language-specific tools when needed
6. **Use `lite` instance type** for orchestration-only agents (256MB is enough for agent loop)

### Revised Architecture with Sandbox SDK

The Sandbox SDK finding changes the implementation plan:

| Agent Type | Runtime | Agent Loop | I/O Layer |
|-----------|---------|-----------|-----------|
| **Workspace agent** | VM (Hetzner) | Go harness binary | Direct file system |
| **Project-level agent** | CF Container via Sandbox SDK | TypeScript in DO (Mastra) | Sandbox SDK |
| **Top-level SAM agent** | CF Container via Sandbox SDK | TypeScript in DO (Mastra) | Sandbox SDK |
| **Local dev/testing** | Go harness CLI | Go harness binary | Direct file system |

This means:
- **Phase 1 (Core Harness)** focuses on Go binary for VM + CLI modes
- **Phase 3 (Container Mode)** uses Sandbox SDK instead of building an HTTP server -- significantly simpler
- The TypeScript/Mastra path for DO-based agents becomes the primary path for project/SAM agents
- Go harness HTTP server mode becomes optional (only needed if Sandbox SDK doesn't meet performance needs)
