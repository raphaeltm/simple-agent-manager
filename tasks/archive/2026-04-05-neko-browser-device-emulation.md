# Neko Browser Device Emulation

## Problem
When a user opens the Neko remote browser from a mobile device, Chrome inside Neko shows extension popups (SponsorBlock, uBlock), first-run dialogs, "unsupported command-line flag" warning bars, and opens to about:blank instead of the running app. The viewport doesn't match the user's device.

## Research Findings
- Neko's google-chrome image ships with SponsorBlock and uBlock Origin Lite pre-installed
- Chrome enterprise policies at `/etc/opt/chrome/policies/managed/` can disable extensions
- Supervisord config at `/etc/neko/supervisord/google-chrome.conf` controls Chrome flags
- `--disable-infobars` is deprecated since Chrome 77 and triggers its own warning bar
- `CommandLineFlagSecurityWarningsEnabled: false` policy suppresses the flag warning
- socat pre-seed needs to be tracked in state to avoid poll loop conflicts
- Docker DNS propagation can be slow; `--add-host` guarantees hostname resolution
- Frontend `detectedPorts` may be empty when Browser button is first clicked

## Implementation Checklist
- [x] Chrome enterprise policies to disable all extensions and suppress prompts
- [x] Custom supervisord config with device emulation flags (viewport, touch, UA, DPR)
- [x] `CommandLineFlagSecurityWarningsEnabled: false` policy
- [x] Remove deprecated `--disable-infobars` flag
- [x] Server-side auto-detection of startURL from DevContainer ports
- [x] Initial `syncForwarders()` in `Manager.Start()` before Chrome customization
- [x] `--add-host` DNS mapping from DevContainer hostname to IP
- [x] Public `DetectDevContainerPorts()` method for handler use
- [x] Remove untracked socat pre-seed from `applyChromeCustomization`
- [x] Staging verification with end-to-end Playwright test

## Acceptance Criteria
- [x] No SponsorBlock/uBlock popups or extension pages
- [x] No "unsupported command-line flag" warning bar
- [x] Chrome viewport matches user's device dimensions
- [x] Touch emulation enabled on mobile devices
- [x] Chrome auto-navigates to first detected port (localhost:3000)
- [x] socat forwarders properly tracked in state (no poll loop conflicts)
- [x] Verified on staging with Samsung Galaxy S21 emulation
