---
title: Chat Features
description: File browsing, conversation forking, voice input, text-to-speech, and real-time streaming in SAM's chat interface.
---

SAM's project pages are chat-first interfaces where you interact with AI coding agents in real-time.

## Real-Time Streaming

Agent output streams directly to your browser via WebSocket. You see code being written, terminal commands executing, and the agent's thought process as it happens — no waiting for a complete response.

## File Browsing

While chatting with an agent, you can browse the workspace's file system directly from the chat panel — no need to switch to a terminal.

### How to Use

- Click **Files** in the session header to open the file browser panel
- Click **Git** to view git status and diffs
- Click on file references in tool call cards to jump directly to that file

### What You Can Do

| Action | Description |
|--------|-------------|
| **Browse** | Navigate directories and view the full file tree |
| **View** | Read any file with syntax highlighting |
| **Diff** | View git diffs for changed files |
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

## Voice Input

Click the microphone button to speak your message instead of typing. SAM transcribes your audio using OpenAI Whisper (via Cloudflare Workers AI).

**Limits:**
- Maximum audio file size: 10 MB
- Maximum recording duration: 60 seconds
- Rate limit: 30 transcriptions per minute

## Text-to-Speech Playback

Agent responses can be played back as audio. SAM uses Deepgram Aura 2 (via Workers AI) for natural-sounding speech synthesis.

- Audio is generated on-demand and cached in R2 for subsequent playback
- Configurable voice: `luna` by default (via `TTS_SPEAKER`)
- Maximum text length: 10,000 characters per synthesis
- Output format: MP3
- **Persistent player** — audio continues playing as you navigate between pages

### TTS Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_ENABLED` | `true` | Enable/disable TTS |
| `TTS_MODEL` | `@cf/deepgram/aura-2-en` | Workers AI TTS model |
| `TTS_SPEAKER` | `luna` | Voice selection |
| `TTS_ENCODING` | `mp3` | Audio encoding format |
| `TTS_MAX_TEXT_LENGTH` | `10000` | Max characters per synthesis |
| `TTS_TIMEOUT_MS` | `60000` | Synthesis timeout |

## Conversation Forking

You can branch off from any point in a conversation to explore an alternative approach without losing the original thread.

### How to Fork

1. Hover over a message in the chat history
2. Click the **Fork** button
3. SAM generates an AI-powered context summary of the conversation up to that point
4. A new session starts with awareness of the previous conversation

### Context Summarization

When forking, SAM uses Workers AI to generate a concise summary of the conversation so far. This summary is injected as a system message in the new session.

For short conversations (5 or fewer messages), the messages are passed directly without AI summarization. For longer conversations, a model generates a focused summary.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_SUMMARY_MODEL` | `@cf/google/gemma-3-12b-it` | Model for context summarization |
| `CONTEXT_SUMMARY_MAX_LENGTH` | `4000` | Max summary length (characters) |
| `CONTEXT_SUMMARY_TIMEOUT_MS` | `10000` | Summarization timeout |
| `CONTEXT_SUMMARY_MAX_MESSAGES` | `50` | Max messages to include |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5` | Skip AI for conversations this short |

### Fork Limits

- Maximum fork depth: 10 levels (configurable via `ACP_SESSION_MAX_FORK_DEPTH`)
- Each fork creates a new session with its own branch and workspace

## Full-Text Search

SAM indexes chat messages for full-text search. When a session ends, streaming tokens are grouped into logical messages and indexed using FTS5.

- **Completed sessions**: Full-text search with stemming and phrase matching
- **Active sessions**: Keyword-based fallback search

Agents can search messages using the `search_messages` MCP tool.

## Session Suspend and Resume

Agent sessions can be suspended and resumed:

- **Auto-suspend**: Idle sessions are suspended after 30 minutes of inactivity (configurable via `ACP_IDLE_SUSPEND_TIMEOUT`)
- **Manual resume**: Click on a suspended session tab to resume it
- Suspended sessions show with reduced opacity in the UI

## Command Palette

Press **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) to open the global command palette. This provides quick navigation across the app:

- Search and jump to projects
- Navigate to settings, dashboard, or other pages
- Access workspace actions
- Available on both desktop and mobile (via the workspace action menu)
