# First Claude Code session on every fresh node waits ~2 min for the ACP adapter install

## Problem

On a fresh VM the devcontainer has no `claude-agent-acp`, so `installAgentBinary`
(`packages/vm-agent/internal/acp/gateway.go`) runs an npm install of
`@agentclientprotocol/claude-agent-acp@0.102.0` plus Claude Code inside the container before
ACP can start. In T12 on the self-hosted box (e2-standard-2) this took 1 min 50 s
(12:13:44 -> 12:15:34Z), about 20% of the 9-minute send-to-reply time, and the chat shows
nothing during it. [I] Not self-host specific: any node without a cached devcontainer layer pays
it (the box runs with DEVCONTAINER_CACHE_ENABLED=false).

## Acceptance Criteria

- [ ] Measure the same step on staging/production nodes.
- [ ] Decide (human): bake the adapter into the node image or default devcontainer, install it
      during workspace provisioning in parallel with the clone, or show the step in the chat.
