# Google Antigravity ACP Agent (Gemini Models, API Key Auth)

## Problem

Raphaël wants SAM to run Google Antigravity as a coding agent. Gemini CLI is SAM's only Google
harness today. First step: Antigravity with Gemini models only, authenticated with a Gemini
API key. The Claude and GPT models need Google to recognise SAM's ACP client name
(pingdotgg/t3code#31158 shows the allowlist), so they are out of scope here.

Scope for this session: draft PR with green CI. Staging verification waits until Raphaël
connects a Gemini API key on staging. Do not merge.

## Research Findings

Probed the real `agy-acp-server` 1.4.5 Linux x86_64 release locally (`.tmp/agy/probe.py`):

- Distribution: ACP registry entry `antigravity-acp` 1.4.5. Zip archive from `dl.google.com`
  (321 MB, sha256 pinned by the registry), extracting `agy_acp_server.par` (826 MB) and
  `localharness_external` (134 MB). Launch: `./agy_acp_server.par --uid=` on Linux.
- `initialize` takes ~2.5 s and advertises auth methods `oauth-personal`, `oauth-business`,
  `gemini-api-key`, `agent-platform`. `session/new` without auth fails with -32000
  "Authentication required".
- `authenticate {methodId: "gemini-api-key"}` with `GEMINI_API_KEY` in the environment succeeds
  and persists `$GEMINI_HOME/antigravity-acp/settings.json`. No file writing is needed by SAM.
- `session/new` returns a `model` select config option (category `model`) with values
  `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`,
  `gemini-3.1-pro`. SAM's generic `applySessionModelConfigOption` path selects models.
- 1.4.5 writes `skills/system/run-workflow/SKILL.md` into the session cwd (the user's repo)
  on `session/new`, unless the request carries
  `_meta: {antigravity: {disabledTools: ["run_workflow"]}}`. Verified both ways.
- A prompt with an invalid key reaches Google and returns "API key not valid" as an agent
  message with `end_turn`.
- The harness is found next to the real `.par` path; through a symlink it is not found
  (error asks for `ANTIGRAVITY_HARNESS_PATH`). Install a launcher script that exports
  `ANTIGRAVITY_HARNESS_PATH` and execs the real file.
- On Linux the launch does not unpack ~1 GB to TMPDIR (t3code's comment); it writes small glog
  files only.
- t3code (`AntigravityAcpSupport.ts`) advertises `fs.writeTextFile: false` because client
  writes swap Antigravity's diff edits for whole-file `client_edit_file`, and only serves reads
  for unqualified releases. 1.4.5 is qualified, so disable client fs for Antigravity.
- SAM integration points (from `google-gemini` / `amp` additions, commit 445773596):
  `packages/shared/src/agents.ts`, `harness-capabilities.ts`, `model-catalog.ts`,
  `agent-install-manifest.json`, `scripts/quality/check-agent-install-manifest.ts`,
  `packages/vm-agent/internal/acp/gateway.go`, `session_host_handshake.go`,
  web placeholders (`AgentSettingsCard.tsx`, `ProjectAgentCard.tsx`, `provider-meta.ts`),
  docs (`apps/www/src/content/docs/docs/guides/agents.md` and siblings).
- Instant (cf-container) runtime installs missing agents on demand
  (`installAgentBinaryLocal`), so Antigravity is not baked into the Instant image (it would add
  ~1 GB). The image lacks `unzip`; add it (small) so the on-demand install works.
- No D1 CHECK constraint on agent type; no migration needed.

## Implementation Checklist

- [x] Shared: add `google-antigravity` to `AGENT_TYPE_VALUES`, `AGENT_CATALOG`,
      `HARNESS_CAPABILITIES`, model catalog; tests
- [x] Install manifest entry (new `binary-archive` method) + quality check support
- [x] VM agent: `antigravity_install.sh` (pinned, sha256-verified, launcher script), embedded
      in Go; `getAgentCommandInfo` case; extra env
- [x] VM agent: per-agent ACP auth method (`gemini-api-key`) called after initialize when
      advertised
- [x] VM agent: per-agent session `_meta` disabling `run_workflow` on new and load
- [x] VM agent: per-agent client fs capability (disabled for Antigravity)
- [x] VM agent tests for each of the above
- [x] Instant image: add `unzip`
- [x] Web: model placeholders and provider meta
- [x] Docs: agents guide and other agent lists
- [x] Quality: lint, typecheck, test, build, Go tests, manifest check
- [x] Map SAM permission modes to Antigravity session modes (found during docs work: without
      it Antigravity stays in `default` and asks before every tool call); send every mode
      explicitly so a loaded session cannot keep `yolo`
- [x] Snapshot: `.gemini/antigravity/bin` capture-only; `.config/antigravity` (plugin secret
      store) restore-rejecting
- [x] Installer test that runs the real script (digest, arch, musl, replace, cleanup)
- [x] Playwright: Antigravity connect step at 375px and 1280px
- [x] Marketing surfaces (`integrations/index.astro`, `Comparison.astro`, `Roadmap.astro`,
      `reference/roadmap.md`, `guides/idea-execution.md`, plus an integrations entry in
      `apps/www/src/data/integrations.ts`): added after staging showed real replies

## Acceptance Criteria

- [x] `google-antigravity` can be selected and configured with a Gemini API key and a model
- [x] The VM agent installs Antigravity, verifies the archive digest, launches it, authenticates
      with `gemini-api-key`, and opens a session without writing into the repo
- [x] Draft PR with green CI (#2542)
- [x] (After Raphaël connects a key) staging: a real prompt answered by Antigravity

## Verification Notes

- Real binary probes (`.tmp/agy/probe.py`): auth requirement, `gemini-api-key` authenticate,
  `run_workflow` suppression, `session/set_mode yolo` accepted, invalid key reaches Google.
- Installer run for real against `dl.google.com` into a scratch `SAM_AGENT_HOME`: digest OK,
  ~10 s, launcher validated, full prompt through the launcher reached Google.
- Every guard was reverted once and the intended test went red: authenticate, session `_meta`,
  fs capabilities, mode mapping (bypass/accept and plan/default), snapshot exclusion, installer
  cleanup glob, manifest digest and `unzip` checks.

## Staging (2026-11-05, run 42043721627)

- Verified with a deliberately invalid Gemini key: UI connect (201), profiles on VM and Instant,
  fresh VM node heartbeat, install, launch, `gemini-api-key` auth, session, and the prompt
  reached Google ("API key not valid") on both runtimes; no `skills/` in the repo; Instant
  sleep and wake re-authenticated and answered again. Test key and nodes deleted; profiles
  "Antigravity VM/Instant (PR 2542 test)" kept in `hono`.
- Remaining: one real reply with a valid key (staging has no Google key).

## References

- pingdotgg/t3code#31158, t3code `apps/server/src/provider/acp/AntigravityAcpSupport.ts`
- agentclientprotocol/registry `antigravity-acp/agent.json`
- `tasks/archive/2026-05-19-gemini-cli-agent-integration.md`

## Staging queue (2026-11-05 18:4x UTC)

- I am next after live-steering (task 01M6MHNBM96JSAMJ0GNTPM2AYP); wait for its release message.
- After my staging run, send "staging released" to the account-map task 01M6P9ZR711CNEDH6TVBG64D06
  (send_durable_message). It is queued behind me.
- 19:47 UTC: deployed c8bf0342e to staging (run 42097177329, success). At about 20:32 I released staging to
  account-map without the real-key check, because it was waiting on the human. Queue is now
  account-map, then reliable-shutdown (01M6NAWT7RTBEQHXJTVMMX1W97, about 45 minutes), then me.
  Reliable-shutdown will message me when it releases staging. Then I redeploy, ask for the key and run the real chats.

## Staging with a real key (2026-11-05, run 42122233465, 17b695655)

- Key saved under Google Antigravity by Raphaël (22:23 UTC).
- `gemini-3.8-flash`: two turns on a VM each returned Google's "This model is currently
  experiencing high demand" after about 10 minutes (Google-side capacity; key accepted).
- `gemini-3.5-flash`: real replies on VM (task 01M6Q12XD78BRW0YA37H6MGX6Y) and Instant
  (task 01M6Q133PST4ZG46TNPNR7882H); both also called the sam-mcp tools.
- Live steering: Antigravity 1.4.5 does not advertise `_session/steering`. A mid-turn steer is
  recorded `queued_fallback` / `adapter_does_not_advertise_steering` and delivered as the next
  turn: the agent finished `sleep 45` ("DONE"), then answered the steer ("MANGO"). No loss.
- Test workspaces and nodes deleted; test profiles now use `gemini-3.5-flash`.
