# Disable Codex apps and plugins by default in SAM sessions

## Problem

Codex sessions that SAM launches get Codex apps (ChatGPT connectors, the `codex_apps` MCP server) and
plugins (the OpenAI-curated plugins and the remote plugin catalog) without anyone asking for them.
Raphaël does not want that: it makes it unclear what lives where. SAM should turn them off by default
while still letting a user's own `~/.codex/config.toml` opt back in.

## Research Findings

- Pinned Codex CLI is `0.160.0` (`packages/vm-agent/internal/acp/codex_runtime_installer.sh`).
  `codex features list` on 0.160.0 shows `apps`, `plugins` and `remote_plugin` as stable and on by
  default (`recommended_plugins` is already off). Writing `[features] apps = false, plugins = false,
remote_plugin = false` to `$CODEX_HOME/config.toml` turns all three off. `--disable` and
  `-c features.x=false` also work for the bare CLI.
- SAM starts Codex through `@agentclientprotocol/codex-acp` 2.1.1. The adapter spawns
  `codex app-server` with no `-c` arguments, and `CODEX_CONFIG` is only applied per thread
  (`startAcpServer` → `codexProcessState.config`). App-server-level loading (plugin catalog, apps)
  reads the base `config.toml`, so the reliable injection point is the config file.
- SAM already writes a marked managed block into `~/.codex/config.toml`
  (`packages/vm-agent/internal/acp/codex_config.go`: `generateCodexMcpConfig`,
  `mergeManagedCodexMcpConfig`, `writeCodexConfigToContainer`, `writeCodexConfigLocally`). Both
  runtimes go through `SessionHost.writeCodexStartupConfig` (`session_host_startup.go`): VM sessions
  write into the devcontainer, Instant/cf-container sessions write locally. No other writer of the
  session's Codex `config.toml` exists (the API's guided `codex login` sandbox is login-only).
- A user config may already define `features` as a `[features]` header, as top-level dotted keys,
  as an inline table, or only through `[features.<x>]` sub-tables. A second `[features]` header is
  invalid TOML and would stop Codex from starting, so the merge must place SAM's keys according to
  the user's form, and fall back to writing nothing if the result would not parse.
- Existing tests for the merge live in `packages/vm-agent/internal/acp/gateway_test.go`.

## Implementation Checklist

- [x] Add managed feature defaults (`apps`, `plugins`, `remote_plugin` = false) to the Codex config merge
- [x] Respect user-set values for those keys (user's explicit value wins)
- [x] Handle each user form: none, `[features]` header, top-level dotted keys, sub-tables only, inline table (fallback)
- [x] Use separate markers so a later merge removes SAM's feature lines cleanly (idempotent rewrites)
- [x] Validate merged TOML; fall back to the no-features merge and log if invalid
- [x] Tests: each form, idempotence, user override wins, invalid-user-config fallback, through `writeCodexConfigLocally`
- [x] Verify locally against the real Codex 0.160.0 binary with `codex features list`
- [x] Docs: mention the default in the public Codex/agent docs
- [x] Staging: real Codex session's config.toml has the managed features block and Codex reports the features off

## Acceptance Criteria

- [x] A fresh SAM Codex session (VM and Instant) writes `apps = false`, `plugins = false`, `remote_plugin = false`
- [x] A user's own explicit value for any of those keys is preserved
- [x] User configs with an existing `[features]` table stay valid TOML and keep their other keys
- [x] Rewriting the config on restart does not duplicate the managed lines
- [x] Codex 0.160.0 reports the three features as disabled when reading the written config

## References

- `.claude/rules/61-guards-must-cover-every-runtime.md` (VM and Instant both covered)
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md` (user layer vs managed defaults)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`

## Implementation Notes

- Precedence: a value the user's own `config.toml` sets for `apps`, `plugins` or `remote_plugin`
  wins. SAM's keys sit between `# BEGIN/END SAM MANAGED FEATURES` markers, so every rewrite
  removes and re-plans them; they are never mistaken for user values.
- Placement by user form (`planCodexManagedFeatures`): none or sub-tables only → SAM's own
  `[features]` table after the managed MCP block; `[features]` header → keys directly under it;
  top-level dotted keys → dotted `features.x = false`; inline table → merged file fails to parse,
  so SAM leaves the defaults (logged).
- Discrimination (each reverted once, then restored): removing the plan reddens every fresh/legacy
  case and all four runtime cases; making SAM override user values reddens the override cases;
  disabling header insertion reddens the `[features]` cases; disabling dotted placement reddens the
  dotted case; removing the validation fallback reddens the inline case; not removing the feature
  markers reddens every idempotence check.
- Real binary: configs produced by `mergeManagedCodexMcpConfig` for fresh, user-table and dotted
  forms were read by Codex 0.160.0 `codex features list`: `apps`/`plugins`/`remote_plugin` false,
  and the user's `apps = true` and `code_mode = true` preserved.
- Review fix (go-specialist HIGH ×2): the merge scanned config.toml line by line, so a line
  inside a multi-line string or array could be taken for a table header. That misplaced the
  feature keys (new) and split a user's multi-line array with SAM's block, writing invalid TOML
  (pre-existing on `main`). `codexTOMLStatementStarts` (`codex_toml_statements.go`) now tracks
  multi-line strings and open arrays, and every scan (first table, top-level keys, `[features]`
  header, managed-key removal) uses it. A managed key with a multi-line value is removed whole.
  The merge also logs an error if its result is invalid while the user's file was valid.
  Forcing every line to count as a statement reddens exactly the three multi-line cases.

## Staging Evidence

- Deploy run 42401427249 (branch head a78548721) succeeded. Fresh node `01M6VNFTXA2MNF3NH9FEFRCPYN`
  reported `agent_version = a78548721a42…` (this branch's VM-agent release).
- VM runtime, profile "OpenAI Codex Chat" (Codex subscription credential), session
  `1724ccd7-ce30-4d8b-81ca-4bc9621ffe44`, driven through the project chat UI with Playwright:
  - `~/.codex/config.toml` contained the `# BEGIN SAM MANAGED FEATURES` block with `[features]`
    `apps = false`, `plugins = false`, `remote_plugin = false`.
  - `/opt/sam-codex-c2/current/bin/codex features list` on the VM: `apps false`, `plugins false`,
    `remote_plugin false`.
  - `~/.codex/plugins` does not exist. Agent reports no `codex_apps` tools and no plugin skills.
  - SAM MCP is still available (`mcp__sam_mcp__`, `SAM_MCP_TOKEN` set). The agent's first reply
    wrongly said it was missing; asked again, it found it through tool discovery. Local check with
    Codex 0.160.0 and a mock model: the tool list sent to the model (including `mcp__sam_mcp`) is
    identical with and without the three flags.
- Observation (not a regression): Codex appends `[projects."<workspace>"] trust_level = "trusted"`
  at the end of config.toml. SAM's last managed block is at the end of the file, so the table lands
  inside SAM's markers and is removed on the next rewrite, then re-added by Codex. Before this
  change the same happened inside the MCP block.
