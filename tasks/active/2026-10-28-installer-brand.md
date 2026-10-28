# Installer brand and usability refinement

Request: continue parent session 3df4a676-3a87-43bb-9308-6b88c0f4be36;
make install.sammy.party match the homepage, improve usability, and review screenshots.
Parent installer branch was unmerged; merged its five commits into SAM output branch
sam/use-sam-mcp-tools-kyqej5 before refining the actual app.

## Direction

Considered centered card, split hero/setup, and full-page wizard. Selected split:
brand context plus a clear setup card on desktop; one column on mobile. Uses real
mascot, Chillax, homepage palette and shared glass material; static assets preserve
independent deployment. Supports system/light/dark; prototype outcome stays explicit.

## Checklist

- [x] Read SAM instructions; parent session direct read then scoped searches
- [x] Capture homepage and existing staging installer for visual comparison
- [x] Replace separate palette/logo with homepage assets and materials
- [x] Refine connection/account/ready/privacy and progress reset on disconnect
- [x] Exercise 320/375/1280 widths, both themes, long/35 accounts, no accounts,
      interrupted setup, unavailable OAuth, errors, create/disconnect, theme persistence
- [x] Local typecheck, lint, 12 unit tests, dry-run build
- [x] 56 browser screenshots and actual cross-origin handoff fixture
- [x] Final screenshot review and staging UI deployment check
- [x] PR with screenshot/review evidence

Local screenshot evidence: .codex/tmp/playwright-screenshots/installer-*.png.
Initial screenshot review found mobile headline/CTA placement and missing light
mode; both fixed. Shared glass/font/mascot copies documented in installer README.
Button green darkened for normal-text contrast while retaining standard accent.

Parent blocker: OAuth-client setup returned Cloudflare403 with deployment token.
Do not claim real sign-in/install works or merge around the existing credential gate.
This task can deliver/review staging design independently of real OAuth consent.
No full SAM deployment/build/update behavior added.

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2465 . Screenshot comment:
https://github.com/raphaeltm/simple-agent-manager/pull/2465#issuecomment-6473818195 .
56-screenshot audit passed; reviewed all light/dark mobile/desktop/narrow contact
sheets and full-size primary/privacy/handoff captures. Added green self-contained
ownership page styling (no font/asset request to installer after handoff).
First redesign staging run40719839606 passed code and browser checks; bootstrap
anonymous check failed before deployment and cleaned up its Worker. Next run
40720592740 includes safe response status/content-type/cf-ray diagnostics.

Run40720592740 diagnosed anonymous404 from Cloudflare workers.dev (HTML, SJC),
after health already returned200. Readiness now requires the known health payload
and anonymous401 together; retries only propagation404/503/network errors, bounded
by 12 attempts and a60s readiness deadline. Unexpected200 fails immediately.
Three regression tests verify eventual401, public200 fail-closed, and bounded
exhaustion; each checks cleanup. 15 tests, lint/typecheck pass. Cloudflare/security
skill checklist reviewed this testing-only change; no token/permission relaxation.

Run40721329924 passed the real bootstrap smoke and deleted its temporary Worker;
installer assets deployed at ab396d163beef6cc88517c7664abe85ee4a105f4. OAuth client
GET403/code10000 remains the sole configuration failure after deploy. Design is
live on staging; no real OAuth success claimed. Link checks additionally found
main/apps/installer404 and installer public guide URL returning the homepage.
Fix: source pinned to deployed SHA; local branded public self-host guide provides
usable instructions during the unmerged preview, with deployed revision checkout.
DOCS_URL remains overridable. Guide included in mobile/desktop/light/dark audit.

Final staged application revision: aeb7a018d4a2890ec700de2a894f05311c70032b;
run40722497098 passed all15 unit tests, typecheck/lint,62 browser fixture captures,
and real bootstrap provisioning/anonymous401/handoff/cleanup. It deployed assets,
then failed on the known OAuth GET403 (code10000). Final live Playwright audit:
18 captures,320/375/1280px in both themes for connect/privacy/self-host; no JS errors
or overflow. Source link HTTP200, guide includes correct revision checkout. Live
screenshots reviewed; sign-in correctly disabled. No production deployment/merge.
PR preflight formatting fixed and locally passes. Root dependency-evidence entry
added for the inherited @cloudflare/workers-types dev dependency; check passes.
CodeRabbit remains not requested because OAuth staging gate is not ready. PR has
needs-human-review for that credential blocker, not for CodeRabbit silence.

## Second design pass — independent critique, 2026-10-28

User rejected the first branded revision as a cheap knockoff and explicitly asked
for repeated design iterations plus a separate screenshot reviewer. Local reviewer
`/root/design_critique` compared homepage and installer desktop/mobile/light/dark.
Baseline failed: borrowed colors/type without the homepage's composition/depth.

Considered deployment studio, cloud blueprint, and focused portal. Selected studio
with architectural preview: actual shared homepage floor renderer (compiled locally,
no new dependency or runtime website coupling), precise header/icon/theme chrome,
restrained lighting, account→protected Worker preview behind an upright setup panel.
Iteration1 critique: mobile CTA too low, floor too bright, preview plane oversized,
illegible rotated label, unavailable-state alternative unclear. All addressed in
iteration2: CTA fully visible600–650px in375×667, quiet mask beneath copy, shortened
preview, removed rotated label, proximal unavailable notice with guide action.

Independent reviewer final verdict after all8 configured/unconfigured desktop/mobile
light/dark screenshots: "The final installer and homepage look consistent and show
the same level of design care." Scores hierarchy4, interaction4, mobile4, consistency5.
No remaining visual blocker. Explicitly not claiming an external award.
62-screenshot browser audit passes320/375/1280px, both themes. Keyboard audit passes
skip→setup→sign-in, disclosure Enter, theme keyboard selection/aria-pressed/persistence,
reduced-motion scene mount, no JS errors. 15 unit tests, lint/typecheck/build pass.
Iteration artifacts: .codex/tmp/playwright-screenshots/iteration-{1,2}/.
Next: one final staging deployment and live screenshot review by the same reviewer.
Known inherited OAuth GET403 still prevents real consent and merge; unchanged scope.

Second pass final live verification: run40729553497 passed package checks, all15
unit tests,62 screenshot fixtures and real bootstrap smoke/cleanup. Deployed app
c5adfb9ae9436b653af6c1618536c15f10cb4edf, then hit unchanged OAuth GET403/code10000.
18 additional unmocked live captures passed version/source200/guide/renderer mount,
no overflow or JS errors. Reviewer inspected all4 live desktop/mobile/light/dark
landing captures, including actual unavailable state, and gave final verdict:
"They look consistent and show the same quality of design execution." No remaining
design blockers or visible regression. Screenshot artifact12833588308. Review and
validation recorded in PR2465. Live Browser Back check retained both floor canvases.
Design work complete; real OAuth and aggregate PR merge remain blocked as before.
