# VM Agent Behavior Must Not Depend on Host-Provided MIME/OS Databases

## When This Applies

This rule applies whenever vm-agent (`packages/vm-agent/`) code derives a value
that affects **product output** — an HTTP `Content-Type`, a stored metadata
field, a parsing/format decision — from a host-provided database or OS-specific
file that is NOT guaranteed to exist on every runtime the agent runs on. The
canonical example is `resolveContentType` in
`packages/vm-agent/internal/server/content_type.go`, which backs the
`/files/download` and `/files/raw` endpoints.

## Why This Rule Exists

The vm-agent runs on **two very different base images**: a full Ubuntu VM node
and the **minimal Debian image** used by the cf-container Instant runtime. Those
images ship different OS packages, and code that reads a host-provided file
silently produces different output depending on which runtime it happens to run
on.

The MIME incident: file downloads set `Content-Type` via Go's
`mime.TypeByExtension`, which — beyond Go's small compiled-in built-in table —
reads the host mime database that `mime.initMimeUnix` loads (`shared-mime-info`'s
`/usr/share/mime/globs2`, or failing that `/etc/mime.types` from the
`media-types` package). Ubuntu VM nodes ship one of those; the minimal
cf-container image ships neither. So `.md`, `.txt`, `.yaml`, `.toml`, `.csv`,
`.log` resolved correctly on the VM but fell back to `application/octet-stream`
on the container. `upload_to_library` stores that
`Content-Type` as the library file's `mimeType`, and both the web preview
predicates and the API `/preview` gate reject octet-stream — so **agent-uploaded
markdown never previewed**, but only for sessions that ran on Instant
containers. The bug was invisible in tests and on VM nodes.

## Class of Bug

**vm-agent behavior that silently changes with the runtime/base image**, because
it depends on a host-provided database or OS file that is present on one image
and absent on another. Content-type derivation, locale/charset defaults, timezone
databases, CA bundles, font/mime tables, and shell/interpreter availability are
all in this class.

## Hard Requirements

1. **Do not depend on a host-provided database/file being present for correct
   product behavior.** When the value affects product output, provide a
   deterministic **in-process** fallback so a missing host database degrades to a
   correct curated value — never to a broken/generic one (e.g.
   `application/octet-stream`) that changes user-visible behavior.

2. **Register the needed mappings in-process.** For content types, keep a curated
   in-process table for the extensions the host database would otherwise be
   responsible for. A curated static table is data, not a Principle XI hardcoded
   value.

3. **Keep cross-language tables in sync and say so.** When the same mapping exists
   in Go (vm-agent) and TypeScript (shared/web/api), cross-reference each table in
   a comment naming the other file, so the pair does not silently drift.

4. **Preserve existing safety headers.** A refactor of content-type resolution
   must preserve `X-Content-Type-Options: nosniff`, any SVG/HTML CSP, and
   `Content-Disposition` handling that was already in place.

## Required Tests

- A test that exercises the in-process fallback **directly**, with zero
  dependence on the host database (Go's `mime` table is cached via `sync.Once`
  and cannot be reset in-process, so a pure fallback-function test is the correct
  way to prove the no-host-database behavior). This is the discriminating test:
  it must assert the exact bytes the minimal-image runtime would produce.
- An end-to-end resolver test that asserts only **host-invariant** properties
  (e.g. "never octet-stream for the curated extensions", "markdown resolves to
  the text/markdown family") — because the OS database, when present, may map an
  extension to a variant type, and the test must pass on any CI host.

## Quick Compliance Check

Before merging vm-agent code that derives product-affecting output from the host
environment:
- [ ] The value has a deterministic in-process fallback for the minimal image
- [ ] A missing host database degrades to a correct curated value, not a generic/broken one
- [ ] Cross-language mapping tables cross-reference each other in comments
- [ ] Existing safety headers (nosniff, CSP, Content-Disposition) are preserved
- [ ] A direct fallback-function test proves the no-host-database behavior; the
      end-to-end test asserts only host-invariant properties

## References

- Fix: `packages/vm-agent/internal/server/content_type.go` +
  `packages/shared/src/mime.ts`
- `.claude/rules/06-vm-agent-patterns.md` — vm-agent runtime contracts
- `.claude/rules/02-quality-gates.md` — regression + process-fix requirements
- `.claude/rules/03-constitution.md` — curated static tables vs. hardcoded values
