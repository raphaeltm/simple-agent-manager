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

## Node-only independent observer (second refresh)

The Instant observer no longer depends on Python. `capsule(..., 'observe', ...)` now packages the new `prospective-observer.mjs` through the existing machine-generated gzip/base64 package, SHA-256 binding and <3800-byte line transport. VM `setup`/`check` still use the original Python script and original asset pins. Observe discovers an existing absolute executable at `/usr/local/bin/node`, `/usr/bin/node`, `/opt/node/bin/node`, or an absolute `command -v node` result; it installs nothing. Missing runtime emits the same typed `done.json` failure (`status:1`, empty `files`) through a constrained shell fallback. Package-decode/hash/import failures also produce that failure receipt, without error text or source output. New directory creation rejects symlink ancestors and existing run directories.

The Node observe-only entry point performs fixed read-only Git top-level lookup, full `git ls-remote --heads` against the exact repository, and `gh pr list --head <exact branch> --state all --limit 100`. It validates original baseline/expectation schemas, full branch-ref map, exact-branch PR inventory with OPEN/CLOSED/MERGED states, duplicate numbers, inventory truncation, URL binding and record/completion/current timestamps. It produces the existing `asset-hashes.json`, `observer.json`, and immutable `done.json` schema; original baseline/expectation bytes are retained. No Git staging/commit/push or PR mutation command exists in the observer. Existing host validators remain in place before transport and after download.

Native child execution uses detached process groups, bounded stdout/stderr, a fixed 15-second phase deadline and at most five seconds per child; it kills each entire child group and closes pipes on success, failure or timeout. This covers descendants that retain inherited pipes in the same process group; deliberately detached descendants are outside the process-group guarantee, as with the original Python approach.

Additional changed/new files:
- `prospective-observer.mjs` (new): standard-Node-only observe contract and native bounded child handling.
- `prospective-vm.mjs`: observe-only runtime/package selection, verified Node bootstrap and typed early-failure receipts.
- `test-prospective-observer.mjs` (new): six actual Node capsules/local Git cases: success, changed remote ref, changed formerly closed PR, corrupt transported package, missing gh, missing Node (simulated by hiding discovery candidates). Also schema/timing/inventory rejection and actual deadline/descendant-group cleanup.
- `test-prospective-vm.mjs`: copies new observer into its isolated module fixture; the independent observation now runs Node through its actual PTY shell.

Validation after this refresh:
- `node .../test-prospective-observer.mjs`: PASS, six actual local Node capsules; real local Git, stubbed remote Git/gh responses; zero live calls.
- `node .../test-prospective-vm.mjs`: PASS, 17 cases and seven real local PTY executions (including Node observer); zero live calls.
- `node .../test-prospective-controller.mjs`: PASS, 15 lifecycle cases and five typed-proof negatives; zero live calls.

No live Instant executable availability or publication outcome is asserted. This is the bounded verification transport needed to attempt that missing observation; it does not turn historical failures into passes.
