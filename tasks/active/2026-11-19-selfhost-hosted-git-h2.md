# H2: SAM-hosted git on self-host only

## Problem
A box built from main needs a repository source before it can create a project and run an agent. Owner D7 narrowed: HostedGitRepo is celld-only, never a Cloudflare export, binding, import or migration. Main v23 is unrelated and untouched.

## Research and preflight
Classes: cross-component, business logic, security sensitive, infra, docs sync. Main 08abf1393 already has L16's backend fallback selection and L22b's single self-host entry. L22c #2906 remains open, held on #2905 and security review; coordinator confirmed import/trim can proceed while celld wiring and BOX wait for L22c main. Integration has hosted-git runtime and conformance fixtures, but shared routes import local implementation (M4 HIGH-4).

Trace: project-create -> resolved Artifacts backend -> seed/import via backend remoteFetch -> authenticated self-host git HTTP -> HostedGitRepo SQLite. Runtime callback -> active workspace/current generation -> backend createToken with workspace identity -> git HTTP rechecks membership/lifecycle/generation -> push commits ref. Cloudflare keeps binding or null and global fetch, with no registered fallback.

Use existing L16 selection, extend its optional token context and fetch/import contract. Move implementation under selfhost; preserve Cloudflare semantics. Import with git checkout paths, no cherry-pick. Tests must exercise real git over smart HTTP and prove import-graph detection by introducing a forbidden import. Relevant lessons: callback routing/auth rule 34; DO interleaving rule 45; cross-boundary/vertical tests rules 23/35; no secret readback rule 83. Docs: operator README only (experimental self-host slice).

## Checklist
- [x] Fresh branch from main; import selected integration paths and trim
- [x] Move DO and hosted-git services under selfhost; dgit/pako excluded from Worker graph
- [x] Extend generic fallback seam: workspace-bound token context, remoteFetch and optional import capability (unregistered per coordinator empty-repo decision); remove shared local-backend branches
- [x] Wire celld-only binding/export/tag via L22 single entry stacked on stable L22c539625202 per coordinator
- [x] Add conformance/auth/lifecycle/token tests and import-graph violation proof
- [x] Document self-host repository support and limits
- [ ] Local lint/typecheck/tests/build; security, Cloudflare, architecture and completion reviews
- [ ] Draft PR then ready/CI/CodeRabbit request and wait
- [ ] Primary staging lease/deploy: Artifacts and GitHub project creation unchanged, local seam off
- [ ] BOX existing bucket-mode deploy adds selfhost-hosted-git-v1; create project; OpenCode free reply; agent push verified; cleanup and BOX FREE
- [ ] Merge main; all gates current head; announce merging/merged SHA; production success; idea SHIPPED

## Acceptance
No HostedGitRepo/dgit/pako reachable from Cloudflare index; wrangler unchanged; no CF migration. Shared seam inert on Cloudflare. BOX upgrade succeeds with new celld tag, project creation and actual short free-model agent reply/push work. Every resource created by this task cleaned up. All required gates pass on merge head.

## Implementation evidence
Stacked L22c539625202 per coordinator to break circular BOX gate; #2906 merges before H2. Hosted suite19/19 (real git18 + celld dry-run1); selfhost unit113/113; config/project29/29; native runtime-token32/32. Worker graph negative probe importing pako through workspace package failed as intended. GC admission negative probe failed exactly the race test. Security followup inflation/GC6/6.
