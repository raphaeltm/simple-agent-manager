# System Limits Audit & Review

**Created**: 2026-03-13
**Status**: Research complete — recommendations for discussion

## Overview

A comprehensive audit of all limits, timeouts, thresholds, and constraints across the SAM codebase. The goal is to identify limits that are **too restrictive**, **arbitrary**, or **unnecessary** for the current stage of the product.

All configurable limits follow Constitution Principle XI (no hardcoded values) — they have default constants with env var overrides. A few hardcoded limits exist but are mostly reasonable (content truncation, protocol constraints).

---

## Limits That Are Likely Too Restrictive

These limits are the most likely to cause friction for real users and should be raised.

### 1. `CREDENTIAL_UPDATE` rate limit — **5 per hour** ⚠️ Very Restrictive
- **File**: `apps/api/src/middleware/rate-limit.ts:33`
- **What it does**: Limits how often a user can update their cloud credentials (Hetzner token, GitHub app config, etc.)
- **Problem**: 5/hour is extremely low. A user setting up their account for the first time might need to update credentials several times as they troubleshoot — paste the wrong key, fix a formatting issue, rotate a key, add a second provider. Five tries in an hour is punishing.
- **Recommendation**: Raise to **20-30/hour**. Credential updates are low-risk (user is already authenticated) and the current limit creates unnecessary friction during onboarding.

### 2. `WORKSPACE_CREATE` rate limit — **10 per hour** ⚠️ Potentially Restrictive
- **File**: `apps/api/src/middleware/rate-limit.ts:31`
- **What it does**: Limits workspace creation per user per hour.
- **Problem**: Power users running multiple agents or iterating rapidly on tasks could easily hit this. Each workspace creation provisions a VM, so there's a cost concern — but the user is paying for their own cloud (BYOC), so the cost is theirs.
- **Recommendation**: Raise to **25-50/hour**. The BYOC model means the user bears the cost. Hetzner's own API rate limits (3600/hour) are a natural backstop. This limit should prevent accidental loops, not constrain intentional use.

### 3. `MAX_WORKSPACES_PER_NODE` — **3** ⚠️ Likely Too Low
- **File**: `packages/shared/src/constants.ts:60`
- **What it does**: Limits how many workspaces (devcontainers) can run on a single node (VM).
- **Problem**: A "large" Hetzner VM (CCX33 — 8 vCPU, 32 GB RAM) can comfortably run more than 3 devcontainers if they're lightweight. Even a "medium" VM could handle 4-5 if agents are doing code review or small edits rather than heavy compilation. The limit is per-node, not per-user, so it's about resource density.
- **Recommendation**: Raise to **5-8** for the default, or better yet, make it VM-size-aware (e.g., small=2, medium=4, large=8). The CPU/memory thresholds (50%) already act as a safeguard against overloading.

### 4. `MAX_PROJECTS_PER_USER` — **25** ⚠️ Potentially Restrictive
- **File**: `packages/shared/src/constants.ts:69`
- **What it does**: Limits how many projects a user can create.
- **Problem**: A freelancer or consultant working across many client repos could easily exceed 25. GitHub users routinely have hundreds of repos. This limit doesn't save meaningful resources — projects are just D1 rows with lightweight metadata.
- **Recommendation**: Raise to **100-200**. Projects are cheap (just metadata + a DO per project). There's no infrastructure cost until workspaces are created.

### 5. `MAX_MESSAGE_LENGTH` (task description) — **2,000 chars** ⚠️ Too Short for Complex Tasks
- **File**: `apps/api/src/routes/tasks/submit.ts:35`
- **What it does**: Maximum length for a task description when submitting a task.
- **Problem**: 2,000 characters is quite short for detailed task descriptions. A task like "refactor the authentication system to support OAuth2 with PKCE flow, update the following 5 files, ensure backward compatibility with existing tokens, and add tests for..." easily exceeds 2,000 chars. Claude Code prompts can be very detailed.
- **Recommendation**: Raise to **10,000-20,000 chars**. The description is stored in D1 and sent to the agent — both can handle much larger payloads. The real constraint should be the agent's context window, not an arbitrary DB field limit.

