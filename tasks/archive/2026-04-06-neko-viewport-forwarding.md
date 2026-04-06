# Fix Neko Browser Viewport Forwarding to Chrome

## Problem

When a mobile user clicks "Remote Browser" in the project chat, the frontend correctly captures and sends device info (viewport, DPR, touch, UA) to the VM agent. The VM agent handler parses these fields into `StartOptions`. However, `manager.go:251-256` drops `ViewportWidth` and `ViewportHeight` when building the `ChromeCustomization` struct — the struct doesn't even have those fields. As a result, Chrome inside Neko always starts with the default 1920x1080 window size instead of matching the user's device viewport.

The viewport IS used to set the Neko container's streaming resolution (`NEKO_SCREEN_RESOLUTION`), but that only controls the video encoding canvas — Chrome's window size inside is still `--start-maximized` against a 1920x1080 display.

## Root Cause

1. `ChromeCustomization` struct (`chrome_config.go:13-18`) lacks `ViewportWidth`/`ViewportHeight` fields
2. `manager.go:251-256` doesn't pass viewport from `opts` to `ChromeCustomization`
3. `buildChromeFlags()` doesn't add `--window-size=W,H` flag

## Research Findings

- `StartOptions` already has `ViewportWidth` and `ViewportHeight` (manager.go:55-56)
- Viewport is already used for Neko resolution (manager.go:157-159) — correct
- Chrome supports `--window-size=W,H` CLI flag for setting initial window dimensions
- The supervisord command already includes `--start-maximized` which should be replaced with `--window-size` when viewport is specified
- `customSupervisordConf()` hardcodes `--start-maximized` in the command template (chrome_config.go:126)

## Implementation Checklist

- [x] Add `ViewportWidth` and `ViewportHeight` fields to `ChromeCustomization` struct
- [x] Pass viewport from `opts` to `ChromeCustomization` in `manager.go:251-256`
- [x] In `buildChromeFlags()`, add `--window-size=W,H` flag when viewport dimensions are provided
- [x] In `customSupervisordConf()`, accept viewport dimensions and conditionally replace `--start-maximized` with `--window-size=W,H`
- [x] Add/update tests for `buildChromeFlags()` and `customSupervisordConf()` with viewport parameters

## Acceptance Criteria

- [ ] When a mobile user starts the Neko browser, Chrome's window matches the requested viewport dimensions
- [ ] When no viewport is specified, Chrome still uses `--start-maximized` (backward compatible)
- [ ] Unit tests cover both viewport-specified and default cases
- [ ] Verified on staging with a mobile device showing correct viewport in the test page

## References

- `packages/vm-agent/internal/browser/chrome_config.go` — ChromeCustomization struct and flag building
- `packages/vm-agent/internal/browser/manager.go` — Start() method, lines 251-256
- PR #611 — Device emulation feature that added viewport forwarding to the frontend
