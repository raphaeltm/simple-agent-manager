# Reliability A bounded live acceptance

Preparation only: no live run is claimed. Source PR #2355 stays at `3d45a2d1c981cc10be572b5b1d19ca9769a17edf`. This verification asset belongs on a separate ref. Coordinator alone grants the shared staging slot, pins the consolidated image/VM-agent SHA and runs release gates. Never deploy/provision from this document without that slot.

## Limits and setup

Run four sequential cells: VM/Claude Code, VM/Codex, Instant/Claude Code, Instant/Codex. One active fixture workspace at a time, normal configured pool; at most one fixture VM and zero VMs at rest. Allow one bounded startup attempt per cell; failed provisioning is evidence, not a reason to dispatch duplicates. Coordinator owns cleanup even if a runner exits. Set a 15-minute wall deadline per cell; stop and report rather than continuing retries. This is a maximum, not permission to keep an idle VM billed. Record duration and cleanup immediately. Repeated/expanded spend needs separate approval.

Use a disposable project/repository with an existing remote and no unrelated writers. Do not use the SAM release repository for intentional fixture commits. Select existing authorized profiles from `GET /api/projects/{projectId}/agent-profiles`, recording profile ID, runtime and agent type. Do not change profiles, credentials or pool policy for the test. Verify effective project → user → installation compute credentials if a user has no personal key. Use actual provider-backed Claude/Codex, no mock ACP agent.

Use Playwright `context.request` and the same browser context for API calls and UI evidence. Through `exec_with_secrets`, inject only `SAM_PLAYWRIGHT_PRIMARY_USER`; call `POST https://api.sammy.party/api/auth/token-login` with `{token: process.env.SAM_PLAYWRIGHT_PRIMARY_USER}`. Never write/print the value or storageState/cookies. The smoke token is for staging, never production or SAM_API_URL. Start the browser at `https://app.sammy.party`. Do not fake callback JWTs, route directly to an unauthenticated worker, or use an internal DO RPC as live proof.

## Launch and fixture prompt

For each cell, submit the actual task path:

```js
const response = await context.request.post(`${api}/api/projects/${projectId}/tasks/submit`, {
  data: { message: fixturePrompt, agentProfileId: selectedProfile.id, taskMode: 'task' }
});
if (!response.ok()) throw new Error(`submit failed ${response.status()}`);
const launch = await response.json(); // record safe task/session/workspace identities
```

Do not set VM sizing or node overrides; these force VM routing and invalidate Instant coverage. `submit-task.ts` routes an Instant profile through `submitInstantTask` and forwards taskMode. Verify the resulting task is task-mode and runtime/actual agent matches the cell, using task detail, workspace detail and session messages; a profile label alone is insufficient. Task GET: `/api/projects/{projectId}/tasks/{taskId}`. Workspace GET: `/api/workspaces/{workspaceId}`. Follow linked workspace/session IDs rather than assuming launch response fields. For VM record heartbeat timestamp and successful browser terminal access on the pinned agent version.

Fixture prompt (replace only probe source and matrix label):

> This is an authorized disposable reliability acceptance task. Read SAM instructions. Work only in the snapshot-supported repository root on the task output branch. Do not use /do, publish, push, open PRs, call complete_task, or create other tasks yet. Save the supplied git-probe.py unchanged in `.reliability-a-probe.py` at that root. Run `python3 .reliability-a-probe.py prepare --disposable-repository`. This is the sole authorized explicit local commit, only named test content. Never run git add -A. Do not change pre-existing workflow files, the staged fixture or other files after preparation. Print the prepared JSON once and return control. Do not background a process.

The probe preserves pre-existing staged entries and creates a local commit, staged plus unstaged tracked content, a staged new file, an untracked file, and workflow files. It refuses default branches and existing fixture directories. It never pushes. Baseline JSON stays inside the supported root and contains hashes/refs, no credentials. Save the printed baseline externally to the coordinator's evidence artifact; do not rely only on a file inside the sleeping runtime. Include the exact probe from this ref in the prompt; do not ask the agent to fetch arbitrary unpinned main.

## Turn end, explicit sleep and wake

