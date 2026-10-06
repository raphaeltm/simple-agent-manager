# Project "Files" tab — remote-branch git browser + diff (GitHub + Artifacts)

SAM idea: `01KWY7MR2G2TV0YCDE1R333NF7` (canonical spec — full context, research, sources, UX, compatibility proof). This task file is the implementation checklist; read the idea for rationale.

## User constraints (override /do defaults)
- **SKIP staging deployment** — another agent owns staging. Do NOT trigger `deploy-staging.yml`.
- **Do NOT self-merge** — open PR labeled `needs-human-review`; no prod-deploy monitoring.
- **Task file stays on the feature branch** — NOT pushed to main (a main push triggers a production deploy; avoid while another agent is active).
- **Tests exhaustive; compatibility proven** (done — see below).

## Problem
Reviewing an agent's output today requires provisioning a workspace (VM cost + time). Users want to **see what an agent changed on its branch vs the default branch, instantly, on mobile, with no VM** — plus browse the tree and open files. MVP = per-branch on the remote repo (GitHub or Artifacts), read-only.

## Research findings (verified)
- **GitHub is easy + already half-built.** `getRepositoryBranches()` (`apps/api/src/services/github-app.ts:931`) lists branches. Installation-token content reads already proven (`getRepositoryGitmodules`, :894). Diff via `GET /repos/{o}/{r}/compare/{base}...{head}` returns per-file `status`/`additions`/`deletions`/`patch` — VERIFIED against the real public repo; `patch` is unified-diff that feeds `DiffRenderer` untouched. Tree via `git/trees/{ref}?recursive=1` (VERIFIED, one call).
- **Artifacts compatibility PROVEN in workerd** (spike `.tmp/iso-spike/`, results in idea §10): isomorphic-git 1.38.6 under `wrangler dev` did listServerRefs + shallow `depth:1` clone + readTree/readBlob + fetch + two-tree `git.walk` diff — ALL passed. MUST use a **custom in-memory fs** (built-in `node:fs` virtual fs rejects `mkdir`). Import `isomorphic-git/http/web`. Artifacts token auth = Basic `x:<secret>` from `art_v1_<secret>?expires=`. Artifacts does NOT support partial-clone `filter` → use shallow (proven).
- **Reusable UI (do not rebuild):** `DiffRenderer` (`apps/web/src/components/shared-file-viewer/DiffRenderer.tsx`, takes `diff: string`), `MarkdownRenderer` (SyntaxHighlightedCode, RenderedMarkdown), `ImageViewer`, `lib/file-utils`, `lib/fuzzy-match` (fuzzyFilterFiles, breadcrumbs), `ChatFilePanel` pattern.
- **Route mounting:** add a `repoBrowseRoutes` sub-router to `apps/api/src/routes/projects/index.ts` (inside `projectsRoutes` — session-cookie auth via `requireProjectAccess`; NOT a VM-agent callback, so rule 34 does not apply).
- **Web:** api client is split under `apps/web/src/lib/api/` (mirror `files.ts`). New page `ProjectFiles.tsx` + route in `apps/web/src/App.tsx:123` + "Files" tab in `NavSidebar.tsx`. Sub-route pattern like library/triggers.
- **Shared types** go in `packages/shared`.

## Architecture
Provider-agnostic interface `RepoBrowser { listBranches(); listTree(ref, path?); getFile(ref, path); compare(base, head); }`, resolved from `project.repoProvider`. GitHub impl = REST. Artifacts impl = isomorphic-git shallow clone + in-memory fs + SHA-keyed cache (KV/R2). Read-only; no D1 schema changes. All limits/timeouts env-configurable with `DEFAULT_*` (Constitution XI).

## Implementation checklist

### Shared types (`packages/shared`)
- [ ] `RepoBranch`, `RepoTreeEntry` (path, type: tree|blob, size?), `RepoTreeResponse` (entries, truncated), `RepoFileContent` (path, encoding, content|rawUrl, size, isBinary), `RepoCompareFile` (path, status, additions, deletions, patch?, patchTruncated), `RepoCompareResponse` (base, head, files, truncated, totals).