### 6. `ACTIVITY_MESSAGE_MAX_LENGTH` — **500 chars** and `LOG_MESSAGE_MAX_LENGTH` — **200 chars** ⚠️ Truncation Loses Context
- **File**: `apps/api/src/routes/mcp.ts:62-64`
- **What it does**: Truncates activity and log messages from agent progress reporting.
- **Problem**: 200 characters for a log message means most useful error messages or progress descriptions get cut off. "Installing dependencies... building project... running tests on packages/vm-agent/internal/server..." is already 100+ chars. Agent progress updates are often the only debugging signal when a task fails.
- **Recommendation**: Raise `ACTIVITY_MESSAGE_MAX_LENGTH` to **2,000** and `LOG_MESSAGE_MAX_LENGTH` to **1,000**. These are stored in D1 — a few KB per event is negligible.

### 7. `MAX_PROMPT_BYTES` and `MAX_CONTEXT_BYTES` — **64 KB each** ⚠️ May Be Too Small
- **File**: `apps/api/src/routes/projects/acp-sessions.ts:39, 251`
- **What it does**: Limits the size of prompts and context payloads for ACP sessions.
- **Problem**: 64 KB sounds generous for a simple prompt, but when including file contents, error logs, stack traces, or multi-file context, it's tight. A single medium-sized source file can be 20-50 KB. These are hardcoded (not configurable via env var), which also violates the constitution's configurability principle.
- **Recommendation**: Raise to **256 KB** and make configurable via env var. The payload is sent via HTTP to the VM agent, which forwards it to Claude — the real constraint is Claude's context window (~200K tokens), not a 64 KB byte limit.

### 8. `MAX_TASK_DEPENDENCIES_PER_TASK` — **25** — Probably Fine But Arbitrary
- **File**: `packages/shared/src/constants.ts:75`
- **What it does**: Limits how many dependency edges a single task can have.
- **Problem**: 25 is likely sufficient for almost all real cases, but it's an arbitrary number. The actual constraint should be about preventing circular dependencies and query performance, not about an absolute edge count.
- **Recommendation**: Could raise to **50** to be safe, but this is low priority. Current limit is unlikely to cause real friction.

---

## Limits That Seem Reasonable As-Is

These limits serve clear purposes and their values are well-calibrated.

### Resource Allocation
| Limit | Value | Why It's Fine |
|-------|-------|---------------|
| `MAX_NODES_PER_USER` | 10 | Prevents runaway VM provisioning. 10 nodes × 3 workspaces = 30 concurrent environments — plenty. |
| `MAX_AGENT_SESSIONS_PER_WORKSPACE` | 10 | A workspace having 10 concurrent agent sessions is already extreme. |
| `MAX_TASKS_PER_PROJECT` | 500 | Tasks are actively tracked items, not historical records. 500 active tasks is a lot. |
| `WORKSPACE_NAME_MAX_LENGTH` | 64 | Standard naming constraint. DNS labels max at 63 chars anyway. |

### Timeouts (Well-Calibrated)
| Limit | Value | Why It's Fine |
|-------|-------|---------------|
| `NODE_HEARTBEAT_STALE_SECONDS` | 180s (3 min) | Agent heartbeats every 30s, so 6 missed beats = dead. Reasonable. |
| `TASK_RUN_MAX_EXECUTION_MS` | 4 hours | Aligned with `MAX_AUTO_NODE_LIFETIME_MS`. Long enough for complex tasks. |
| `TASK_STUCK_QUEUED_TIMEOUT_MS` | 10 min | Well-documented: accounts for cold-start provisioning + agent bootstrap. |
| `TASK_STUCK_DELEGATED_TIMEOUT_MS` | 31 min | Explicitly set 1 min above workspace ready timeout to avoid false positives. |
| `PROVISIONING_TIMEOUT_MS` | 30 min | Devcontainer builds can be very slow. This is generous by design. |
| `NODE_WARM_TIMEOUT_MS` | 30 min | Balance between reuse and cost. Configurable. |
| `ACP_TASK_PROMPT_TIMEOUT` | 6 hours | Long-running agent tasks need this. |
| `MCP_TOKEN_TTL_SECONDS` | 2 hours | Reasonable session duration for MCP connections. |

### Pagination & Query Limits
| Limit | Value | Why It's Fine |
|-------|-------|---------------|
| `TASK_LIST_MAX_PAGE_SIZE` | 200 | Standard pagination limit. |
| `CHAT_MESSAGES_MAX` | 5000 | Very generous for a single session. |
| `OBSERVABILITY_ERROR_MAX_ROWS` | 100,000 | Reasonable cap for a D1 table. |

