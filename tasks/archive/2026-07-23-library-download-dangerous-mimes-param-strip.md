# Harden `/download` DANGEROUS_MIMES check to strip MIME parameters

- **Discovered**: 2026-07-23, during PR review of the agent-uploaded-markdown MIME preview fix (cloudflare-specialist MEDIUM). Pre-existing; NOT introduced by that PR (`/download` is byte-for-byte unchanged there).
- **Severity**: MEDIUM (defence-in-depth; primary control is effective).

## Problem

`apps/api/src/routes/library.ts` `GET /:fileId/download` downgrades dangerous
content types to `application/octet-stream`:

```ts
const DANGEROUS_MIMES = ['text/html', 'application/javascript', 'application/xhtml+xml', 'image/svg+xml', 'text/xml'];
const contentType = DANGEROUS_MIMES.includes(file.mimeType.toLowerCase())
  ? 'application/octet-stream'
  : file.mimeType;
```

`.includes()` is an exact match with **no MIME-parameter stripping**. Go's
built-in `mime.TypeByExtension` returns `text/html; charset=utf-8` for `.html`/
`.htm` and `text/xml; charset=utf-8` for `.xml`, so an agent-uploaded
`report.html` is stored as `text/html; charset=utf-8`, which does NOT match the
bare `text/html` entry — the downgrade never fires for these files.

## Why it's not urgent

`Content-Disposition: attachment` is set unconditionally on `/download` (plus
`X-Content-Type-Options: nosniff`), and is the primary, effective control
against inline execution (direct navigation, `<a>`, `<iframe>`, `window.open`
all honour `attachment`). The `DANGEROUS_MIMES` downgrade is a secondary
defence-in-depth layer that is silently inactive for charset-qualified variants.
No demonstrated bypass of the primary control.

## Fix

Compare against the normalized base type using the now-shared helper:

```ts
import { normalizeMimeType } from '@simple-agent-manager/shared';
const contentType = DANGEROUS_MIMES.includes(normalizeMimeType(file.mimeType))
  ? 'application/octet-stream'
  : file.mimeType;
```

## Acceptance criteria

- [ ] `/download` for a file stored as `text/html; charset=utf-8` serves `Content-Type: application/octet-stream`.
- [ ] Regression test: charset-qualified `text/html`/`text/xml`/`image/svg+xml` all downgrade.
- [ ] `Content-Disposition: attachment` + `nosniff` remain unconditional.