### API — provider-agnostic layer (`apps/api/src`)
- [ ] `services/repo-browse/types.ts` — `RepoBrowser` interface.
- [ ] `services/repo-browse/github.ts` — REST impl (branches via existing helper; tree via git/trees recursive; file via contents/blobs/raw; compare via compare API). Size guards, binary/image detection, truncation flags.
- [ ] `services/repo-browse/artifacts.ts` — isomorphic-git impl (MemoryFS from spike; listServerRefs; shallow clone; readTree/readBlob; fetch+two-tree walk diff; unified-diff generation for patches). Behind `ARTIFACTS_ENABLED`.
- [ ] `services/repo-browse/memory-fs.ts` — port the proven spike MemoryFS.
- [ ] `services/repo-browse/cache.ts` — SHA-keyed cache (KV) for Artifacts trees/diffs (optional MVP; at least interface).
- [ ] `services/repo-browse/index.ts` — `resolveRepoBrowser(project, env)` factory.
- [ ] `routes/projects/repo-browse.ts` — `GET /:id/repo/branches|tree|file|compare` with `requireProjectAccess`; validation; error mapping.
- [ ] Mount in `routes/projects/index.ts`. Add `isomorphic-git` dep to `apps/api/package.json`.

### Web (`apps/web/src`)
- [ ] `lib/api/repo-browse.ts` + export from `lib/api/index.ts` — client fns + types.
- [ ] `pages/ProjectFiles.tsx` — two-mode surface (Changes default for non-default branch / Browse), branch selector (default pinned, task `sam/*` branches surfaced, type-filter), reuse DiffRenderer/MarkdownRenderer/ImageViewer/fuzzy-match. URL = `?ref=&mode=&path=&base=`.
- [ ] Route `<Route path="files" element={<ProjectFiles />} />` in `App.tsx`.
- [ ] "Files" tab in `NavSidebar.tsx`.
- [ ] Entry point: "Review changes" deep-link from a task/session `outputBranch` → Files → Changes mode.

### Tests (exhaustive)
- [ ] API unit: github impl (branch/tree/file/compare parsing, truncation, binary, large-file guard) with mocked fetch.
- [ ] API unit: artifacts impl against a local in-process git server OR mocked isomorphic-git transport; two-tree diff correctness (add/remove/modify), shallow, token-auth header shape; MemoryFS unit tests.
- [ ] API integration (Miniflare): each route, auth (requireProjectAccess denies non-member), non-github/non-artifacts handling, ARTIFACTS_ENABLED gating.
- [ ] Capability/vertical-slice: request → RepoBrowser → provider → response for both providers (mock provider boundary with realistic state).
- [ ] Web: ProjectFiles renders; branch switch; mode toggle; open file; open diff (DiffRenderer); fuzzy search; empty/no-changes/truncated/binary/error states. Behavioral (render + interact), not source-contract.
- [ ] Playwright visual audit at 375px + 1280px, overflow asserted, stress data (long paths, 30+ files, empty, special chars).

### Docs
- [ ] Public docs under `apps/www/src/content/docs/docs/` (feature guide + note Artifacts staging-gating). Update env-reference if new env vars added.

## Acceptance criteria
- [ ] GitHub project: pick branch → see changed files vs default with diffs; browse full tree; open file with highlighting; filename search — all with NO workspace. (testable locally)
- [ ] Artifacts project (behind `ARTIFACTS_ENABLED`): same, via isomorphic-git shallow clone. (unit/integration tested; **end-to-end token-auth flagged for human/staging verification** — cannot verify without a real Artifacts repo)
- [ ] Deep-link URL restores exact ref+mode+path+base.
- [ ] Mobile (375px) usable; no horizontal overflow; states handled.
- [ ] No hardcoded values; all limits/timeouts env-configurable with defaults.
- [ ] Exhaustive tests pass locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).

## References
- Idea `01KWY7MR2G2TV0YCDE1R333NF7` (esp. §6 UX, §9 local verification, §10 compatibility proof)
- Rules: 06 (API patterns), 10 (e2e/capability), 17 (visual testing), 26 (chat-first), 34 (callback auth — N/A here), 35 (vertical slice), 47 (control-loop — N/A, no sweep). Constitution XI (no hardcoded).
- Spike: `.tmp/iso-spike/` (workerd isomorphic-git proof + MemoryFS).
