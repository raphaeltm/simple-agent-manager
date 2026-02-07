# Data Model: Multi-Agent ACP

**Feature**: 007-multi-agent-acp
**Date**: 2026-02-06

## Entity Changes

### Credentials Table (Modified)

The existing `credentials` table stores encrypted cloud provider tokens. It is extended to also store encrypted agent API keys.

**New columns**:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `credential_type` | TEXT NOT NULL | `'cloud-provider'` | Discriminator: `'cloud-provider'` or `'agent-api-key'` |
| `agent_type` | TEXT | NULL | Agent identifier when `credential_type = 'agent-api-key'`. NULL for cloud provider credentials. |

**Existing columns** (unchanged):
- `id` TEXT PRIMARY KEY
- `user_id` TEXT NOT NULL (FK → users)
- `provider` TEXT NOT NULL (e.g., `'hetzner'` for cloud-provider, `'anthropic'` / `'openai'` / `'google'` for agent keys)
- `encrypted_token` TEXT NOT NULL (AES-256-GCM encrypted)
- `iv` TEXT NOT NULL (initialization vector)
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

**Unique constraint**: `(user_id, credential_type, agent_type)` — one credential per type per agent per user.

**Validation rules**:
- When `credential_type = 'cloud-provider'`: `agent_type` MUST be NULL
- When `credential_type = 'agent-api-key'`: `agent_type` MUST be one of the supported agent identifiers
- `provider` maps to the API key provider: `'anthropic'` for Claude Code, `'openai'` for Codex, `'google'` for Gemini

### Agent Definition (New — Configuration, not DB table)

Agent definitions live in code as a typed registry. They are not stored in the database.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier: `'claude-code'`, `'openai-codex'`, `'google-gemini'` |
| `name` | string | Display name: `'Claude Code'`, `'Codex'`, `'Gemini CLI'` |
| `description` | string | Short description for UI display |
| `provider` | string | API key provider: `'anthropic'`, `'openai'`, `'google'` |
| `envVarName` | string | Environment variable for API key: `'ANTHROPIC_API_KEY'`, `'OPENAI_API_KEY'`, `'GEMINI_API_KEY'` |
| `acpCommand` | string | Binary name: `'claude-code-acp'`, `'codex-acp'`, `'gemini'` |
| `acpArgs` | string[] | Args to enable ACP: `[]`, `[]`, `['--experimental-acp']` |
| `supportsAcp` | boolean | Whether the agent supports ACP protocol |
| `credentialHelpUrl` | string | Link to provider's API key management page |
| `initTimeoutMs` | number | ACP initialization timeout (configurable via env var) |
| `installCommand` | string | npm global install command |

### Agent Session (Runtime — not persisted)

Agent sessions exist only in memory on the VM Agent. They are not stored in the database.

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | ACP session identifier (assigned by agent) |
| `agentType` | string | Which agent is active |
| `state` | enum | `'initializing'`, `'ready'`, `'prompting'`, `'error'`, `'closed'` |
| `messages` | array | Conversation message history (in-memory, not persisted) |
| `activeToolCalls` | map | In-progress tool executions |
| `pendingPermissions` | map | Permission requests awaiting user response |
| `currentMode` | string | Active operating mode (if agent supports modes) |
| `tokenUsage` | object | Cumulative token usage for this session |

### Workspaces Table (Unchanged for MVP)

No schema changes to the workspaces table. Agent selection happens at runtime within a running workspace, not at creation time. The workspace provisions all agents.

> **Future consideration**: If analytics require tracking which agent was last used in a workspace, a `last_agent_type` column could be added later.

## State Machine: Agent Session Lifecycle

```
                    ┌─────────────┐
                    │             │
         ┌─────────┤  no_session  ├──────────┐
         │         │             │           │
         │         └─────────────┘           │
         │                                   │
    user selects                        workspace
      an agent                          closes
         │                                   │
         ▼                                   │
   ┌─────────────┐                          │
   │             │                          │
   │ initializing │──── ACP init fails ─────┤
   │             │     (→ PTY fallback)     │
   └──────┬──────┘                          │
          │                                  │
     ACP init OK                            │
     (initialize + session/new)             │
          │                                  │
          ▼                                  │
   ┌─────────────┐                          │
   │             │◄──── prompt complete      │
   │    ready    │                          │
   │             │──── user sends prompt     │
   └──────┬──────┘         │                │
          │                ▼                │
          │         ┌─────────────┐         │
          │         │             │         │
          │         │  prompting  │         │
          │         │             │         │
          │         └──────┬──────┘         │
          │                │                │
          │           completes or          │
          │           errors                │
          │                │                │
          │                ▼                │
          │         ┌─────────────┐         │
          │         │    error    │─────────┤
          │         └─────────────┘         │
          │                                  │
     user switches                          │
      agent                                 │
          │                                  │
          ▼                                  │
   ┌─────────────┐                          │
   │   closing   │──────────────────────────┘
   └─────────────┘
```

**Transitions**:
- `no_session` → `initializing`: User selects an agent from the selector
- `initializing` → `ready`: ACP `initialize` and `session/new` succeed
- `initializing` → `no_session`: ACP init fails (auto-fallback to PTY terminal)
- `ready` → `prompting`: User sends a prompt via `session/prompt`
- `prompting` → `ready`: Agent completes the turn (`PromptResponse`)
- `prompting` → `error`: Agent errors during turn
- `error` → `ready`: Retry succeeds
- `error` → `no_session`: Unrecoverable error (3 restart attempts failed)
- `ready` → `closing`: User switches to different agent
- `closing` → `no_session` → `initializing`: New agent selected

## API Credential Flow

### Storing Agent API Keys

```
User enters API key     API validates format     API encrypts key
in Settings UI     →    (provider-specific)  →   AES-256-GCM
                                                       │
                                                       ▼
                                                 D1: credentials table
                                                 (credential_type='agent-api-key',
                                                  agent_type='claude-code',
                                                  provider='anthropic')
```

### Injecting Agent API Keys at Runtime

```
User selects agent          Control plane             VM Agent
in workspace UI        →    fetches encrypted    →    decrypts key
                            key from D1               and injects as
                                                      env var in
                                                      docker exec
```

**Security constraints**:
- API keys are decrypted only at point of use (VM Agent, just-in-time)
- Keys are never logged, never returned to the browser in plaintext
- Keys are transmitted from control plane to VM Agent over HTTPS (bootstrap token or on-demand API call)
- Failed decryption attempts are logged for security monitoring

## Relationships

```
┌──────────┐     1:N      ┌──────────────┐
│  User    │─────────────►│  Credential  │
│          │              │              │
│          │              │ type: cloud  │
│          │              │   or agent   │
└──────────┘              └──────────────┘

┌──────────┐     1:N      ┌──────────────┐     1:1      ┌───────────────┐
│  User    │─────────────►│  Workspace   │─────────────►│ Agent Session │
│          │              │              │  (runtime)    │  (in-memory)  │
└──────────┘              │ all agents   │              └───────────────┘
                          │ pre-installed│
                          └──────────────┘

┌──────────────────┐
│ Agent Registry   │  (code config, not DB)
│                  │
│ claude-code      │
│ openai-codex     │
│ google-gemini    │
└──────────────────┘
```
