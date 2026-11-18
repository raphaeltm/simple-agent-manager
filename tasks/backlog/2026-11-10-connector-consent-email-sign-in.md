# Connector consent page has no way to sign in on an email-only install

## Problem

`apps/web/src/pages/ConnectorConsent.tsx` renders sign-in buttons only for GitHub, Google and
GitLab. On an install whose only login provider is email (for example a fresh installer install
with no OAuth app), a signed-out user who opens a connector authorization link sees "Sign in to
review this app's access." and no way to sign in. Before #2617 the page showed a GitHub button
that could not work; now it correctly shows nothing, which is still a dead end.

## Context

Found 2026-11-10 by the local code review on PR #2617 (stop guessing login providers).
`Landing` and `DeviceAuth` already offer `EmailCodeSignIn` and return to the same page after a
code sign-in (`window.location.assign(returnPath)`).

## Acceptance Criteria

- [ ] When `providers.email` is true, the signed-out consent view offers `EmailCodeSignIn` and,
      after sign-in, returns to the same consent URL (request handle preserved)
- [ ] When no provider is configured, the page says so instead of rendering nothing
- [ ] Behavioural test: email-only providers → email form shown, sign-in returns to the consent URL
- [ ] Playwright screenshots at 375x667 and 1280x800
