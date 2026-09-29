---
title: Chat Features
description: The session tool rail, file browsing, tool activity cards, diagrams, conversation forking, finding past conversations, voice input, and text-to-speech in SAM's chat interface.
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

Click a card to open the document full-screen. Markdown renders (with a toggle to see the
source), images open in the image viewer, PDFs open in your browser's own PDF viewer, and every
file has a **Download** button. Because library files are stored
durably, document cards keep working after the workspace is gone — a card whose
file was later deleted degrades to a "no longer in the library" note rather than
breaking.

Cards render the same way regardless of which agent produced them. Some agents
send a follow-up tool update that omits the document details, which used to
collapse the card into a bare tool row; SAM now recovers the details from the
original tool call, so a document an agent shares always renders as a card.

## Diagrams

Ask an agent to draw something — an architecture, a request flow, a state machine, a timeline — and
it can answer with a [Mermaid](https://mermaid.js.org/) diagram. A ` ```mermaid ` code block in a
chat message is drawn as a diagram once the message has finished streaming; while it streams you
see the source. You can write one in your own messages too.

![An agent's chat reply containing a rendered Mermaid flowchart: a checkout request goes from the browser to a rate limiter, which either answers 429 or passes it on to payments and then the ledger. The diagram sits under a Diagram header with copy, reset and expand buttons.](/images/docs/chat-mermaid-diagram.png)

In chat, each diagram has three icon buttons: copy its Mermaid source, reset the view, and expand,
which opens it full-screen. Drag to pan, and scroll or pinch to zoom. On a phone, a swipe that
starts on a diagram pans the diagram, so start the swipe above or below it to scroll the chat.

Markdown files show diagrams too, in the project library and the **Files** tab, as a plain picture
without those controls.

If a diagram has a syntax error you get a **Mermaid diagram error** card with the parser's message
instead; in chat it also has **Copy source** and **View source**. Ask the agent to fix the syntax.

Because agents write these diagrams, SAM draws them as static pictures: no scripts, no HTML, and
no links out of the diagram (the details are in
[Security](/docs/architecture/security/#agent-written-files-and-diagrams)). Two things follow for the diagrams
you ask for:

- **Labels are plain text.** Math (KaTeX), Venn diagram member lists, and the text icons in
  architecture diagrams need HTML labels, so their text does not appear.
- **A diagram's own settings are limited.** Its configuration — an `%%{init: …}%%` line or front
  matter — can still choose a theme, but it cannot switch HTML labels back on, add CSS, or change the
  font family.

## Voice Input

Click the microphone button to speak your message instead of typing. SAM transcribes your audio using OpenAI Whisper (via Cloudflare Workers AI).

**Limits:**

- Maximum audio file size: 10 MB
- 30 transcriptions per minute per user (`RATE_LIMIT_TRANSCRIBE`). Past that, the microphone
  briefly shows an error state (hover it on a desktop to read _"Too many requests. Please try again
  later."_) and that recording is not transcribed, so record it again after a short wait.

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
- Each fork starts a new chat; on a VM it gets its own branch and workspace
- **Fork** and **Retry** both ask SAM for a summary of the conversation, and together they allow 30
  summaries per hour per user (`RATE_LIMIT_SESSION_SUMMARIZE`), however short the conversation.
  - Past the limit, **Fork** shows _"Too many requests. Please try again later."_, and its
    "Forking from" banner stays on _Loading context..._ and the send button stays on a disabled
    **Sending...**, although nothing is being sent. Close the banner with its **✕** and fork again
    later.
  - **Retry** still opens the new chat, but without a summary of the previous one. Wait, or paste the
    context you need into your message yourself.

## Finding Past Conversations

Two different tools answer two different questions:

- **"Which chat was that?"** Type in the **Search chats** box above the session list. It matches
  chat titles, session IDs, and who started the chat, among the chats loaded in the list (the 100
  most recently active). It does not read messages, so for anything older, ask an agent.
- **"Where did we talk about…?"** Ask an agent in the project, for example: _"Search this
  project's chats for where we chose the retry limit, and tell me what we decided."_ Agents can
  search the text of every chat in the project — sleeping, stopped, and archived ones included.
  There is no message-search box in the app itself.

### Getting good results from agent search

- **Use a few distinctive words.** A search returns messages that contain _all_ of its words.
  Indexed chats match whole words, ignoring case, so `retry` does not find `retries` — ask for the
  forms you expect. Punctuation and quotation marks are ignored, so there is no exact-phrase search.
- **Leave out accents.** Accented letters in a search are dropped, but indexed chats are stored
  without accents, so `deploiement` finds "déploiement". Words in non-Latin scripts can't be
  searched yet.
- **The agent's latest replies may not be searchable yet.** SAM indexes a chat each time it goes to
  sleep, and again when it stops. Your own messages can be found straight away; the agent's replies
  become searchable at the next indexing pass. In a long chat that can take a few passes, because
  each pass indexes a bounded amount, oldest first.
- **Very old chats can be hard to find.** When a project runs short of storage, SAM removes the
  search index for chats that ended more than a week ago, and it never rebuilds it.
- **In a very large project, "nothing found" is not proof.** A search reads only the newest part of
  the project's history, then tells the agent what it did not cover; a search through archived
  history comes back in pages the agent works through until the search reports that it is complete.
  If an answer looks incomplete, ask the agent whether its search covered everything.

For how indexing, search windows, query limits, and archive paging work — the detail an agent or a
self-hoster tuning search needs — see
[Architecture → Message search](/docs/architecture/overview/#message-search).

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

- **Sleeping.** The session went idle or you manually chose **Sleep** for an awake idle conversation-mode session with a workspace. SAM writes a checkpoint, releases compute, and keeps the composer visible so sending a message wakes the same chat. A message sent in the first minutes after it slept waits (up to an hour) until the old workspace has finished shutting down, then wakes it, usually within a minute or two of the shutdown.
- **Recovery.** SAM is rebuilding the session's runtime and restoring its saved state. Wait for it to finish instead of resending.
- **Wake failed.** SAM could not safely wake the sleeping session or the queued wake prompt expired before delivery. The session is marked **Wake failed** in the list and a system message in the chat explains the reason, so the failure is visible instead of hidden in retry state. [Wake failed](/docs/guides/session-troubleshooting/#wake-failed) lists the reasons and what to do about each.
- **Failed tasks.** When a task fails while its workspace is still running, SAM snapshots the workspace and puts the conversation to sleep instead of deleting it. That covers a provider usage limit, an expired request for your input, and an agent that went quiet after a SAM check-in. If the agent is still working when the task fails, SAM waits for its turn to end first (up to 8 hours by default). The failure banner stays, and sending a message wakes the same chat with its files restored. If SAM could not save the workspace, or the snapshot is incomplete, the chat says so. An agent that crashed, timed out, or hung mid-turn has no session SAM can safely snapshot, so its uncommitted changes are lost and the chat says that too. **Archive** still deletes it right away. [When a task fails](/docs/guides/session-troubleshooting/#when-a-task-fails) shows how to tell which happened.

You may also see a banner telling you a message was saved but its delivery was interrupted. **That one needs a decision from you** — SAM will not replay the message automatically, because replaying a prompt that already half-ran duplicates commits and pull requests. See [Your prompt may or may not have run](/docs/guides/session-troubleshooting/#your-prompt-may-or-may-not-have-run).

## Starting a New Chat

When you open a new chat, SAM offers a few repo-aware **starter prompts** (for example, "What's in this repo?" or "Run the tests and fix any failures") so you can get moving without a blank page. Pick one or type your own.

To send on a desktop keyboard, press **Cmd+Enter** on Mac or **Ctrl+Enter** on Windows/Linux — plain **Enter** inserts a new line so you can write multi-line prompts. The composer shows the correct shortcut for your platform as a hint. On mobile, tap the send button; **Enter** always inserts a new line.

## Switching Between Chats

A chat you opened in the last 24 hours opens at once from a cache in your browser, then refreshes in the background. A thin bar at the top of the page shows while the refresh runs, and messages that arrived while you were away appear when it finishes. A chat that is not cached shows a loading indicator until its newest messages arrive. The previous chat never stays on screen while the next one loads.

Each chat opens on its newest messages. Scroll to the top, or select **Load earlier messages**, to load older history. Jumping to a timeline entry or a comment loads the history it needs first.

An unsent message in the composer stays with its chat when you switch to another chat in the project and back. Drafts are kept in memory only, never on disk, so a page reload discards them. The transcript cache belongs to your account, is only read after the sign-in check completes, and is deleted when you sign out. Its lifetime and size are configurable; see [query cache persistence](/docs/reference/configuration/#query-cache-persistence).

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
