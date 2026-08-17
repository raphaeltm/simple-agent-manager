# Integrate four non-trivial Dependabot PRs into one verified integration PR

**Status**: active
**SAM task**: `01M079AYQTDVEP2WN7KJD0KABV`
**Branch**: `sam/bring-four-non-trivial-d0kabv`
**Merge authorization**: NONE. Raphaël explicitly withheld merge for this batch — the
blast radius is production agent sessions (ACP protocol + the Instant container base
image). Leave the PR open and green; he gives the go-ahead.

## Problem

Four Dependabot PRs were separated out from the trivial batch because each is genuinely
non-trivial. Merging them individually would either ship a half-done change (#1790, #1792
each leave a stale review comment; #1792 moves an image without its SDK) or ship red
(#1796 fails five checks). They interact through one `pnpm-lock.yaml`, so they need to be
integrated and verified as a unit.

| PR    | Bump                                       | Why non-trivial                                                                                     |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| #1801 | `@agentclientprotocol/sdk` 0.25.0 → 1.3.0  | Major across a v1 boundary on the protocol carrying every agent session                             |
| #1790 | `library/node` 22 → 26-bookworm-slim       | Two Node majors on the image backing cf-container/Instant sessions                                  |
| #1792 | `cloudflare/sandbox` image 0.12.1 → 0.12.5 | Image moved without its npm SDK, violating the Dockerfile's own stated invariant                    |
| #1796 | `@astrojs/starlight` 0.40.0 → 0.41.7       | Genuinely broken: fails Type Check, Test, Build, Workspace Quality Surfaces, Durable Object Workers |

## Research findings

### #1801 — the SDK is a dead dependency

An exhaustive sweep (`.ts .tsx .js .mjs .cjs .json .go .py .sh .astro .vue`, every config
file, tsconfig `paths`/`types` arrays, `declare module`, `/// <reference types>`, barrel
re-exports, every non-`node_modules` `package.json`, and `packages/vm-agent/go.mod`) found
**zero importers** of `@agentclientprotocol/sdk`. Every hit outside `pnpm-lock.yaml` is
either the dependency declaration itself or documentation.

- `packages/acp-client/src/transport/types.ts` declares only SAM's own VM-agent control
  messages (`agent_status`, `select_agent`, `agent_crash_report`, `session_state`).
- `packages/acp-client/src/transport/websocket.ts` imports only from `./types` and
  deliberately types the ACP payload as `unknown`.
- `packages/acp-client/src/hooks/useAcpMessagePayloads.ts` hand-rolls loose
  `SessionUpdate` / `ToolCallUpdate` / `PlanUpdate` shapes.
- The canonical ACP wire contract lives in the Go VM agent, which hand-rolls ACP and has
  no dependency on this npm package.

The dependency was added by spec-007 (`specs/007-multi-agent-acp/tasks.md` T002/T019/T020)
intending to use `ClientSideConnection` over a custom WebSocket transport. That intent was
never implemented — the transport was written against hand-rolled types instead.

Upstream history (github.com/agentclientprotocol/typescript-sdk releases + CHANGELOG):
the real API break was **0.27.0** (fluent `agent()`/`client()` rewrite; legacy
`ClientSideConnection`/`AgentSideConnection` deprecated but NOT removed), not 1.0.0, which
was a stabilization tag. In 1.3.0 `ClientSideConnection`, `Stream` and `ndJsonStream` all
still exist. ACP v2 in 1.3.0 is opt-in behind the `./experimental/v2` subpath, so nothing
changes on the wire unless that subpath is imported.

`packages/acp-client/AGENTS.md:42` asserted the SDK "defines the ACP wire protocol types".
That is false and actively misleading to future agents.

### #1790 — Node 26 is engine-compatible; the comment was left stale

Registry `engines.node` for every globally-installed CLI in
`apps/api/Dockerfile.vm-agent-container` (verified against `registry.npmjs.org`):

| Package                                        | `engines.node` |
| ---------------------------------------------- | -------------- |
| `@agentclientprotocol/claude-agent-acp@0.58.1` | `>=22`         |
| `@anthropic-ai/claude-code@2.1.207`            | `>=22.0.0`     |
| `@agentclientprotocol/codex-acp@1.1.2`         | _(absent)_     |
| `@openai/codex@0.144.6`                        | `>=16`         |
| `@google/gemini-cli@0.50.0`                    | `>=20`         |
| `opencode-ai@1.17.18`                          | _(absent)_     |
| `@ampcode/cli@0.0.1783785389-g0da70d`          | _(absent)_     |

**No upper bounds anywhere** → `npm install -g` cannot fail with `EBADENGINE`.

- Digest `sha256:cd5657…e6341` in the PR is byte-identical to Docker Hub's current
  `26-bookworm-slim`; the config blob reports `NODE_VERSION=26.7.0`. Bookworm has not been
  dropped for Node 26 (`26-trixie` exists alongside, not instead).
- Native-ABI risk (`NODE_MODULE_VERSION` 127 → 147): only `@google/gemini-cli` pulls
  native code, via optional `@lydell/node-pty-linux-x64@1.1.0`, whose prebuilt `pty.node`
  exports `napi_*` symbols — N-API is ABI-stable across majors.
- `container-entrypoints/patch-acp-amp.py` is pure Python string replacement against
  `site-packages` under uv-managed CPython 3.12; no Node coupling.
- `container-entrypoints/vm-agent-bootstrap.sh` is POSIX `sh` and never invokes node.
- Residual risk that metadata CANNOT rule out: Node 26 ships **undici 8** (major), so
  global `fetch` behaviour changes for seven HTTP-heavy CLIs, and new runtime
  deprecation warnings on stderr could in principle interleave with ACP stdio framing.
  Only a real agent turn on the real image proves this — hence the staging gate below.
- **LTS timing** (surfaced for Raphaël, not decided unilaterally): Node 26 is _Current_
  until 2026-10-28; Node 24 is Active LTS today; Node 22 is supported until 2027-04-30.
  Project policy says "prefer LTS". Switching to `24-bookworm-slim` is a one-line change
  if he prefers it at merge time.

### #1792 — the image moved without its SDK

`apps/api/Dockerfile.sandbox` states the invariant in its own comment: the reviewed source
tag "MUST match the `@cloudflare/sandbox` npm package version". Dependabot bumped only the
`FROM` digest, leaving `apps/api/package.json` at `^0.12.1` and the comment at `0.12.1`.
The container-server binary in the image and the npm client speak the same versioned HTTP
API (`getSandbox()`/`exec()`/`readFile()`), so drift is a runtime protocol mismatch that no
type check or unit test can observe.

### #1796 — Starlight needs Astro 7

`@astrojs/starlight@0.41.7` declares peer `astro@^7.0.2`; `apps/www` pinned `astro@6.4.8`.
The newer peer graph resolves `@astrojs/mdx@7.0.5`, which does
`import { chunkToString } from "astro/runtime/server/index.js"` — a symbol Astro 6 does not
export. Rollup fails the www build, and because Type Check / Test / Workspace Quality
Surfaces / Durable Object Workers all depend on `@simple-agent-manager/www#build` in turbo,
**one root cause produced all five red checks**.

`astro` is pinned in exactly one place (`apps/www/package.json`), so the migration is
contained to one app.

Second-order Astro 7 finding: its rolldown-based pipeline resolves dynamic imports inside
_processed_ `<script>` blocks. `src/layouts/BlogPost.astro` lazy-loads
`import('/scripts/blog-mermaid.js')`, which is an esbuild output emitted into `public/` by
the `build:blog-mermaid` step — a runtime URL, not a resolvable module.

### Process gap that let two of these ship half-done

`scripts/quality/dependency-governance.test.ts` asserted Docker **digest pinning** only. It
passed straight through both stale "reviewed source tag" comments, and had nothing at all
to say about image↔SDK version drift. Dependabot bumps the sandbox image and the sandbox
npm package as two independent PRs, so that invariant has to be asserted, not assumed.

## Implementation checklist

- [x] Branch from current `origin/main` (`6ab275923`)
- [x] Merge all four Dependabot heads with `--no-ff` so their head SHAs stay reachable
      (GitHub then auto-closes each PR as merged when the integration PR lands via a
      merge commit)
- [x] Repair the `pnpm-lock.yaml` text-merge: it produced a wrong `@types/node` resolution
      combo across the two npm PRs; `pnpm install` corrected it
- [x] #1801: remove `@agentclientprotocol/sdk` from `packages/acp-client/package.json`
- [x] #1801: rewrite the false SDK claim in `packages/acp-client/AGENTS.md`
- [x] #1790: fix the stale `# Reviewed source tag:` comment (22 → 26)
- [x] #1792: fix the stale reviewed-source-tag comment (0.12.1 → 0.12.5)
- [x] #1792: pin `@cloudflare/sandbox` to **exactly** `0.12.5` (was `^0.12.1`) so a range
      cannot let the client drift from the digest-pinned image on an unrelated install
- [x] #1796: upgrade `astro` 6.4.8 → 7.2.2
- [x] #1796: `is:inline` the mermaid lazy-loader in `apps/www/src/layouts/BlogPost.astro`
- [x] PROCESS FIX: add two governance tests — reviewed-source-tag comments must match
      their `FROM` tag, and `@cloudflare/sandbox` must be an exact pin equal to the image
      tag — and prove both discriminating by running them red against the exact pre-fix
      states
- [x] Full local suite: typecheck 19/19, lint 13/13, build 9/9, test 21/21
- [ ] Local specialist review
- [ ] Staging deployment + real end-to-end verification
- [ ] Integration PR open and green — **do not merge**

## Acceptance criteria

- [x] All four Dependabot head commits are reachable from the integration branch
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass locally
- [x] `pnpm quality:dependency-governance` passes, and its two new assertions are proven
      to fail on the pre-fix state
- [x] No Dockerfile carries a reviewed-source-tag comment that disagrees with its `FROM`
- [x] `@cloudflare/sandbox` npm version == `Dockerfile.sandbox` image tag
- [x] `apps/www` builds (181 pages + Pagefind index + sitemap)
- [ ] A real cf-container/Instant session completes a real agent chat turn on staging
      — the only evidence that proves the Node 26 image and the sandbox bump work
- [ ] A real ACP agent session completes prompt → response → tool call on staging
- [ ] Docs site pages render on staging
- [ ] Regression sweep: dashboard, projects, settings, no new console errors
- [ ] Every staging node/workspace created is deleted afterwards (Hetzner 10-server cap
      is shared with production)

## References

- `.claude/rules/02-quality-gates.md` — regression + process-fix requirements
- `.claude/rules/13-staging-verification.md` — staging is a hard merge gate
- `.claude/rules/30-never-ship-broken-features.md` — zero errors during feature verification
- `.claude/rules/33-staging-feature-validation.md` — dependency-chain validation method
- `.claude/rules/01-doc-sync.md` — docs must match code (drove the AGENTS.md correction)
- Policy: "prefer LTS; image tags must move together with their SDK/package versions"
- Policy: Hetzner 10-server cap shared prod/staging; staging runs zero VMs at rest
