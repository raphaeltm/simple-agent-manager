---
title: Chat Features
description: The session tool rail, file browsing, tool activity cards, conversation forking, search, voice input, and text-to-speech in SAM's chat interface.
---

SAM's project pages are chat-first interfaces where you interact with AI coding agents in real-time.

Recent chat updates make the workspace feel more like a persistent work surface: task-backed chats can be forked consistently, SAM-injected setup context is collapsed out of the main conversation, and desktop sidebars can be collapsed when you need more room.

## Real-Time Streaming

Agent output streams directly to your browser via WebSocket. You see code being written, terminal commands executing, and the agent's thought process as it happens — no waiting for a complete response.

## The Session Tool Rail

Most of what you can do _to_ a session — rather than _say_ to it — lives in the **tool rail** down
the right edge of the chat. It is the same rail on desktop and mobile, and it is where most of the
features on this page are opened from. (The session's lifecycle controls — Interrupt, Sleep,
Archive — and the agent's plan sit in the dock just above the composer instead, because they act on
the conversation you are in rather than opening something beside it.)

| Tool          | What it opens                                                                                                                                                      | When it appears                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **Files**     | The workspace file browser — [File Browsing](#file-browsing)                                                                                                       | While the session is live and has a workspace            |
| **Git**       | Uncommitted changes in the workspace                                                                                                                               | While the session is live and has a workspace            |
| **Timeline**  | A jump list through the session's history                                                                                                                          | Always                                                   |
| **Resources** | CPU, memory, I/O, and OOM history — [Session Resource History](/docs/guides/session-resources/)                                                                    | Always                                                   |
| **Events**    | This session's subscriptions, schedules, and watches — [Scheduled actions](/docs/guides/scheduled-actions/)                                                        | Always                                                   |
| **Comments**  | Comment threads on this session. Unresolved threads show as a dot in icons mode and a count in labels mode; the marker turns amber when a thread is waiting on you | Always                                                   |
| **Retry**     | Re-run the task behind the session                                                                                                                                 | When the session has a task                              |
| **Fork**      | Start a new task from this session — [Conversation Forking](#conversation-forking)                                                                                 | When the session has a task                              |
| **Report**    | File a problem report — [Reporting Issues](/docs/guides/reporting-issues/)                                                                                         | When the deployment has reporting configured             |
| **Complete**  | Mark the task complete                                                                                                                                             | When the session has a task that is not already finished |
| **Details**   | Session identifiers and the infrastructure it ran on                                                                                                               | Always                                                   |

![The session tool rail in icons-and-labels mode, listing Files, Git, Timeline, Resources, Events and Comments, then Retry and Fork after a divider, with Report, Complete and Details pinned at the bottom.](/images/docs/session-tool-rail.png)

**Files** and **Git** need a linked workspace and a live session, so they disappear once the
session sleeps or stops. Everything else stays, which matters: inspecting resources, reading the
timeline, or reporting a problem is usually something you want to do _after_ a session has ended.

The rail is grouped by what each tool acts on: the workspace and its history at the top, the task
behind the session in the middle, and cross-cutting actions pinned to the bottom so they stay
reachable however long the top group grows.

### Changing How Much of the Rail You See

The chevron at the top of the rail cycles it through three modes:

1. **Icons** (the default) — a narrow strip of glyphs.
2. **Icons and labels** — wider, with each tool named. Worth switching on while you learn the rail.
3. **Hidden** — collapsed to a labelled **Tools** tab on the right edge; click the tab to bring it back.

Your choice is remembered in the browser, per device.

## File Browsing

While chatting with an agent, you can browse the workspace's file system directly from the chat panel — no need to switch to a terminal.

### How to Use

- Open **Files** in the [session tool rail](#the-session-tool-rail) to navigate the file tree and view files
- Open **Git** to see status and diffs for what the agent changed
- Click file references in tool-call cards to jump directly to that file (expand the
  tool activity card first — see [Tool Activity Cards](#tool-activity-cards))

### What You Can Do

| Action         | Description                                        |
| -------------- | -------------------------------------------------- |
| **Browse**     | Navigate directories and view the full file tree   |
| **View**       | Read any file with syntax highlighting             |
| **Diff**       | View git diffs for changed files                   |
| **Git status** | See which files are modified, staged, or untracked |

## File Upload and Download

You can attach files to your chat messages and download files from workspace containers.

### Uploading Files

Click the **paperclip** button in the chat input to attach files. Files are uploaded to the workspace container's `.private` directory.

**Limits:**

- Maximum per-file size: 50 MB (configurable via `FILE_UPLOAD_MAX_BYTES`)
- Maximum batch size: 250 MB (configurable via `FILE_UPLOAD_BATCH_MAX_BYTES`)
- Filenames must not contain shell metacharacters

### Downloading Files

Click the **download** button on files shown in the file browser panel to download them from the workspace container.

## Image Viewer

When browsing files, images are rendered inline with a dedicated viewer:

- **Small images** (under 10 MB) load inline automatically
- **Medium images** (10–50 MB) show a click-to-load preview
- **Large images** (over 50 MB) offer a download link only
- Toggle between **fit-to-panel** and **1:1** zoom modes

Supported formats include PNG, JPG, GIF, SVG, WebP, and other common image types.

## Tool Activity Cards

A single agent turn often runs dozens of tools between two sentences of prose. To
keep the conversation readable, SAM folds a run of consecutive tool calls into one
compact **activity card** that simply states how many ran — for example
`7 tool calls`.

![A chat timeline: a user message, the agent's plan in prose, a single collapsed card reading "8 tool calls · 1 failed", then the agent's summary of what it found. The eight individual tool calls are hidden behind the one card.](/images/docs/chat-tool-activity-card.png)

- While the run is in progress the card shows a motion indicator plus the tool
  currently executing (`· running <its title>`) — or `· thinking…` while the agent reasons
  between calls, or `· working` when there is nothing more specific to name. When the
  run finishes the indicator settles, with no layout jump: a check mark if every call
  succeeded, a red ✗ if any of them failed.
- If any call failed, the card says so in text as well as colour — for example
  `7 tool calls · 2 failed`.
- A single tool call is folded too, into a `1 tool call` card.
- **Tap the card** to expand it into the individual tool-call cards, in order.
- **Tap an individual call** to load its output (diff, terminal output, or text).
  Output is fetched on demand, so a long run costs nothing until you ask for it.
- Expanded cards stay expanded while you scroll away and back.
- Thinking blocks that sit between tool calls are folded into the same card; they
  are not counted in the tool-call total.

Document cards are never hidden inside an activity card — a document the agent
chose to show you always renders on its own (see below).

Add `?tools=expanded` to a chat URL to open every activity card by default. That
is a debugging aid rather than a setting, and it is not remembered between visits.

## Document Cards

When an agent adds a file to the project library or surfaces an existing one, the
chat renders a rich **document card** in the timeline instead of a plain tool
row. Cards appear for three agent tools:

- `upload_to_library` — the agent saved a new document (e.g. a written
  explanation or report) to the library.
- `replace_library_file` — the agent updated an existing library document.
- `display_from_library` — the agent pointed at a document that already exists,
  optionally with a short caption explaining why it's relevant.

Each card shows a tiered inline preview based on the file type:

- **Images** render as an inline thumbnail.
- **Markdown** shows a clamped source preview with a fade.
- **PDFs and other types** show an icon with the file name and size.

Click a card to open the document full-screen. Because library files are stored
durably, document cards keep working after the workspace is gone — a card whose
file was later deleted degrades to a "no longer in the library" note rather than
breaking.

Cards render the same way regardless of which agent produced them. Some agents
send a follow-up tool update that omits the document details, which used to
collapse the card into a bare tool row; SAM now recovers the details from the
original tool call, so a document an agent shares always renders as a card.

## Voice Input

Click the microphone button to speak your message instead of typing. SAM transcribes your audio using OpenAI Whisper (via Cloudflare Workers AI).

**Limits:**

- Maximum audio file size: 10 MB

## Text-to-Speech Playback

Agent responses can be played back as audio. SAM uses Deepgram Aura 2 (via Workers AI) for natural-sounding speech synthesis.

- Audio is generated on-demand and cached in R2 for subsequent playback
- Configurable voice: `luna` by default (via `TTS_SPEAKER`)
- Maximum text length: 100,000 characters per synthesis
- Output format: MP3
- **Persistent player** — audio continues playing as you navigate between pages

### TTS Configuration

| Variable              | Default                  | Description                  |
| --------------------- | ------------------------ | ---------------------------- |
| `TTS_ENABLED`         | `true`                   | Enable/disable TTS           |
| `TTS_MODEL`           | `@cf/deepgram/aura-2-en` | Workers AI TTS model         |
| `TTS_SPEAKER`         | `luna`                   | Voice selection              |
| `TTS_ENCODING`        | `mp3`                    | Audio encoding format        |
| `TTS_MAX_TEXT_LENGTH` | `100000`                 | Max characters per synthesis |
| `TTS_TIMEOUT_MS`      | `60000`                  | Synthesis timeout            |

## Conversation Forking

You can branch off from a conversation to explore an alternative approach without losing the original thread. A fork copies the session's context into a new session — it is session-scoped, not anchored to a particular message.

Forking now applies to task-backed chat sessions broadly, including instant-container and conversation-style sessions. You do not need to know whether the original session started from an idea, a task, or a lightweight chat; if the session is forkable, SAM preserves the lineage and starts the new branch with the right context.

### How to Fork

1. Open the session you want to branch from
2. Click **Fork** in the [session tool rail](#the-session-tool-rail)
3. SAM generates an AI-powered context summary of the conversation so far
4. A new session starts with awareness of the previous conversation

### Context Summarization

When forking, SAM uses Workers AI to generate a concise summary of the conversation so far. This summary is injected as a system message in the new session.

For short conversations (5 or fewer messages), the messages are passed directly without AI summarization. For longer conversations, a model generates a focused summary.

| Variable                          | Default                         | Description                          |
| --------------------------------- | ------------------------------- | ------------------------------------ |
| `CONTEXT_SUMMARY_MODEL`           | `@cf/google/gemma-4-26b-a4b-it` | Model for context summarization      |
| `CONTEXT_SUMMARY_MAX_LENGTH`      | `4000`                          | Max summary length (characters)      |
| `CONTEXT_SUMMARY_TIMEOUT_MS`      | `10000`                         | Summarization timeout                |
| `CONTEXT_SUMMARY_MAX_MESSAGES`    | `50`                            | Max messages to include              |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5`                             | Skip AI for conversations this short |

### Fork Limits

- Maximum fork depth: 10 levels (configurable via `ACP_SESSION_MAX_FORK_DEPTH`)
- Each fork creates a new session with its own branch and workspace

## Full-Text Search

Each `chat_messages` row is a single streaming token, so no row holds a whole word. SAM therefore concatenates consecutive same-role tokens into logical messages and indexes those with FTS5 (`materializeSession()` in `apps/api/src/durable-objects/project-data/materialization.ts`).

Indexing is incremental: it runs every time a session sleeps and again when it stops, fails, or is cleaned up after going idle, and each pass covers only the messages written since the last one.

- **Everything indexed so far**: full-text search with stemming and phrase matching.
- **Messages written since a session was last indexed**: keyword-based fallback search. This
  rescues whole user messages; streaming agent output is split across too many rows for a keyword
  match, so agent text becomes searchable only once the next pass runs.
- **Sessions whose index was pruned for storage**: keyword fallback only, permanently. Under
  storage pressure SAM deletes the grouped rows and index entries for terminal sessions older than
  a week to reclaim space, and deliberately never re-indexes them — re-indexing would undo the
  reclaimed bytes. In practice those old sessions are hard to find by search.

Search work is bounded by configured windows rather than by how much history the project holds
(`searchMessagesWithCoverage()` in `apps/api/src/durable-objects/project-data/message-search.ts`).
Full-text ranking scores and reads only the newest `PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT` matches
(2,000 by default), and the keyword fallback scans the newest
`PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT` raw messages (50,000 by default). The index still counts
a term's matches once per search, which takes tens of milliseconds even for hundreds of thousands of
matches. Small projects never reach either limit. In very large projects, a search that reached one
says so: the `rootSearch` field flags it and `coverageNotes` explains what was not searched, so an
empty result then does not prove the text is absent.

Agents search messages with the `search_messages` MCP tool. The project chat's own "Search chats"
box is a different thing: it filters the session list by topic, session ID, and creator, and does
not look inside messages.

## Session Lifecycle

Agent conversations and task sessions stay active until they complete, fail, or are explicitly stopped.

An idle timer is a resource-cleanup signal, not evidence that an agent succeeded. Before an idle
cleanup can stop a workspace or terminalize its task, SAM checks the task's runtime lifecycle. A
live runtime is preserved. Sleeping, waking, recovering, restoring, timed-out probes, probe errors,
and unknown runtime state are also preserved because they are inconclusive. Only a conclusively
dead runtime can be terminalized by the sweep, and that transition is recorded as `failed` with
diagnostic context rather than `completed`.

SAM also collapses platform-injected setup messages in the chat timeline. Those messages contain project instructions, task context, and policy that the agent received before it started. They remain available for debugging, but they no longer dominate the visible conversation.

### Sleeping and recovering sessions

Persistent chat sessions can sleep and recover on both [Instant and VM-backed runtimes](/docs/guides/instant-sessions/):

- **Sleeping.** The session went idle or you manually chose **Sleep** for an awake idle conversation-mode session with a workspace. SAM writes a checkpoint, releases compute, and keeps the composer visible so sending a message wakes the same chat.
- **Recovery.** SAM is rebuilding the session's runtime and restoring its saved state. Wait for it to finish instead of resending.

You may also see a banner telling you a message was saved but its delivery was interrupted. **That one needs a decision from you** — SAM will not replay the message automatically, because replaying a prompt that already half-ran duplicates commits and pull requests. See [what to do when a session is interrupted](/docs/guides/instant-sessions/#what-to-do-when-a-session-is-interrupted).

## Starting a New Chat

When you open a new chat, SAM offers a few repo-aware **starter prompts** (for example, "What's in this repo?" or "Run the tests and fix any failures") so you can get moving without a blank page. Pick one or type your own.

To send on a desktop keyboard, press **Cmd+Enter** on Mac or **Ctrl+Enter** on Windows/Linux — plain **Enter** inserts a new line so you can write multi-line prompts. The composer shows the correct shortcut for your platform as a hint. On mobile, tap the send button; **Enter** always inserts a new line.

## Session Filters (Shared Projects)

In a project shared with teammates, everyone's chat sessions appear in the same session list. A filter near the session search lets you switch between **my sessions** and **all sessions** so you can focus on your own work or see everything happening in the project.

For the full team workflow — inviting people, approving access, roles, and shared resources — see [Collaboration & Shared Projects](/docs/guides/collaboration/).

## Focus Mode

On desktop, project chat has three layout levels you can cycle with the **F** key (or the toggle at the bottom of the sidebar):

- **Default** — full navigation and session sidebars.
- **Focus** — collapses the main navigation so you stay inside one project.
- **Zen** — collapses the session sidebar too, for maximum reading and prompt-writing space.

Reopen the sidebars whenever you need to switch projects, sessions, or settings.

## Command Palette

Press **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) to open the global command palette. This provides quick navigation across the app:

- Search and jump to projects
- Navigate to settings, dashboard, or other pages
- Access workspace actions
- Available on both desktop and mobile (via the workspace action menu)
