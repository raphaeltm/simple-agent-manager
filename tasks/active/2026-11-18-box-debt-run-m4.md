# BOX debt run after M4 (L17b, L13, 0232→0255, L19, smoke)

Task 01M7QB382PDGH42XEG3ZFFS6DE, dispatched by coordinator 01M7JMXS2JRW6QQMB1356ENPM3.
Verification only: no PR to main, no merge. No fix PR was needed.

## Scope

In-place upgrade (no rebuild) of the self-host test box (app.vmtest.sam2.party, GCP project
sam-vm-control-plane-test) to `sam/selfhost-pass-2` 942d2c0a4, then live proof of L17b, L13,
the 0232→0255 migration path, L19 on celld, and a free-model smoke task.

## Checklist

- [x] BOX CLAIMED on feature.selfhost-landing (seq 366, 12:56Z)
- [x] Temporary SSH key + firewall rule `sam-selfhost-allow-ssh-ffs6de` (removed at the end)
- [x] Pre-upgrade snapshot
- [x] In-place upgrade 5568c40c5 → 942d2c0a4 (`pnpm selfhost:upgrade`, EXIT=0, 13:00–13:04Z)
- [x] 3 migration path: PASS
- [x] 1 L17b reverse tunnel: PASS
- [x] 2 L13 no-gateway: PARTIAL (controls PASS; real metered calls BLOCKED, see below)
- [x] 4 L19 on celld: BLOCKED (gVisor not installed; sudo/apt forbidden for this task)
- [x] 5 free-model smoke: PASS
- [x] Cleanup
- [ ] Report: channel + idea note; BOX FREE

## Evidence

### Upgrade (in place, no rebuild)

- Box before: checkout 5568c40c5 (L17a validation), 7 containers up, health 200.
- `pnpm selfhost:upgrade --to 942d2c0a4…` 13:00:16Z: "1031 files, compose inputs changed, D1
  migrations included"; backup 10,178 objects, celld down 9.4 s; stack restarted; "upgraded to
  942d2c0a4…; healthy", EXIT=0. 7 containers up, `/health` 200.
- The deploy step's own output does not reach the upgrade's log file (only the upgrade's
  `[selfhost]` lines do). Minor; noted for L22.

### 3. Migration path: PASS

- Before: `d1_migrations` 274 rows; `0232_node_reverse_tunnel_leases.sql` id 253 (2026-11-15) and
  L17a's `0255_node_reverse_tunnel_leases.sql` id 274 (2026-11-17). 7 lease rows, all released,
  ports 20000–20006.
- The target's self-host 0255 file is byte-identical to the box's (sha256 b2200563…).
- After: 281 rows, no duplicate names. New: `0255_project_briefs` and 0256–0261 at 13:04:08–09Z.
  The self-host 0255 was not re-run. The 0232 ledger row stays while its file is gone from the
  projection (`.state/project/d1-migrations/workspaces-dev/` has both 0255 files, no 0232), and
  `celld d1 migrations apply` accepted that.
- Leases survived (7 released rows, same ports); table plus 4 indexes present.
- Fresh-box 0255 creation (`prepareCelldProject`) was not exercised: no rebuild was done.

### 1. L17b reverse tunnel: PASS

- `POST /api/nodes` (agent-test, medium) 13:05:14Z → node 01M7QC5VGDJNEY1YPKGW4H5E1G, GCP
  e2 VM in europe-west1-b.
- Lease row bbfe6755… written 13:05:15.690Z, port 20007, active, BEFORE the VM was requested
  (instance created 13:05:18Z).
- frps 13:06:13Z: client login for node-01m7qc5vgdjney1ypkgw4h5e1g, `tcp proxy listen port
  [20007]`, new proxy `01M7QC5VGDJNEY1YPKGW4H5E1G.sam-agent`; celld
  `node_reverse_tunnel.plugin_allowed` op NewProxy with the lease id.
- Heartbeat 13:07:12.546Z (agent faa3885e…), ready 13:08:38Z; logs
  `heartbeat.ip_backfill_skipped_tunnel_node`.
- Gateway route: `GET /api/nodes/:id/system-info` 200 in 1.49 s with the node's real CPU,
  memory and agent version (route.ts resolves the active lease to loopback port 20007).
- Agent access: free-model task 01M7QCCQWP7HC2F689QK069KDS pinned to the node, workspace
  01M7QCCTDJWBDY10316ZF8343G; assistant "pong" 13:09:43Z.
- Terminal: `POST /api/terminal/token` 200; `wss://ws-<id>.vmtest.sam2.party/terminal/ws`
  opened in 62 ms; command output `L17BTERM_388002a80c1f_node` (devcontainer). Caddy access log
  101 for `/terminal/ws`; celld `ws_proxy_route` for the node.
- Release: session stop 200 (workspaceDeleted), `DELETE /api/nodes/:id` 200 at 13:10:59Z; lease
  released 13:11:34.525Z with reason `runtime_terminated`; VM gone at GCP. frps then refused the
  dead node's NewWorkConn (`plugin_refused`, `node_not_live`).