1. Wait for the actual first prompt to end with no tools/background work in flight (session state `/api/projects/{projectId}/sessions/{sessionId}/state` plus messages/UI). Capture canonical UTC timestamps, workspace ID, actual runtime/harness, HEAD/index/status hashes and remote refs. Independently inspect the disposable repository's PR/MR list before/after using its authorized Git host API or `gh pr list --state all --head <fixture-branch> --json number,url,state,headRefName`. Do not count agent prose alone as proof.
2. Send a read-only follow-up via `POST /api/projects/{projectId}/sessions/{sessionId}/prompt` with `{content: 'Run python3 .reliability-a-probe.py check from repository root; report measured JSON only. Change no files, do not publish or complete.'}`. Require check exit zero and `pass:true`. After this turn again ends, externally recheck remote refs/PR inventory. A nonempty callback publication/error is a failure. A passed probe is not independently a live harness assertion; also retain actual session identity.
3. Call `POST /api/workspaces/{workspaceId}/sleep` with the authenticated browser session. A 409 busy/deferral is a reported observation; do not bypass safety by forced stop/delete. Confirm canonical sleeping state and completed snapshot generation, and runtime release. Record generation/checksum metadata and no remote-ref/PR changes. Never substitute `/stop` for sleep: stop destroys retained snapshot state.
4. Wake through the normal follow-up prompt route above (or send the same message using the real UI). Do not use workspace restart as a snapshot wake shortcut. Poll session/task details within the cell deadline, follow replacement workspace ID, and verify the same runtime/harness contract. Run the probe `check` from the restored supported root. Require baseline file, all content hashes, HEAD/branch/index, staged entries and remote refs to match. Capture browser screenshot of restored session and terminal plus timestamp/identity. Never claim sibling worktrees or /tmp survive.

## Explicit evidence and actual terminal completion (last)

Use a real test PR created explicitly before starting the cell, on a separate fixture evidence branch, if PR UI reporting is required. Record its fixed URL without creating a PR for the dirty test branch. In a follow-up ask the task agent to read its `complete_task` tool schema and call it with measured fixture commitSha and that real evidence PR URL, plus summary explaining the no-publication checks. Use accepted evidence keys only: commit SHA belongs in `evidence.verifications[].evidence` (with kind and description) or `evidence.notes`, and the PR URL in `evidence.prUrl`. There is no `evidence.commitSha` property; additional properties are rejected. Never simulate the callback with a user cookie.

Before calling complete_task, run probe check again. After the actual tool returns or runtime teardown starts, observe canonical task status/evidence via GET, notification/PR link via session UI, and terminal runtime cleanup/sleep. Independently recheck remote refs and PR inventory after the final prompt ends. Require no new commit/ref/PR on the dirty task branch. The pre-existing evidence PR must remain the same. The stored verification/notes containing the commit SHA and `prUrl` must survive any naturally arriving empty completion callback; capture task detail again after that callback's observed timestamp. If runtime cleanup prevents a subsequent callback from arriving, record that boundary as unobserved rather than forging one. Coordinator can record independent static trace separately. Do not wake/recomplete a terminal task just to manufacture the race.

Actual completion is last because it may release runtime resources; sleep/wake preservation has already been proven on the same live fixture. If a supported mode remaps complete_task to awaiting_followup, report conversation-mode behavior rather than claiming terminal task coverage; ensure task-mode submission for the required terminal test.

## Cleanup and evidence table

Use session UI/API to stop/delete only the recorded disposable workspace after evidence is safely stored. `DELETE /api/workspaces/{id}` may return 202 pending: confirm eventual termination rather than treating accepted as absence. Delete only a test-created node after confirming no unrelated workspace shares it; never remove configured-pool/shared nodes. Require zero remaining fixture resources and zero fixture VMs at rest before next cell. Preserve remote fixture branch/evidence PR until coordinator records final results; remote cleanup is separately explicit and must not erase failure evidence.

For each cell record: consolidated source/image/agent head, verification ref, profile/runtime/harness, task/session/workspace/node IDs, start/end UTC, heartbeat/terminal proof, initial and post-turn/wake/terminal HEAD/index/status/refs, PR inventory, snapshot generation, tool result, task evidence before/after callback, screenshot links, cleanup confirmations and outcome. Mark PASS only from measured live observations; mark unsupported/missing/timeout distinctly. A provider limit or stale runtime image is a failed/blocked cell, never a mock-backed PASS.

## Local validation scope

`git-probe.py` can be exercised in a temporary local Git repository to check its mechanics. Such a run is a local probe self-check only; it proves nothing about staging auth, provisioning, harnesses, snapshots, sleep/wake or actual complete_task. No live run was performed when preparing these assets.

Source contracts consulted: `schemas/tasks.ts:SubmitTaskSchema`, `services/submit-task.ts`, `routes/workspaces/lifecycle.ts` sleep handler, `apps/web/src/lib/api/sessions.ts:sendFollowUpPrompt`, `routes/mcp/task-tools.ts:handleCompleteTask`, and API-reference skill.
