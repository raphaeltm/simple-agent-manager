# Optional: magic-byte sniff before trusting an extension-derived `application/pdf` in `/preview`

- **Discovered**: 2026-07-23, during PR review of the agent-uploaded-markdown MIME preview fix (security-auditor LOW).
- **Severity**: LOW (optional hardening — introduces **no new** reachable attacker capability).

## Context

After the MIME-preview fix, an octet-stream-stored file named `x.pdf` resolves
via `resolveEffectiveMimeType` to `application/pdf` from the extension alone, so
`GET /:fileId/preview` (`apps/api/src/routes/library.ts`) passes the previewable
gate and serves it with the more permissive PDF CSP
(`script-src 'unsafe-inline'; object-src 'self'`) with no magic-byte validation.

## Why it introduces no new capability (verified in review)

- An agent could already get `application/pdf` stored for a `.pdf` file **before**
  this PR, because Go's built-in `mime.TypeByExtension` table contains `.pdf`
  unconditionally (independent of the new fallback table and of `/etc/mime.types`).
- The direct `/upload` HTTP caller can set `mimeType: application/pdf` directly —
  a strictly simpler path to the same CSP branch.
- The web PDF iframe uses `sandbox="allow-same-origin"` **without** `allow-scripts`
  (`FilePreviewModal.tsx`), so scripts do not execute regardless of the framed
  resource's declared CSP.

## Optional hardening

Before serving an **extension-derived** (not stored) `application/pdf` with the
loosened CSP, cheaply verify the decrypted bytes begin with `%PDF-`; otherwise
reject or fall back to the strict CSP.

## Acceptance criteria

- [ ] Extension-derived `application/pdf` whose bytes do not start with `%PDF-` does not get the permissive PDF CSP.
- [ ] A genuine PDF (stored or extension-derived) still previews.
- [ ] Regression test covers a `.pdf`-named non-PDF octet-stream file.
