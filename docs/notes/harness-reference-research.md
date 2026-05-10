# AI Coding Agent Implementation Research

> **Purpose**: Reference research for the SAM harness (`packages/harness/`). Documents how leading open-source AI coding agents implement core features, with actionable recommendations.
>
> **Method**: Cloned repos, read source code, traced git history. All file references are to the cloned repos at research time (May 2026).
>
> **Last Updated**: 2026-05-10

---

## Table of Contents

1. [Per-Project Findings](#per-project-findings)
   - [Aider](#1-aider)
   - [SWE-agent](#2-swe-agent)
   - [OpenHands](#3-openhands)
   - [Claude Code](#4-claude-code)
   - [Cline](#5-cline)
   - [Goose](#6-goose)
2. [Cross-Project Comparison Tables](#cross-project-comparison-tables)
3. [Actionable Recommendations for SAM Harness](#actionable-recommendations-for-sam-harness)
4. [Evolution Insights](#evolution-insights)

---

## Per-Project Findings

### 1. Aider

**Language**: Python | **Provider abstraction**: LiteLLM (lazy-loaded singleton)

#### A. Diff/Edit Tool Design

Aider has the most diverse edit format system — **12 coder classes** in `aider/coders/`, each implementing a different edit format:

| Format | Class | Approach |
|--------|-------|----------|
| `diff` (default) | `EditBlockCoder` | SEARCH/REPLACE blocks with `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` markers |
| `whole` | `WholeFileCoder` | Full file replacement |
| `udiff` | `UnifiedDiffCoder` | Standard unified diff format |
| `patch` | `PatchCoder` | Advanced patch with git cherry-pick fallback |
| `architect` | `ArchitectCoder` | Two-model system: architect plans, editor executes |
| `editor-diff` | `EditorEditBlockCoder` | Variant using a separate "editor" model for the edit |

**Fuzzy matching cascade** (`editblock_coder.py:127-329`):
1. Exact line match (`perfect_replace`)
2. Whitespace-normalized match (`perfect_or_whitespace`) — compensates for LLM indentation drift
3. Ellipsis expansion (`try_dotdotdots`) — handles `...` placeholders in SEARCH blocks
4. Edit distance (disabled — `return` at line 184, kept as dead code)

On failure, `find_similar_lines()` uses `SequenceMatcher(threshold=0.6)` to suggest the closest block in the file, feeding the hint back to the LLM as a "reflected message" for retry (up to `max_reflections=3`).

**Advanced fallback strategies** in `search_replace.py` (used by `patch_coder` and `udiff_coder`):
- `flexible_search_and_replace()` tries a matrix of (strategy, preprocessor) combinations
- Strategies include `git_cherry_pick_osr_onto_o` (creates a temp git repo, performs a real cherry-pick) and `dmp_lines_apply` (Google diff-match-patch)
- Preprocessors include `RelativeIndenter` (converts absolute indentation to relative offsets) and reverse-lines

**Guardrails**:
- `allowed_to_edit()` blocks edits to files not explicitly added to the chat
- `.aiderignore` support
- `dry_run` mode logs without writing
- Shell commands require explicit `y` confirmation (Enter alone doesn't count)
- `AIDER_SANITY_CHECK_TURNS` env var validates role alternation before sending

#### B. Context Management & Compaction

**Token counting**: LiteLLM's `token_counter()` / `encode()` — no direct tiktoken import.

**History budget**: `max_chat_history_tokens = min(max(max_input_tokens / 16, 1024), 8192)` — clamped between 1K-8K tokens regardless of model context window.

**Compaction strategy** (`ChatSummary` in `history.py`):
- **Recursive halving**: splits history at the midpoint where the tail occupies ~50% of budget, summarizes the head via LLM, recurses if still too large. Max recursion depth: 3.
- Tries weak model first (e.g., GPT-3.5), falls back to main model.
- Runs in a **background thread** (`summarize_start()` launches `threading.Thread`), blocks only when the next send needs the result.
- On coder format switch, `summarize_all()` runs **synchronously** to collapse old-format examples.

**Message ordering** (`ChatChunks`): `system → examples → readonly_files → repo → done_messages → chat_files → current → reminder`. The system prompt reminder is only appended when token headroom allows.

**Context window exceeded**: catches `ContextWindowExceededError` from LiteLLM, shows per-component token breakdown, aborts the turn.

#### C. Streaming Architecture

All providers route through `litellm.completion()`. `LazyLiteLLM` proxy class defers the ~1.5s import until first use.

Streaming path (`show_send_output_stream`): iterates chunks, extracts `delta.content` and `delta.reasoning_content` (tried as both `.reasoning_content` and `.reasoning` for provider compat). Content rendered via Rich `Live` markdown display or raw stdout.

**Multi-response continuation**: when a model hits output length limit and supports `assistant_prefill`, Aider accumulates the response as an assistant prefix and calls `send()` again — achieving unbounded output length.

#### D. Permission & Safety

- `abs_fnames` (editable) vs `abs_read_only_fnames` (read-only) — explicit file sets
- Files not in chat require user confirmation to edit
- `.aiderignore` excludes files
- `auto_commits=True` by default with `dirty_commit()` preserving rollback points

#### E. Session Persistence

**Format**: Plain Markdown files (`~/.aider.chat.history.md`). `#### ` prefix = user, no prefix = assistant, `> ` prefix = tool output. Parsed by `split_chat_history_markdown()`.

**Resume**: `--restore-chat-history` loads into `done_messages` and immediately queues for background summarization.

**No database, no JSON** — everything is plaintext Markdown. Separate readline history for input (`~/.aider.input.history`).

#### F. Tool Output & Formatting

No explicit output truncation. Context managed at the message-construction layer via history summarization and budget. `choose_fence()` scans all file contents to find a fence style that doesn't conflict with content.

---

### 2. SWE-agent

**Language**: Python | **Provider abstraction**: LiteLLM (non-streaming)

#### A. Diff/Edit Tool Design

SWE-agent offers **four edit tool implementations** selected via config bundles:

| Tool | File | Approach |
|------|------|----------|
| Line-range replacement | `tools/windowed_edit_linting/` | `edit <start>:<end>` — replaces lines start-end inclusive |
| Search-and-replace in window | `tools/windowed_edit_replace/` | `edit <search> <replace>` — operates only within the currently displayed 100-line window |
| Window rewrite | `tools/windowed_edit_rewrite/` | Replaces the entire visible window |
| Anthropic str_replace | `tools/edit_anthropic/` | `str_replace_editor` — view/create/str_replace/insert/undo_edit |

**Edit failure handling**: All tools run `flake8` after applying edits. If new syntax errors are introduced, the **edit is automatically reverted** and the agent sees a side-by-side comparison of the broken vs original code. The `RETRY_WITH_OUTPUT_TOKEN` mechanism triggers a requery with the error output.

**The `str_replace_editor` variant** maintains file history in a registry (`_file_history` keyed by path) for undo support. It also includes a `WindowExpander` that extends the viewport to include whole functions/classes (finds breakpoints at blank lines, `def`, `class`, `@` decorators), and a `Filemap` class using tree-sitter to show Python file structure with function bodies elided.

#### B. Context Management

**Sliding window** (`LastNObservations` in `history_processors.py`):
- Keeps last N observations (default 5), replaces older ones with `"Old environment output: (N lines omitted)"`
- `polling` parameter (default 1) groups updates to preserve prompt caching — keeps between N and N+K observations
- `always_keep_output_for_tags` / `always_remove_output_for_tags` for per-message overrides

**Closed window processor** (`ClosedWindowHistoryProcessor`): for file windows that have been superseded (same file opened again), replaces old window content with `"Outdated window with N lines omitted..."`.

**Prompt caching** (`CacheControlHistoryProcessor`): sets Anthropic `cache_control: {type: ephemeral}` on the last N user/tool messages.

**Observation truncation**: max 100,000 characters, with `<response clipped>` and advice to use head/tail/grep.

**Context overflow**: counts tokens before sending; raises `ContextWindowExceededError` which triggers autosubmission.

#### C. Tool/Command Design (ACI Principles)

Every tool is a "Bundle" — a directory with `config.yaml` + executable scripts in `bin/`. Commands are auto-documented into the system prompt via `{{command_docs}}`.

**File viewer**: 100-line sliding window with `(N more lines above)` / `(M more lines below)` indicators. `goto` positions the target line 1/6 from the top.

**Key ACI principles** (from `docs/background/aci.md`):
1. Linter blocks syntactically broken edits from going through
2. Special file viewer (not raw `cat`) showing windowed content
3. Search lists only filenames (not full match context — avoids confusing the model)
4. Empty output → explicit message "Your command ran successfully and did not produce any output"

**Blocklist**: blocks `vim`, `vi`, `emacs`, `nano`, `nohup`, `gdb`, `less`, `tail -f`, `python -m venv`, standalone `python`/`bash`/`sh`. Uses `bash -n` syntax checking before execution.

**State machine**: `/root/state.json` holds `open_file`, `working_dir`, and optionally `diff` — updated by state commands after each step.

#### D. Permission & Safety

- Docker sandbox via SWE-ReX (all execution in containers)
- Timeouts: 30s per command, 1800s total, 300s for installs
- Cost limits: $3/task default
- After 3 consecutive timeouts, auto-submits
- Max 3 requeries for format/blocklist/syntax errors before auto-submitting

#### E. Session Persistence

**Trajectory format**: JSON files (`.traj`) with per-step `action`, `observation`, `response`, `thought`, `state`, `execution_time`, full `query` (messages sent to model).

Saved incrementally after every step. `ReplayModel` can replay trajectories step-by-step for creating demonstrations.

#### F. Streaming

**No streaming** — uses `litellm.completion()` non-streaming. Full response received before parsing and execution. Retry via `tenacity` with random exponential backoff (10-120s, up to 20 retries).

---

### 3. OpenHands

**Language**: Python (app server) + SDK package | **Provider abstraction**: SDK-internal

#### A. Diff/Edit Tool Design

Edit tools live in the separate `openhands-sdk` package (not in the app server repo). The app server selects tool presets:
- `get_default_tools(enable_browser, enable_sub_agents)` for standard agents
- `get_planning_tools(plan_path)` for planning agents

#### B. Context Management & Compaction

Uses `LLMSummarizingCondenser` from the SDK:
- `max_size` default: bumped from 120 to 240 in migration 087 (Jan 2026)
- Condenser was **globally disabled** in migration 020 (April 2025) after problems, then re-enabled in migration 024
- Gets a separate `usage_id` for tracing (`'condenser'` vs `'planning_condenser'`)

**Evolution insight**: The condenser was shipped, disabled for all users after bugs, given per-user `condenser_max_size` controls, had its defaults bumped, then re-enabled. This shows the importance of per-user configuration and kill switches for compaction.

#### C. Streaming Architecture

**Frontend ↔ Agent-server**: Socket.IO WebSocket with `oh_event` channel. Reconnection: 5 attempts, 1s delay.

**App server → frontend**: HTTP `StreamingResponse` during conversation start (status task updates).

**Events**: REST API for paginated event search, stored per-conversation keyed by UUID.

#### D. Permission & Safety

- Docker containers per conversation with `init=True` (tini for zombie reaping)
- Session API key: 256-bit random value, only valid while sandbox is RUNNING
- Three confirmation policies: `NeverConfirm`, `AlwaysConfirm`, `ConfirmRisky` (LLM-assisted)
- CORS per-container via env vars

#### E. Session Persistence

Three storage backends:
1. **Filesystem**: JSON files at `{persistence_dir}/{user_id}/v1_conversations/{conversation_id_hex}/{event_id_hex}.json`
2. **Google Cloud Storage**
3. **AWS S3**

Conversation metadata in PostgreSQL (SQLAlchemy + asyncpg). Pending messages queued during startup, replayed when READY.

#### F. Parallel Tool Execution

Not visible in the app server repo — would be in the SDK.

---

### 4. Claude Code

**Language**: TypeScript | **Provider abstraction**: Anthropic API (native)

#### A. Diff/Edit Tool Design

Claude Code provides two edit tools:
- **`Edit`**: Search-and-replace with exact match requirement. The `old_string` must appear exactly once.
- **`Write`**: Full file creation/overwrite.

The Edit tool's simplicity is intentional — it relies on the model to provide enough context for unique matching rather than implementing complex fuzzy matching.

#### B. Context Management & Compaction

Claude Code uses automatic context compression as conversations approach context limits. The system preserves system prompts and recent messages while summarizing older content.

#### C. Streaming Architecture

Native Anthropic streaming API with Server-Sent Events. Supports partial tool call streaming with incremental argument assembly.

#### D. Permission & Safety

**Permission modes** (from SDK):
- `default` — standard permission behavior
- `acceptEdits` — auto-accept file edits
- `plan` — read-only tools only
- `dontAsk` — deny anything not pre-approved instead of prompting
- `bypassPermissions` — bypass all checks (use with caution)

**Custom permission handlers**: `can_use_tool(tool_name, input_data, context)` returns `PermissionResultAllow` (optionally with modified input) or `PermissionResultDeny`.

**Hooks system**: `PreToolUse` / `PostToolUse` hooks can auto-approve, auto-deny, or modify tool inputs. Example: auto-approve read-only tools (Read, Glob, Grep).

**Tool classification**: Read-only tools (Read, Glob, Grep) are commonly auto-approved; write tools and Bash require more scrutiny.

#### E. Session Persistence

Session management via session IDs. First query returns a `session_id` in an `init` message. Subsequent queries can `resume` with that ID to maintain full conversation context.

#### F. Tool Output & Formatting

Context-aware formatting with line numbers. Edit results show the changed region with surrounding context lines. Subagent system for delegating specialized tasks.

---

### 5. Cline

**Language**: TypeScript (VS Code extension) | **Provider abstraction**: Multi-provider async generators

#### A. Diff/Edit Tool Design

**Three edit tools**:

| Tool | Approach |
|------|----------|
| `write_to_file` | Full file content replacement |
| `replace_in_file` | SEARCH/REPLACE diff with `------- SEARCH` / `=======` / `+++++++ REPLACE` delimiters |
| `apply_patch` | Multi-file patch with `*** Begin Patch` / `*** End Patch` sentinels — supports ADD, UPDATE, DELETE, MOVE operations |

**Streaming diff view**: Both `write_to_file` and `replace_in_file` stream content into a VS Code diff editor in real-time via `DiffViewProvider`. Updates are incremental (`update(content, false)` while streaming, `update(content, true)` to finalize).

**Model-specific content fixes** (`ModelContentProcessor.ts`): patches for DeepSeek (unescaped HTML entities), Llama/Gemini (extra escape characters), and markdown code block wrappers.

**User edit capture**: If the user modifies the proposed changes during the approval step, the diff between proposed and user-modified content is captured as `user_feedback_diff` and fed back to the LLM.

#### B. Context Management & Compaction

**Two strategies** (controlled by `useAutoCondense` flag):

**Programmatic truncation** (legacy):
- Triggered when `totalTokens >= maxAllowedSize` from previous request
- Thresholds: 128K → reserve 30K, 200K → reserve 40K, 64K (DeepSeek) → reserve 27K
- If usage > 2x limit: removes 3/4 of messages; otherwise removes 1/2
- Always preserves first user-assistant pair
- **File read deduplication first**: replaces repeated file reads with `[duplicate file read notice]` — only truncates if savings < 30%
- Context mutations persisted to `context_history.json` with timestamps for checkpoint rollback

**Auto-condense** (modern):
- LLM invokes a `CONDENSE` tool, writes a `<context>` summary
- On approval, conversation truncated to last 1-2 messages

**Token counting**: reads from previous API request's reported usage (`tokensIn + tokensOut + cacheWrites + cacheReads`).

**Tool pairing enforcement**: `ensureToolResultsFollowToolUse()` validates that every `tool_use` has a matching `tool_result`, adding `"result missing"` placeholders as needed.

#### C. Streaming Architecture

**`StreamChunkCoordinator`**: splits the `ApiStream` async generator into two paths:
- Usage chunks → dispatched immediately (keeps token state current)
- Content/tool chunks → queued internally, consumed via `nextChunk()` with waiter/notify pattern

**`StreamResponseHandler`** with sub-handlers:
- `ToolUseHandler`: accumulates `input_json_delta` chunks, parses via `@streamparser/json` (streaming JSON parser) for incremental field access. Falls back to regex-based extraction.
- `ReasoningHandler`: accumulates thinking/reasoning blocks.

**Non-streaming XML fallback** (`parseAssistantMessageV2`): index-based scan for XML tool markers — used for providers without native tool calling.

#### D. Permission & Safety

**Two layers**:

**Tool-level auto-approval** (`AutoApprove` class):
- `yoloModeToggled` / `autoApproveAllToggled` — approve everything
- Granular per-tool: `readFiles`, `editFiles`, `executeSafeCommands`, `executeAllCommands`, `useBrowser`, `useMcp`
- Path-aware split: workspace-internal vs external files have separate approval settings

**Command permission controller** (`CommandPermissionController`):
- Configured via `CLINE_COMMAND_PERMISSIONS` env var (JSON allow/deny with globs)
- Parses chained commands (`&&`, `||`, `|`, `;`) into segments, validates each
- Blocks redirect operators (`>`, `>>`) unless `allowRedirects: true`
- Detects backticks outside single quotes, newlines outside quotes

**Approval UX**: `ask("tool", message)` suspends execution. User can approve, reject, or provide text/image feedback that becomes part of the conversation.

#### E. Session Persistence

**Per-task directory** at `{globalStorageFsPath}/tasks/{taskId}/`:
- `api_conversation_history.json` — full message history
- `ui_messages.json` — UI display messages
- `context_history.json` — context mutation log (timestamped, supports checkpoint rollback)
- `task_metadata.json` — files in context, model usage

**Atomic writes**: temp file + rename pattern.

**Resume flow**: loads saved messages, strips incomplete trailing requests, re-initializes context history, shows resume prompt to user.

#### F. Tool Output & Formatting

- File reads: 1000-line default with `N | content` line-number format and continuation hints
- Command timeouts: 30s default, 300s for recognized long-running patterns (`npm install`, `cargo build`, `pytest`, `docker build`)
- Tool results wrapped as `[{toolDescription} Result:\n{resultText}]`
- Empty results → `"(tool did not return anything)"`

---

### 6. Goose

**Language**: Rust | **Provider abstraction**: `Provider` trait with `stream()` method

#### A. Diff/Edit Tool Design

**String-replace format** (`edit.rs`):

| Tool | Approach |
|------|----------|
| `file_read` | Read with optional `line` offset and `limit` |
| `file_write` | Full whole-file overwrite, auto-creates directories |
| `file_edit` | `string_replace(content, before, after)` — `before` must match exactly and uniquely |

On failure:
- 0 matches → error with `find_similar_context()` hint + 20-line file preview
- N>1 matches → error showing first 2 match locations with surrounding context

The design matches Claude Code's approach — forces the LLM to include enough context for unique identification.

#### B. Context Management & Compaction

**Token counting**: `tiktoken-rs` with `o200k_base` tokenizer as universal approximation. `DashMap<u64, usize>` cache (max 10K entries, AHash keys).

**Compaction trigger**: `total_tokens / context_limit > threshold` where default threshold = 0.8 (overridable via `GOOSE_AUTO_COMPACT_THRESHOLD`).

**Two complementary mechanisms**:

1. **Full conversation compaction** (`compact_messages()`):
   - Preserves most-recent user text-only message verbatim
   - Old messages marked `agent_invisible`; summary marked `agent_only`
   - Progressive tool-response removal on `ContextLengthExceeded`: tries [0%, 10%, 20%, 50%, 100%] removal before summarizing
   - Summary via `provider.complete_fast()` with Minijinja template

2. **Background tool-pair summarization** (`maybe_summarize_tool_pairs()`):
   - `tokio::spawn` background task — non-blocking
   - Batch size: 10 tool pairs
   - Cutoff: `(3 * effective_limit / 20_000).clamp(10, 500)` — protects recent tool calls
   - "Middle-out" removal algorithm — removes from center of tool response list outward

**Skip condition**: providers with `manages_own_context() = true` (CLI wrapper providers like Claude Code, Gemini CLI) bypass compaction entirely.

#### C. Streaming Architecture

```rust
MessageStream = Pin<Box<dyn Stream<Item = Result<(Option<Message>, Option<ProviderUsage>), ProviderError>> + Send>>
```

Each item carries optional partial message + optional usage. `collect_stream()` coalesces consecutive text blocks.

**Toolshim**: for models without native tool calling, `convert_tool_messages_to_text()` serializes tools to plain text, `toolshim_postprocess()` parses tool calls back out using `OllamaInterpreter`.

Tools sorted alphabetically before sending for stable prompt caching.

#### D. Permission & Safety

**Inspector chain** (priority order):
1. `SecurityInspector`
2. `EgressInspector`
3. `AdversaryInspector`
4. `PermissionInspector`
5. `RepetitionInspector`

**GooseMode enum**:
- `Auto` → all tools allowed immediately
- `Chat` → tools skipped (model describes what it would do)
- `Approve` → every tool requires confirmation
- `SmartApprove` → LLM-assisted decision with caching

**SmartApprove flow**: checks user-defined permission → read-only annotation → cached LLM decision → `detect_read_only_tools()` LLM call → caches result. Extension management tools always require approval (hardcoded security rule).

#### E. Session Persistence

**Storage**: SQLite at `{data_dir}/sessions/sessions.db`. WAL mode, 30s busy timeout, `BEGIN IMMEDIATE` for all writes.

**Schema** (version 12): `sessions` table (id, name, working_dir, token counts, model config, goose_mode, project_id) + `messages` table (role, content_json, metadata_json, created_timestamp).

**Session ID format**: `YYYYMMDD_N` — date-prefixed with auto-incrementing integer.

**Resume**: messages ordered by `(created_timestamp, id)` — secondary sort on `id` preserves tool request/response ordering within the same second.

**After compaction**: `replace_conversation()` uses DELETE-all + re-INSERT within `BEGIN IMMEDIATE`.

**Legacy import**: reads old JSON session files on first init.

#### F. Tool Output & Formatting

**Large response handling** (`large_response_handler.rs`):
- Threshold: 200,000 characters
- Responses exceeding threshold → written to temp file, model told: `"The response was larger ({N} chars) and is stored in: {path}"`
- Model can then use `file_read` with line ranges to selectively examine
- **Does NOT truncate** — preserves full fidelity by offloading to filesystem

#### G. Parallel Tool Execution

**Pre-approved tools**: dispatched immediately into `Vec<(String, ToolStream)>`, polled concurrently.

**Approval-requiring tools**: processed **sequentially** — register with `tool_confirmation_router`, yield `ActionRequired` message, await confirmation, then proceed.

Extension loading also uses `futures::future::join_all()` for parallel startup.

---

## Cross-Project Comparison Tables

### Edit Tool Formats

| Project | Primary Format | Fuzzy Matching | Lint-Gate | Undo | Streaming Diff View |
|---------|---------------|----------------|-----------|------|---------------------|
| **Aider** | SEARCH/REPLACE blocks | Yes — whitespace normalization, ellipsis, git cherry-pick fallback | No (post-edit only) | Via git auto-commit | No |
| **SWE-agent** | Line-range replacement OR search-replace in window | No (exact match) | **Yes** — flake8, auto-reverts broken edits | Yes (str_replace variant) | No |
| **OpenHands** | SDK-internal (not visible) | Unknown | Unknown | Unknown | Unknown |
| **Claude Code** | Search-and-replace (unique match) | No | No | No | No |
| **Cline** | SEARCH/REPLACE + multi-file patch | Line-trimmed fallback | No | Via diff view revert | **Yes** — real-time VS Code diff |
| **Goose** | String replace (unique match) | No | No | No | No |
| **SAM Harness** | Search-and-replace + unified diff | Fuzzy ±3 lines for diff; word-score hints for edit | No | No | No |

### Context Management

| Project | Trigger | Strategy | Preserves | Background | Token Counter |
|---------|---------|----------|-----------|------------|---------------|
| **Aider** | History budget (1K-8K tokens) | LLM recursive halving (depth 3) | System prompt + current turn | Yes (thread) | LiteLLM |
| **SWE-agent** | Per-observation limit | Sliding window (last N obs) + closed-window elision | First observation | No | LiteLLM |
| **OpenHands** | `max_size` threshold | LLM summarization | Configurable | Unknown | SDK-internal |
| **Claude Code** | Near context limit | System-managed compression | System prompt + recent | Yes | Native API |
| **Cline** | Previous request total tokens | Truncation (remove 50-75%) OR LLM condense tool | First user-assistant pair | No | API usage report |
| **Goose** | 80% of context limit | LLM summary + progressive tool removal + background tool-pair summarization | Recent user message | Yes (tokio::spawn) | tiktoken-rs (o200k) |
| **SAM Harness** | 80% of max tokens | Extractive summary OR LLM summary (with extractive fallback) | System prompt + last 6 messages | No | Word-count heuristic |

### Permission Systems

| Project | Modes | Tool Classification | Auto-Approve | LLM-Assisted |
|---------|-------|--------------------:|:------------:|:------------:|
| **Aider** | Edit-only + shell confirm | Editable files vs read-only | Files in chat | No |
| **SWE-agent** | Sandbox-only | Blocklist (interactive editors, bare interpreters) | N/A (sandboxed) | No |
| **OpenHands** | Never/Always/Risky | SDK-internal | N/A | Yes (LLMSecurityAnalyzer) |
| **Claude Code** | 5 modes (default→bypass) | Read-only vs write vs dangerous | Via hooks/config | No |
| **Cline** | Per-tool granular + command controller | Read/edit/execute/browser/MCP × local/external | Yes (configurable) | No |
| **Goose** | Auto/Chat/Approve/SmartApprove | Inspector chain (5 inspectors) | Yes (Auto mode) | Yes (SmartApprove) |
| **SAM Harness** | allow-all / deny-dangerous / ask-always | Safe/Write/Dangerous (3 levels) | allow-all mode | No |

### Session Persistence

| Project | Backend | Format | Resume Support | Compaction Persistence |
|---------|---------|--------|:--------------:|:---------------------:|
| **Aider** | Flat file | Markdown | Via `--restore-chat-history` | No (re-summarizes) |
| **SWE-agent** | Flat file | JSON trajectories | Via `ReplayModel` | No |
| **OpenHands** | FS / GCS / S3 | JSON events | Yes (pending message queue) | Per-user config |
| **Claude Code** | Session ID based | API-managed | Yes (session resume) | Yes |
| **Cline** | VS Code storage | JSON (multiple files per task) | Yes (strips incomplete requests) | Yes (context_history.json) |
| **Goose** | SQLite (WAL) | Relational (messages table) | Yes (timestamp + ID ordering) | Yes (replace_conversation) |
| **SAM Harness** | SQLite (WAL) | Relational (sessions + messages) | Yes (load messages) | No |

### Streaming & Provider Abstraction

| Project | Streaming | Provider Layer | Tool Call Streaming | Error Recovery |
|---------|:---------:|----------------|:-------------------:|----------------|
| **Aider** | Yes | LiteLLM (lazy singleton) | Via LiteLLM | Multi-response continuation |
| **SWE-agent** | **No** | LiteLLM | N/A | tenacity exponential backoff |
| **OpenHands** | Yes | Socket.IO WebSocket | SDK-internal | Socket.IO reconnect (5 attempts) |
| **Claude Code** | Yes | Anthropic native | Yes (partial args) | SSE reconnect |
| **Cline** | Yes | Multi-provider async generators | Yes (streaming JSON parser) | Per-provider retry decorators |
| **Goose** | Yes | Rust `Stream` trait | Yes (via MessageStream) | Provider-level |
| **SAM Harness** | Yes | Go channels (Anthropic + OpenAI) | Yes (index-based assembly) | SSE line scanner |

### Parallel Tool Execution

| Project | Supported | Strategy | Approval Handling |
|---------|:---------:|----------|-------------------|
| **Aider** | No | Sequential | N/A |
| **SWE-agent** | No | Sequential | N/A |
| **OpenHands** | Unknown | SDK-internal | SDK-internal |
| **Claude Code** | Yes | Multiple tool calls per response | Per-tool permission check |
| **Cline** | Yes | Via native tool_use blocks | Sequential approval |
| **Goose** | Yes | `Vec<ToolStream>` concurrent polling | Pre-approved parallel, approval sequential |
| **SAM Harness** | Yes | `sync.WaitGroup` concurrent dispatch | Pre-check before dispatch |

---

## Actionable Recommendations for SAM Harness

### Priority 1: Adopt Now

#### 1. Add lint-gate for edits (from SWE-agent)
**What**: After applying an edit, run the file through a linter/compiler check. If new errors are introduced, auto-revert and show the errors to the LLM.
**Why**: SWE-agent's research shows this dramatically reduces broken edits. The pattern is simple: save a backup, apply edit, lint, revert if broken.
**How**: In `tools/edit_file.go` and `tools/apply_diff.go`, after `atomicWrite()`, run a configurable lint command. If it fails, restore the backup and return the lint errors.

#### 2. File-read deduplication before compaction (from Cline)
**What**: Before triggering expensive LLM compaction, scan conversation history for repeated file reads of the same path and replace duplicates with `[duplicate file read]` placeholders.
**Why**: Cline found this gives ~30%+ context savings at zero cost, often making full compaction unnecessary. Our harness currently goes straight to LLM compaction.
**How**: In `context/compactor.go`, add a `deduplicateFileReads()` pass before calling the LLM compactor. Track `read_file` tool calls by path, keep only the latest.

#### 3. Background tool-pair summarization (from Goose)
**What**: Proactively summarize old tool request+response pairs in the background, independent of full compaction.
**Why**: Tool responses (especially file reads) are the largest context consumers. Goose's approach of batch-summarizing old tool pairs using `complete_fast()` in the background keeps context lean without interrupting the main loop.
**How**: Add a goroutine in the agent loop that periodically checks for old tool call/result pairs beyond a cutoff and summarizes them via a fast/cheap model call.

#### 4. Progressive tool-response removal before compaction (from Goose)
**What**: When context is exceeded, try removing tool response content in stages (10%, 20%, 50%, 100%) before falling back to full LLM summarization.
**Why**: Often just removing verbose tool outputs (large file reads, command outputs) is enough to get back within limits, and it's cheaper and faster than an LLM summary call.
**How**: In `context/compactor.go`, before calling the LLM, try `filterToolResponses()` at increasing percentages using a "middle-out" strategy (remove from center of history outward).

### Priority 2: Adopt Soon

#### 5. Large response file offload (from Goose)
**What**: Tool responses exceeding a threshold (e.g., 200K chars) should be written to a temp file, with the model told where to find them.
**Why**: This preserves full fidelity while keeping the context window manageable. The model can then use `file_read` with line ranges to selectively examine. Our current harness has no output truncation at all — a single large command output can consume the entire context.
**How**: In `tools/tool.go`, wrap tool execution results and check length. If over threshold, write to a temp file and return the file path message instead.

#### 6. Add "find similar context" on edit failure (from Goose/Aider)
**What**: When `edit_file`'s `old_string` isn't found, show the LLM similar lines from the file as hints.
**Why**: Our harness already has `findSimilarLines()` with word-score matching. Enhance it with: (a) showing the actual file content around the best match, and (b) including the line count so the model can adjust. Aider's `find_similar_lines()` with `SequenceMatcher(threshold=0.6)` is more robust than our word-overlap approach.
**How**: In `tools/edit_file.go`, enhance `findSimilarLines()` to use a proper string similarity algorithm (e.g., Levenshtein or longest common subsequence) instead of word overlap.

#### 7. Proper token counting (from Goose)
**What**: Replace our word-count heuristic (`context/tokens.go`) with tiktoken-based counting using the `o200k_base` tokenizer.
**Why**: Goose's approach of using a single tokenizer as a universal approximation with a hash-keyed cache is practical and accurate. Our current `EstimateTokens()` using `len(strings.Fields(text)) * 4/3` is a rough heuristic that can be significantly off.
**How**: Use a Go tiktoken library (e.g., `tiktoken-go`) with `o200k_base` encoding and add a sync.Map cache.

#### 8. "Empty output" explicit messaging (from SWE-agent)
**What**: When a tool (especially bash) produces no output, return an explicit message: "Your command ran successfully and did not produce any output."
**Why**: LLMs frequently misinterpret empty responses as errors. SWE-agent's ACI research identified this as a key UX improvement.
**How**: In `tools/bash.go`, check if stdout+stderr is empty on success and return the explicit message.

### Priority 3: Consider Later

#### 9. Recursive halving compaction (from Aider)
**What**: When a single compaction pass isn't enough, recursively split and summarize.
**Why**: Aider's approach handles very long conversations more gracefully than a single-pass summary. However, it's expensive (multiple LLM calls) and our current single-pass + extractive fallback may be sufficient for now.

#### 10. Background compaction thread (from Aider)
**What**: Run compaction in a background goroutine, blocking only when the result is needed for the next send.
**Why**: Reduces perceived latency — the LLM summary call happens while the user is reading the current response. We currently compact synchronously.

#### 11. Multi-response continuation (from Aider)
**What**: When a model hits output length limit, use assistant prefill to continue generation.
**Why**: Enables unbounded output for large refactors. Currently if the model hits the limit, the response is truncated.

#### 12. SmartApprove with LLM classification (from Goose)
**What**: Use an LLM call to classify whether a tool invocation is read-only, caching the result for future invocations of the same tool.
**Why**: More nuanced than our static Safe/Write/Dangerous classification. For example, a `bash` command running `ls` is safe, but `bash` running `rm -rf` is dangerous.

#### 13. Streaming diff view integration (from Cline)
**What**: Stream edit results incrementally to the UI as they're generated.
**Why**: For IDE integrations, showing the diff in real-time as the model generates it provides much better UX than waiting for the complete edit. Not relevant for CLI usage.

#### 14. Command blocklist (from SWE-agent)
**What**: Block interactive editors (`vim`, `nano`), bare interpreters (`python`, `bash`), and other commands that would hang.
**Why**: These commands block the agent loop indefinitely. SWE-agent's blocklist (prefix match + exact match + regex) is the most comprehensive approach.
**How**: In `tools/bash.go`, add a pre-execution check against a configurable blocklist.

---

## Evolution Insights

### Edit Tool Evolution

**Pattern**: Every project started with a simple edit format and added complexity over time.

- **Aider** started with whole-file replacement, evolved to SEARCH/REPLACE blocks, then added unified diff, then a patch format with git cherry-pick fallback. The edit distance fuzzy matcher was built, used, then **disabled** (dead code at line 184) — suggesting it caused more harm than good. The whitespace normalization and ellipsis handlers survived, indicating those are the useful fuzzy strategies.

- **SWE-agent** started with line-range replacement, then added windowed search-replace (operating only within the visible 100-line window), then the Anthropic str_replace variant. The key insight is scoping: edits within a window are more reliable because the model has just seen the exact content.

- **Cline** added `apply_patch` (multi-file patches with ADD/UPDATE/DELETE/MOVE) as a more powerful alternative to individual `replace_in_file` calls. This suggests that as agents become more capable, batch editing becomes important.

**Lesson for SAM**: Our harness has both `edit_file` (search-replace) and `apply_diff` (unified diff). The search-replace approach is the proven winner across projects. The unified diff tool is harder for models to use correctly. Consider making `edit_file` the primary recommendation and `apply_diff` the fallback.

### Context Management Evolution

**Pattern**: All projects went through a phase of "compaction causes bugs" before finding the right strategy.

- **OpenHands** disabled their condenser globally after bugs, then added per-user size controls, bumped defaults, and re-enabled. The lesson: compaction needs kill switches and configurable thresholds.

- **Aider** tried edit-distance-based fuzzy compaction, disabled it, and settled on LLM-based recursive halving with background threading. The lesson: extractive/heuristic compaction is fragile; LLM summarization is more robust.

- **Goose** added progressive tool-response removal as a cheaper alternative to full LLM compaction. The lesson: removing verbose tool outputs first is often sufficient and avoids the cost/latency of an LLM summary call.

- **Cline** added file-read deduplication as a pre-compaction pass. The lesson: many context savings are deterministic (duplicate reads) and don't need an LLM.

**Lesson for SAM**: Our harness should implement a compaction cascade: (1) deduplicate file reads → (2) remove old tool responses progressively → (3) LLM summary as last resort. Each level is cheaper than the next.

### Permission System Evolution

**Pattern**: Projects moved from binary (allow/deny) to nuanced classification.

- **Goose** evolved from simple Auto/Approve modes to a `SmartApprove` mode that uses an LLM to classify tool danger and caches the result. This eliminates the false positive problem (safe bash commands requiring approval) without the false negative problem (dangerous commands auto-approved).

- **Cline** evolved from a single auto-approve toggle to granular per-tool settings with workspace-internal vs external path awareness.

- **Claude Code** added a hooks system that allows external scripts to make permission decisions, decoupling the policy from the core.

**Lesson for SAM**: Our 3-level system (Safe/Write/Dangerous) is a good start. The next evolution should be pattern-based classification within the Dangerous category (e.g., `bash ls` is safe, `bash rm` is dangerous).

### Session Persistence Evolution

**Pattern**: Projects moved from flat files to databases.

- **Aider** uses plain Markdown — simple but loses tool call structure.
- **SWE-agent** uses JSON trajectories — good for replay but not queryable.
- **Goose** uses SQLite with WAL — the most robust approach, with proper migration versioning (schema v12) and atomic writes via `BEGIN IMMEDIATE`.

**Lesson for SAM**: Our SQLite-based session store is aligned with the best practice (Goose's approach). Consider adding: (a) schema versioning/migrations, (b) compaction persistence (save the compacted state so resume doesn't re-summarize), (c) `BEGIN IMMEDIATE` for write transactions to prevent lock upgrade deadlocks.

### Tool Output Evolution

**Pattern**: Projects discovered that raw tool output is the #1 context consumer.

- **Goose**'s file offload approach (write to temp file, tell model the path) is the most elegant solution — preserves full fidelity without consuming context.
- **SWE-agent**'s 100K char truncation with `<response clipped>` is simpler but loses data.
- **Cline**'s 1000-line file read limit with continuation hints is a good middle ground.

**Lesson for SAM**: We should implement file offload for large outputs (>200K chars) as the primary strategy, with line limits on file reads (e.g., 1000 lines with `start_line` param) as a secondary guardrail.
