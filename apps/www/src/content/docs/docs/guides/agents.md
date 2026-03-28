---
title: AI Agents
description: Configure and use AI coding agents in SAM — Claude Code, OpenAI Codex, Google Gemini, and Mistral Vibe.
---

SAM supports four AI coding agents. Each runs inside a workspace container and communicates via the **Agent Communication Protocol (ACP)**.

## Supported Agents

### Claude Code

| Property | Value |
|----------|-------|
| **Provider** | Anthropic |
| **API Key** | `ANTHROPIC_API_KEY` |
| **OAuth Support** | Yes (Claude Max/Pro subscriptions) |
| **Get a Key** | [Anthropic Console](https://console.anthropic.com/settings/keys) |

Claude Code supports dual authentication: API keys (pay-per-use) and OAuth tokens (from Claude Max/Pro subscriptions via `claude setup-token`). Toggle between them in Settings.

### OpenAI Codex

| Property | Value |
|----------|-------|
| **Provider** | OpenAI |
| **API Key** | `OPENAI_API_KEY` |
| **OAuth Support** | Yes (via `~/.codex/auth.json`) |
| **Get a Key** | [OpenAI Platform](https://platform.openai.com/api-keys) |

### Google Gemini

| Property | Value |
|----------|-------|
| **Provider** | Google |
| **API Key** | `GEMINI_API_KEY` |
| **Get a Key** | [Google AI Studio](https://aistudio.google.com/apikey) |

### Mistral Vibe

| Property | Value |
|----------|-------|
| **Provider** | Mistral |
| **API Key** | `MISTRAL_API_KEY` |
| **Get a Key** | [Mistral Console](https://console.mistral.ai/api-keys) |

Mistral Vibe is installed via `uv` (Python package manager) and requires Python 3.12.

## Configuring Agent Credentials

1. Go to **Settings** in the SAM web UI
2. Navigate to the **Credentials** section
3. Add your API key for each agent you want to use
4. Keys are encrypted at rest using AES-256-GCM

You can configure credentials for multiple agents simultaneously and switch between them per project.

## Project Default Agent

Each project can set a **default agent type** that's used when executing ideas. If no default is set, you'll need to specify the agent when starting execution.

To set the default:
1. Open the project settings
2. Select your preferred agent from the dropdown
3. Save changes

The agent selection follows this precedence:
1. Explicit override on execution
2. Project default agent
3. Platform default (`claude-code`)

## Workspace Profiles

When running an agent, you can choose between two workspace profiles:

### Full Profile (Default)

- Builds the complete devcontainer from your project's `.devcontainer` configuration
- Includes all custom build steps, extensions, and dependencies
- Startup time: 2-3 minutes depending on build complexity

### Lightweight Profile

- Skips the devcontainer build entirely
- Uses a minimal base image with core tools pre-installed
- Startup time: 30-120 seconds faster than full profile
- Best for quick conversations that don't need custom environments

## Agent Session Features

### Real-Time Streaming

Agent output streams to your browser in real-time via WebSocket. You see code being written, commands being executed, and decisions being made as they happen.

### Conversation Forking

You can fork a conversation from any message to explore an alternative approach:

1. Hover over a message in the chat
2. Click the **Fork** button
3. SAM generates an AI context summary of the conversation up to that point
4. A new session starts with the context and awareness of the previous conversation

Fork depth is limited to 10 levels (configurable via `ACP_SESSION_MAX_FORK_DEPTH`).

### Voice Input

Speak your message or follow-up prompts using the microphone button. SAM transcribes audio using Whisper (via Workers AI) and submits the text.

### Text-to-Speech Playback

Agent responses can be played back as audio using Deepgram Aura 2 (via Workers AI). TTS audio is cached in R2 for subsequent playback.

### Session Lifecycle

Each agent session follows this state machine:

```
pending → assigned → running → completed/failed/interrupted
```

- **Pending**: Session created, waiting for workspace assignment
- **Assigned**: Workspace ready, agent starting up
- **Running**: Agent actively executing
- **Completed**: Agent finished successfully
- **Failed**: Agent encountered an error
- **Interrupted**: VM heartbeat lost (detected after 5 minutes of silence)

### MCP Tools

Running agents have access to project-aware MCP tools:

| Tool | Description |
|------|-------------|
| `dispatch_task` | Spawn a follow-up idea for execution |
| `create_idea` | Create a new idea |
| `update_idea` | Update an idea's title, content, priority, or status |
| `list_ideas` | View project ideas |
| `get_idea` | Read idea details |
| `search_ideas` | Search ideas by keyword |
| `link_idea` | Link an idea to a chat session |
| `unlink_idea` | Remove an idea-session link |
| `find_related_ideas` | Find ideas related to a session |
| `list_linked_ideas` | List ideas linked to a session |
| `list_sessions` | View chat sessions |
| `get_session_messages` | Read conversation history (consecutive streaming tokens are concatenated into logical messages) |
| `search_messages` | Search messages by keyword — uses FTS5 full-text search for completed sessions; keyword matching for active sessions |
| `update_task_status` | Report progress |
| `complete_task` | Mark current work as done |
| `request_human_input` | Ask for user decision (blocks until answered) |
