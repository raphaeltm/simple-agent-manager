# WebSocket Contracts: ACP Gateway

## VM Agent ACP Endpoint

**URL**: `wss://{workspace-host}/agent/ws?token={jwt}`

### Authentication

Same as existing PTY WebSocket — JWT token in query parameter, validated against JWKS.

### Message Format

All messages are JSON text frames. Each frame contains one ACP JSON-RPC message (the same format as one NDJSON line from the agent's stdio).

### Client → VM Agent (forwarded to agent stdin)

#### Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "1",
    "clientInfo": {
      "name": "SAM Web Client",
      "version": "1.0.0"
    },
    "capabilities": {
      "terminal": true,
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      }
    }
  }
}
```

#### Start New Session

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/workspace"
  }
}
```

#### Send Prompt

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "session-abc123",
    "message": {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Read the README and summarize it"
        }
      ]
    }
  }
}
```

#### Respond to Permission Request

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/respond_to_permission",
  "params": {
    "requestId": "perm-xyz789",
    "response": "allow_once"
  }
}
```

#### Cancel Prompt (notification — no id)

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "session-abc123"
  }
}
```

#### Set Mode

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/set_mode",
  "params": {
    "sessionId": "session-abc123",
    "mode": "code"
  }
}
```

### VM Agent → Client (forwarded from agent stdout)

#### Initialize Result

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "1",
    "agentInfo": {
      "name": "Claude Code",
      "version": "1.0.0"
    },
    "capabilities": {
      "modes": ["ask", "code", "architect"],
      "terminal": true,
      "extensions": {}
    }
  }
}
```

#### Session Update — Agent Message Chunk

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-abc123",
    "update": {
      "kind": "agent_message_chunk",
      "delta": {
        "type": "text",
        "text": "Let me read the README file..."
      }
    }
  }
}
```

#### Session Update — Agent Thought Chunk

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-abc123",
    "update": {
      "kind": "agent_thought_chunk",
      "delta": {
        "type": "text",
        "text": "I should look at the README.md file first..."
      }
    }
  }
}
```

#### Session Update — Tool Call

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-abc123",
    "update": {
      "kind": "tool_call",
      "toolCallId": "tc-001",
      "name": "read_file",
      "input": {
        "path": "/workspace/README.md"
      }
    }
  }
}
```

#### Session Update — Tool Call Result

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session-abc123",
    "update": {
      "kind": "tool_call_update",
      "toolCallId": "tc-001",
      "status": "completed",
      "output": [
        {
          "type": "text",
          "text": "# Simple Agent Manager\n\nA serverless platform..."
        }
      ]
    }
  }
}
```

#### Permission Request (agent → client request)

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "session/request_permission",
  "params": {
    "requestId": "perm-xyz789",
    "toolName": "write_file",
    "description": "Edit /workspace/src/main.ts",
    "input": {
      "path": "/workspace/src/main.ts",
      "diff": "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,4 @@\n+import { logger } from './logger';\n import { app } from './app';\n"
    }
  }
}
```

#### Prompt Response (turn complete)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 1234,
      "outputTokens": 567
    }
  }
}
```

### VM Agent Control Messages

In addition to forwarding ACP messages, the VM Agent sends control messages for connection management:

#### Agent Status

```json
{
  "type": "agent_status",
  "status": "starting" | "ready" | "error" | "restarting",
  "agentType": "claude-code",
  "error": "optional error message"
}
```

#### Select Agent (client → VM Agent)

```json
{
  "type": "select_agent",
  "agentType": "claude-code"
}
```

The VM Agent responds by:
1. Stopping the current agent process (if any)
2. Fetching the API key from the control plane
3. Starting the new agent process
4. Forwarding the ACP `initialize` message

### Connection Lifecycle

1. Browser connects to `/agent/ws?token=JWT`
2. VM Agent validates JWT
3. Client sends `select_agent` to choose which agent to start
4. VM Agent spawns agent process, sends `agent_status: starting`
5. VM Agent sends `agent_status: ready` when process is running
6. Client sends ACP `initialize` → forwarded to agent stdin
7. Agent responds → forwarded to client
8. Normal ACP session proceeds (prompt/response cycles)
9. To switch agents: client sends new `select_agent` → VM Agent tears down current, starts new
10. On disconnect: VM Agent terminates agent process