### VM Agent Limits
| Limit | Value | Why It's Fine |
|-------|-------|---------------|
| `SESSION_MAX_COUNT` | 100 | Concurrent sessions on a single VM. 100 is generous. |
| `SESSION_TTL` | 24h | Sessions shouldn't live forever. 24h is a full workday. |
| `PTY_OUTPUT_BUFFER_SIZE` | 256 KB | Per-PTY ring buffer. Enough for scrollback. |
| `ACP_MESSAGE_BUFFER_SIZE` | 5000 | Messages per session host. Generous. |
| `MAX_WORKTREES_PER_WORKSPACE` | 5 | Git worktrees are resource-intensive. 5 is reasonable. |

### Content Size Limits
| Limit | Value | Why It's Fine |
|-------|-------|---------------|
| `MAX_STACK_LENGTH` | 4096 | Stack traces longer than 4 KB are rarely useful — just noise. |
| `MAX_SOURCE_LENGTH` | 256 | Source identifiers (file paths, component names) — 256 chars is plenty. |
| `OUTPUT_SUMMARY_MAX_LENGTH` | 2000 | Task output summaries stored in D1 — 2 KB is fine for summaries. |
| `GIT_FILE_MAX_SIZE` | 1 MB | Single file from git — 1 MB is generous for source code. |
| `CLOUD_INIT_SIZE_LIMIT` | 32 KB | Hetzner's API constraint — cannot be changed. |

---

## Hardcoded Limits That Should Be Made Configurable

These violate Constitution Principle XI (all values must be configurable).

| Limit | Value | File | Recommendation |
|-------|-------|------|----------------|
| `MAX_PROMPT_BYTES` | 65536 | `acp-sessions.ts:39` | Add env var `MAX_ACP_PROMPT_BYTES` |
| `MAX_CONTEXT_BYTES` | 65536 | `acp-sessions.ts:251` | Add env var `MAX_ACP_CONTEXT_BYTES` |
| `MAX_MESSAGE_LENGTH` (task submit) | 2000 | `tasks/submit.ts:35` | Add env var `MAX_TASK_MESSAGE_LENGTH` |
| `ACTIVITY_MESSAGE_MAX_LENGTH` | 500 | `mcp.ts:62` | Add env var `MAX_ACTIVITY_MESSAGE_LENGTH` |
| `LOG_MESSAGE_MAX_LENGTH` | 200 | `mcp.ts:64` | Add env var `MAX_LOG_MESSAGE_LENGTH` |
| `MAX_MESSAGE_LENGTH` (client errors) | 2048 | `client-errors.ts:16` | Add env var `MAX_CLIENT_ERROR_MESSAGE_LENGTH` |
| `BOOT_LOG_TTL` | 1800 | `boot-log.ts:4` | Add env var `BOOT_LOG_TTL_SECONDS` |
| `DNS_TTL` | 60 | `dns.ts:7` | Add env var `DNS_RECORD_TTL` |
| `MAX_BRANCH_NAME_LENGTH` | 60 | `branch-name.ts:11` | Add env var `MAX_BRANCH_NAME_LENGTH` |
| `Messages batch limit` | 100 | `workspaces/runtime.ts:354` | Add env var `MAX_MESSAGES_PER_BATCH` |
| `Agent session label` | 50 | `agent-sessions.ts:146` | Add env var `MAX_AGENT_SESSION_LABEL_LENGTH` |

---

## Summary of Priority Recommendations

### High Priority (likely causing real user friction)
1. **Raise `MAX_MESSAGE_LENGTH` for task descriptions** from 2,000 → 10,000-20,000 chars
2. **Raise `CREDENTIAL_UPDATE` rate limit** from 5 → 20-30/hour
3. **Raise `LOG_MESSAGE_MAX_LENGTH`** from 200 → 1,000 chars
4. **Raise `ACTIVITY_MESSAGE_MAX_LENGTH`** from 500 → 2,000 chars
5. **Raise `MAX_PROMPT_BYTES` / `MAX_CONTEXT_BYTES`** from 64 KB → 256 KB + make configurable

### Medium Priority (pre-emptive improvements)
6. **Raise `WORKSPACE_CREATE` rate limit** from 10 → 25-50/hour
7. **Raise `MAX_WORKSPACES_PER_NODE`** from 3 → 5-8 (or make VM-size-aware)
8. **Raise `MAX_PROJECTS_PER_USER`** from 25 → 100

### Low Priority (minor improvements)
9. **Make hardcoded limits configurable** (see table above) — constitution compliance
10. **Raise `MAX_TASK_DEPENDENCIES_PER_TASK`** from 25 → 50

---

## Acceptance Criteria

- [ ] Review recommendations with team
- [ ] Decide which limits to change
- [ ] Implement changes (separate PR per category)
- [ ] Ensure all changed limits remain configurable via env vars
