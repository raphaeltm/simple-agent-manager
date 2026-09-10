# VM Agent Rollout Compatibility

When a change affects VM-agent behavior required for scheduling new work, the rollout must be version-aware. Liveness is not compatibility.

Required pattern:

1. Build vm-agent binaries with the deployment commit SHA as the agent version.
2. Build matching binaries reproducibly and upload them under immutable, commit-addressed release keys before deploying Worker code that requires that version. A same-commit retry must reuse byte-identical objects and fail on a digest mismatch. Normal deploys must not overwrite the legacy mutable VM-agent keys.
3. Generate `VM_AGENT_REQUIRED_VERSION` from the deployment commit SHA; do not hardcode rollout-specific SHAs or ask operators to maintain a manual required version.
4. If a deployment intentionally skips agent artifacts (`skip_agent`), leave the required version unset and use the retained unversioned legacy object. Use this only for Worker changes that remain compatible with the previously published VM agent.
5. VM-agent `/ready` and heartbeat callbacks must report the build identity additively so old agents remain protocol-compatible.
6. Every reusable VM placement path must reject nodes whose reported build differs from the required build: preferred nodes, warm nodes, capacity selectors, TaskRunner readiness/health checks, trial reuse, and manual workspace creation.
7. Busy incompatible managed VMs must keep active work and receive no new work. Cleanup may retire them only after active work drains.
8. Cloudflare Instant/cf-container sessions are not reusable VM-pool nodes; do not conflate their baked container image lifecycle with VM node scheduling.
9. Destructive rollout cleanup must protect the bounded pre-workspace placement race without letting task lifecycle pin hardware forever. A node referenced by `tasks.claimed_warm_node_id` is not idle only while its active task has a non-null `claimed_warm_node_at` inside the configurable workspace-idle window. `tasks.auto_provisioned_node_id` and task status alone are not node activity once no workspace is present.
10. Missing build metadata is the normal pre-heartbeat state for a freshly booting VM. Cleanup must preserve a configurable boot grace before retiring an unversioned, unclaimed node.
11. A state machine waiting on a claimed node must distinguish missing/deleted state from "still booting" and terminalize promptly without returning the gone node to a reusable pool.
12. Control-plane changes that stop callback storms MUST stand alone for already-deployed agents: terminal statuses and low-severity logging must be correct even if the old VM agent keeps retrying until it is replaced.
13. VM-agent callback loops MUST treat terminal control-plane statuses (`401`, `403`, `404`, `410`) as stop signals, or otherwise use exponential backoff with a hard retry/time budget. Unbounded retries after a terminal resource response are not rollout-compatible.
14. Cloud-init and generated install scripts must request the exact `VM_AGENT_REQUIRED_VERSION` release when it is configured. Unversioned downloads are reserved for legacy/local/manual installs and intentional `skip_agent` deployments.
15. Established deployments must publish Worker revisions in an order that leaves an Instant recovery attempt after the final code update. First-install bootstrap revisions may run only when no prior Worker exists.

Tests for scheduling-affecting VM-agent changes should include a stale-but-otherwise-better candidate losing to a compatible node, preferred/warm stale-node rejection, current fresh-node readiness, active stale-node preservation, idle stale-node retirement, and the pre-heartbeat interleaving where a recent bounded warm-node claim exists before any workspace row.

Tests for callback-storm fixes should include old-agent-compatible control-plane assertions for terminal status/severity, plus new-agent assertions that heartbeat, ACP heartbeat, and message-outbox callbacks terminate or exhaust a bounded retry budget after terminal responses.

Deployment tests should assert deterministic same-SHA builds, digest-checked reuse without immutable-key overwrites, immutable R2 key construction from the verified deployment SHA, required-version propagation into the download URL, first-install-only bootstrap deployment, and final code publication after the single bulk secret revision.
