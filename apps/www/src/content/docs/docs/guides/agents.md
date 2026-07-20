---
title: AI Agents
description: Configure and use AI coding agents in SAM — Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
---

SAM supports six AI coding agents. You connect the ones you want to use, then choose which to run for a given chat by selecting an **agent profile**.

## Supported Agents

### Claude Code

| Property          | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| **Provider**      | Anthropic                                                        |
| **API Key**       | `ANTHROPIC_API_KEY`                                              |
| **OAuth Support** | Yes (Claude Max/Pro subscriptions)                               |
| **Get a Key**     | [Anthropic Console](https://console.anthropic.com/settings/keys) |

Claude Code supports dual authentication: API keys (pay-per-use) and OAuth tokens (from Claude Max/Pro subscriptions via `claude setup-token`). Toggle between them in Settings.

### OpenAI Codex

| Property          | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| **Provider**      | OpenAI                                                  |
| **API Key**       | `OPENAI_API_KEY`                                        |
| **OAuth Support** | Yes (via `~/.codex/auth.json`)                          |
| **Get a Key**     | [OpenAI Platform](https://platform.openai.com/api-keys) |

### Gemini CLI

| Property      | Value                                                  |
| ------------- | ------------------------------------------------------ |
| **Provider**  | Google                                                 |
| **API Key**   | `GEMINI_API_KEY`                                       |
| **Get a Key** | [Google AI Studio](https://aistudio.google.com/apikey) |

### Mistral Vibe

| Property      | Value                                                  |
| ------------- | ------------------------------------------------------ |
| **Provider**  | Mistral                                                |
| **API Key**   | `MISTRAL_API_KEY`                                      |
| **Get a Key** | [Mistral Console](https://console.mistral.ai/api-keys) |

Mistral Vibe is installed via `uv` (Python package manager) and requires Python 3.12.

### OpenCode

| Property                         | Value                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Provider**                     | OpenCode (SST)                                                                                        |
| **Default Inference Provider**   | OpenCode Zen                                                                                          |
| **Advanced Inference Providers** | OpenCode Go, SAM Platform (Workers AI), Scaleway, Google Vertex, OpenAI-compatible, Anthropic, custom |
| **API Key**                      | `OPENCODE_API_KEY` for OpenCode Zen and OpenCode Go                                                   |
| **Get a Key**                    | [OpenCode auth](https://opencode.ai/auth)                                                             |

OpenCode defaults to OpenCode Zen. SAM loads the Zen and Go model dropdowns from Models.dev through its authenticated model-catalog API, with a static fallback if that upstream catalog is unavailable. Select OpenCode Go in agent settings to use Go-only models such as `opencode-go/glm-5.2`. Advanced configurations can use SAM Platform inference without a user API key, or another user-selected inference provider. If you explicitly select Scaleway and already have a Scaleway cloud provider credential configured, OpenCode can reuse that credential — no separate API key required.

### Amp

| Property          | Value                                        |
| ----------------- | -------------------------------------------- |
| **Provider**      | Sourcegraph                                  |
| **API Key**       | `AMP_API_KEY`                                |
| **OAuth Support** | No                                           |
| **Get a Key**     | [Amp settings](https://ampcode.com/settings) |

Amp requires an Amp API key and may require paid Amp credits.

## Connecting Agent Credentials

1. Go to **Settings → Connections** in the SAM web UI
2. Start the **Connect** flow for the agent you want to use
3. Provide your API key (or OAuth token). Your credentials are encrypted at rest.

You can connect multiple agents and switch between them per chat by choosing a different profile.

## AI Provider Modes

Each agent runs in one of three provider modes, which control where LLM traffic goes and who pays for it:

| Mode           | What it uses                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| **API key**    | Your own provider API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)      |
| **OAuth**      | A token from your provider subscription (for example Claude Max/Pro)         |
| **SAM**        | The platform's managed AI proxy, with billing and budget handled by SAM (opt-in) |

You pick the mode when you connect an agent. The **SAM** platform proxy is never selected automatically — you have to opt in.

## Agent Profiles

An **agent profile** bundles a connected agent, a model, and settings into a reusable configuration. Profiles are how you choose what runs: pick a profile from the chat input when you start a session, or attach one to a [trigger](/docs/guides/webhook-triggers/) for automated work. Create and manage profiles under a project's **Profiles** page.

When work starts, the agent is resolved in this order:

1. The profile you selected (or the trigger's profile)
2. The project's default profile
3. The platform default (`DEFAULT_TASK_AGENT_TYPE`, `opencode` in the checked-in Worker config)

## Workspace Profiles

When you start a chat you can also choose how much environment to bring:

- **Full** (default) — builds your project's `.devcontainer` so the agent can run your stack, tests, and services. Best when the work depends on your real environment.
- **Lightweight** — starts faster with a minimal environment. Best for quick questions, planning, and code exploration.

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
- **Interrupted**: Connection to the agent was lost

SAM now backs chat sessions with task records across more runtime paths. In practice, that means forking, archive/complete controls, lineage, and status reporting behave consistently whether the work started as an idea execution, a full task, or an instant chat.

### MCP Tools

Running agents have access to project-aware MCP tools:

| Tool                   | Description                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `dispatch_task`        | Spawn a follow-up idea for execution                                                                                 |
| `create_idea`          | Create a new idea                                                                                                    |
| `update_idea`          | Update an idea's title, content, priority, or status                                                                 |
| `list_ideas`           | View project ideas                                                                                                   |
| `get_idea`             | Read idea details                                                                                                    |
| `search_ideas`         | Search ideas by keyword                                                                                              |
| `link_idea`            | Link an idea to a chat session                                                                                       |
| `unlink_idea`          | Remove an idea-session link                                                                                          |
| `find_related_ideas`   | Find ideas related to a session                                                                                      |
| `list_linked_ideas`    | List ideas linked to a session                                                                                       |
| `list_sessions`        | View chat sessions                                                                                                   |
| `get_session_messages` | Read conversation history (consecutive streaming tokens are concatenated into logical messages)                      |
| `search_messages`      | Search messages by keyword — uses FTS5 full-text search for completed sessions; keyword matching for active sessions |
| `update_task_status`   | Report progress                                                                                                      |
| `complete_task`        | Mark current work as done, optionally with structured completion evidence                                            |
| `request_human_input`  | Ask for user decision (blocks until answered)                                                                        |
