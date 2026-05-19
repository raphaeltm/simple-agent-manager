export function helpText(): string {
  return `SAM CLI

Usage:
  sam auth login --api-url <url> --session-cookie <cookie>
  sam auth login --api-url <url> --session-cookie-stdin
  sam auth status
  sam task submit <projectId> <message> [--mode task|conversation]
  sam task status <projectId> <taskId>
  sam chat <projectId> <message>
  sam chat <projectId> <message> --session <sessionId>

Global options:
  --json                    Print machine-readable JSON where supported
  -h, --help                Show help

Environment overrides:
  SAM_API_URL               API origin, for example https://api.example.com
  SAM_SESSION_COOKIE        BetterAuth session cookie header value
  SAM_CONFIG_DIR            Directory for config.json

Task submit options:
  --agent-profile <id>      Agent profile ID
  --agent-type <type>       Agent runtime type
  --context-summary <text>  Parent context summary
  --devcontainer-config <name|null>
  --mode <task|conversation>
  --node <id>
  --parent-task <id>
  --provider <provider>
  --vm-location <location>
  --vm-size <small|medium|large>
  --workspace-profile <full|lightweight>`;
}
