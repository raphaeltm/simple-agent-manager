# Reliability A verification refresh — offline only

Prepared 2026-10-16 for independent review. No live calls, credentials, product code, deployments or fixture lifecycle actions.

## Required fresh pin

Before invoking the controller or CF reader, set `SAM_PROSPECTIVE_ROOT` to the absolute durable attempt directory and write `release-pin.json` there. No pin file or historical production defaults are supplied by this refresh.

Exact JSON fields (no additional or missing fields):
- `apiSource`: deployed API source, 40 lowercase hex.
- `agentSource`: required/deployed agent source, 40 lowercase hex.
- `publishedBinarySha256`: independently verified published binary digest, 64 lowercase hex.
- `rawHostShaObserved`: exactly `false` (this tool does not hash the installed host binary).
- `capacityPoolRevision`: current configured pool revision, positive JS-safe integer.

Both `prospective-vm.mjs` and `prospective-proof.py` validate the pin. Python checks Worker required agent source and actual node version/pool, then emits matching provenance/pool grant. Terminal phase independently checks grant against the supplied pin. A supplied API source/binary digest is reference evidence, not a new independent CF publication lookup; release executor must bind these values to fresh actual deployment/publication evidence before use. Worker target remains `sam-api-staging` and original project/repository restrictions remain.

## Restore boundary

`generationMatches` remains a boolean diagnostic in retained restore projection; it is excluded from the authorization gate because idle snapshot capture may rotate the mutable generation. Gate still requires one row, same snapshot ID, restored status, exact recovery task/workspace, valid wake receipt and parsed restore timestamp after submitted wake. Controller additionally requires the recovered snapshot ID and timestamp before executing the unchanged original-baseline check of HEAD, index, files and remote refs/PR inventory. This is observable restore plus repository preservation evidence; it does not establish the exact consumed generation.

## Changed files

All under `.codex/tmp/a-verification/scripts/e2e/reliability-a/`:
- `prospective-vm.mjs`: exact release-pin validation/loading and grant version/provenance/pool checks.
- `prospective-proof.py`: same pin input, fresh expected version/pool, generation diagnostic separated from gate.
- `test-prospective-vm.mjs`: synthetic injected pin, malformed pin and wrong release/pool negatives.
- `test-prospective-proof.py`: pin injection/validation/missing-file failures, wrong version/pool and rotated-generation acceptance.
- `test-prospective-controller.mjs`: synthetic pin for actual-reader scenario; its real producer rejection now uses wrong restored workspace while also retaining rotated generation observation.

## Executed affected offline checks

- `python3 .../test-prospective-proof.py`: PASS, 5 unittest methods with mode/failure subcases.
- `node .../test-prospective-vm.mjs`: PASS, 17 cases, 7 real local PTY/Bash/Python/Git capsule executions; HTTP/socket/node provenance simulated.
- `node .../test-prospective-controller.mjs`: PASS, 15 lifecycle cases, 5 typed-proof negatives; browser/terminal/CF producers simulated, actual caller/ledger exercised.

All report zero live service calls. Existing test source-contract assertions still inspect historical e2c81c source; they are regression context, not evidence that current deployed source/schema was independently validated. No Claude/Codex live matrix result is implied. Machine-generated terminal capsule and asset hash pins remain unchanged. No Instant python availability assumption was added. Original-byte export before subsequent lifecycle stages remains unchanged.
