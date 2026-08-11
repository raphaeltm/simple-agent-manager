# VM Agent Rollout Compatibility

When a change affects VM-agent behavior required for scheduling new work, the rollout must be version-aware. Liveness is not compatibility.

Required pattern:

1. Build vm-agent binaries with the publishing deployment commit SHA as the agent version.
2. Upload the matching binaries/version metadata before deploying Worker code that requires that version.
3. Compute a deterministic build-input fingerprint over `packages/vm-agent/**` (including Go dependency/toolchain and Makefile inputs) plus `scripts/deploy/vm-agent-compatibility-version.txt`. Carry the last actually published `VM_AGENT_REQUIRED_VERSION` when the fingerprint is unchanged; advance it to the publishing deployment SHA only after changed binaries are uploaded.
4. Bump the explicit compatibility marker when a control-plane/agent protocol change requires a new exact build even if agent source is unchanged. Do not hardcode rollout-specific SHAs or ask operators to maintain either release metadata value manually.
5. If a deployment intentionally skips agent artifacts (`skip_agent`), preserve the prior exact requirement. Reject the deploy when there is no prior published release or when build inputs changed/cannot be proven compatible; never clear the requirement.
6. VM-agent `/ready` and heartbeat callbacks must report the build identity additively so old agents remain protocol-compatible.
7. Every reusable VM placement path must reject nodes whose reported build differs from the required build: preferred nodes, warm nodes, capacity selectors, TaskRunner readiness/health checks, trial reuse, and manual workspace creation.
8. Busy incompatible managed VMs must keep active work and receive no new work. Cleanup may retire them only after active work drains.
9. Cloudflare Instant/cf-container sessions are not reusable VM-pool nodes; do not conflate their baked container image lifecycle with VM node scheduling.
10. Destructive rollout cleanup must treat an active task's provisioning claim as active work even before a workspace row exists. A node referenced by `tasks.auto_provisioned_node_id` for a queued/delegated/in-progress task is not idle.
11. Missing build metadata is the normal pre-heartbeat state for a freshly booting VM. Cleanup must preserve a configurable boot grace before retiring an unversioned, unclaimed node.
12. A state machine waiting on a claimed node must distinguish missing/deleted state from "still booting" and terminalize promptly without returning the gone node to a reusable pool.
13. Persist the versioned, allowlisted placement explanation immediately after reusable selection, append typed provisioning/readiness failures, and copy the final record to the workspace. Trials must persist before workspace creation because they have no task row.
14. Placement APIs, MCP tools, logs, and UI may expose only the shared explanation contract. Never copy raw agent versions, raw metrics JSON, provider errors, credentials, prompts, repository data, environment values, or secrets into placement evidence.
15. Preserve a real node identifier only for the selected node. Persist every rejected or eligible-but-unselected candidate as a stable `candidate-N` alias so placement evidence cannot disclose another tenant's host identifiers.

Tests for scheduling-affecting VM-agent changes should include a stale-but-otherwise-better candidate losing to a compatible node, preferred/warm stale-node rejection, current fresh-node readiness, active stale-node preservation, idle stale-node retirement, and the pre-heartbeat interleaving where an active task owns an unversioned node before any workspace exists.
