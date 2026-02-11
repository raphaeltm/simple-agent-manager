#!/usr/bin/env bash
set -euo pipefail

log_file="${ACP_LOG_FILE:-/tmp/mock-acp-input.log}"
session_id="${ACP_SESSION_ID:-session-e2e}"

touch "$log_file"

while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log_file"

  # Extract JSON-RPC id for responses (handles both numeric and string ids)
  rpc_id="$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
  rpc_id="${rpc_id:-1}"

  if [[ "$line" == *'"method":"initialize"'* ]]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"serverInfo":{"name":"mock-acp-agent","version":"0.0.1"},"agentCapabilities":{"supportedMediaTypes":[]}}}\n' "$rpc_id"

  elif [[ "$line" == *'"method":"session/new"'* ]]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"%s"}}\n' "$rpc_id" "$session_id"

  elif [[ "$line" == *'"method":"session/prompt"'* ]]; then
    prompt_text="$(printf '%s' "$line" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p')"
    prompt_text="${prompt_text:-empty}"
    escaped_text="$(printf '%s' "$prompt_text" | sed 's/\\/\\\\/g; s/"/\\"/g')"

    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"E2E:%s"}}}}\n' "$session_id" "$escaped_text"
  fi
done
