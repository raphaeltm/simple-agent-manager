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
- [ ] Final screenshot review and staging UI deployment check
- [ ] PR with screenshot/review evidence

Local screenshot evidence: .codex/tmp/playwright-screenshots/installer-*.png.
Initial screenshot review found mobile headline/CTA placement and missing light
mode; both fixed. Shared glass/font/mascot copies documented in installer README.
Button green darkened for normal-text contrast while retaining standard accent.

Parent blocker: OAuth-client setup returned Cloudflare403 with deployment token.
Do not claim real sign-in/install works or merge around the existing credential gate.
This task can deliver/review staging design independently of real OAuth consent.
No full SAM deployment/build/update behavior added.
