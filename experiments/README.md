# experiments/ — Standalone Research Experiments

Self-contained, runnable experiments that inform product/engineering decisions
but are NOT part of the production build (no workspace package, not built or
tested in CI).

- `harness-eval/` — model/harness evaluation runner for the SAM-native agent
  harness (see `specs/031-sam-agent/`). Traces are written to
  `harness-eval/traces/` (gitignored except `.gitkeep`).
- `ai-gateway-tool-call/` — probe for tool-call behavior through Cloudflare
  AI Gateway / Workers AI.

Conventions:

- One directory per experiment, kebab-case, with its own entry point.
- Experiments may be deleted once their findings are recorded (in a spec,
  task record, or SAM knowledge). Do not import from `experiments/` in
  production code.
- Ephemeral outputs (traces, dumps) stay gitignored — use a gitignored
  subdirectory or `.tmp/`.