- Sweep: the 13:05 and 13:10 ticks logged `cron.reverse_tunnel_lease_sweep released:0` with the
  live lease active (control). Because deletion already released the real lease, the backstop was
  proven with a labelled probe: an active lease row `boxdebt-ffs6de-sweep-probe` for a
  nonexistent node on port 29999 (13:12:14Z). The 13:15:00Z tick logged `released:1` and the row
  became `released / runtime_not_live`. The probe row stays as released history.

### 5. Free-model smoke: PASS

agent-test, OpenCode key, `opencode/deepseek-v4.1-flash-free`, conversation task, one prompt:
submit 13:09:00Z, "pong" 13:09:43Z (ACP prompt 16.3 s, stopReason end_turn). Session stopped.

### 2. L13 no-gateway: PARTIAL

Passed live:
- Box has no addressable gateway: budget reports `monthlyCostCap.available: true` (local
  metering branch), spend $0.
- Superadmin PATCH `aiProxy.perUserMonthlyCostCeilingUsd` = 1 → 200, revision 7, source
  database; ordinary user PATCH → 403 "Superadmin access required".
- `GET /api/usage/ai/budget` → `ceilingUsd 1, effectiveCapUsd 1`.
- User `PUT` cap 5 → 400 "monthlyCostCapUsd must be between 0.01 and 1".

Blocked (needs Raphaël): metered real calls and the over-ceiling refusal. Local metering only
prices platform-funded calls to catalog models (Anthropic, OpenAI, Workers AI). The box has no
platform AI credential; its only model key is the OpenCode key, which may be used only as the
test account's own agent credential (not metered). The AI proxy is also off by default on a
box (`aiProxy.directUpstreamEnabled` false) and takes only a workspace callback token.

Fault path:
- Renaming `admin_settings_revision` (13:15:37Z) broke only the admin view (503
  SETTINGS_UNAVAILABLE). Runtime reads use `platform_settings`, so budget GET/PUT kept enforcing
  the $1 ceiling: not a ceiling fault.
- Renaming `platform_settings` (13:17:22–13:18:43Z) made every authenticated route answer
  503 AUTH_UNAVAILABLE (budget GET/PUT/DELETE and `/api/projects`); `/health` stayed 200. This
  fails closed, but it is session verification failing first, not the budget route's own
  ceiling 503. Side effect: one `capacity_pool_continuation` sweep failed at 13:18:00Z (its
  query reads platform_settings); every tick after restore is clean.
- Both tables restored; schema identical apart from SQLite's identifier quoting on rename.
- Spending-store (AiTokenBudgetCounter DO) fault: no live injection point on celld without
  code; covered by L13's unit/real-SQLite tests only.

M4 item #16 (budget PUT 503 when no ceiling setting is readable): live, a platform_settings
outage fails session auth first, so operators see a whole-app retryable 503, never the
budget-specific one. The budget 503 is reachable only in a partial window (ceiling read times out
while auth succeeds). That matches main's fail-closed design. One UX gap: in that window a user
cannot lower or clear their own cap, although lowering only tightens spend. Recommendation:
accept as intended; optionally let a PUT that only lowers or clears the user's cap skip the
ceiling read. Not a defect.

Restored: ceiling reset (revision 8, no row); agent-test budget back to defaults (isCustom false).

### 4. L19 on celld: BLOCKED

gVisor (`runsc`) is not installed on sam-box (`docker info` runtimes: runc only) and guided login
was never enabled there (COMPOSE_PROFILES=tunnel,gce,mail-collector; no
docker-compose.guided-login.yml). The README path needs `sudo apt-get install runsc && sudo runsc
install && sudo systemctl restart docker`, which this task forbids. Switching the sandbox runtime
to runc would weaken the isolation the design depends on, so it was not done. Needs Raphaël's
approval to install gVisor on the box (or to bake it into the next rebuild).

## Cleanup

- Node 01M7QC5VGDJNEY1YPKGW4H5E1G deleted (VM gone at GCP; only sam-box remains); workspace
  deleted; 0 active nodes, workspaces and leases in D1.
- Ceiling setting reset; agent-test budget default; both sessions signed out (401 afterwards).
- Box: pre-upgrade backup (833 MB, plaintext secrets) deleted; scratch dir and log copy deleted.
- SSH key removed from instance metadata (sam-box has no ssh-keys); firewall rule deleted. The
  guest agent left an empty `boxdebt` OS account (no keys) from the first metadata key; removing
  it needs sudo.
- Local token, SSH key, cookie jars and admin-settings dumps deleted.
- Left on the box: the fixture project r17-a1-hosted with the smoke task's branch, one inbox item
  the smoke agent filed for agent-test, and the released probe lease row.

## Other observations

- On session stop the vm-agent logs an error-level `vm_agent_error` "snapshot control plane
  returned HTTP 410 … Workspace is stopping; callback resource is gone" from
  `session_snapshot.background_capture`: a teardown race reported as an error. Filed as
  `tasks/backlog/2026-11-18-snapshot-410-on-stop-error-noise.md`.
