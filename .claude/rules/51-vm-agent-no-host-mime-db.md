# VM Agent Must Not Depend on Host-Provided MIME/OS Databases for Product Output

## When This Applies

This rule applies to any vm-agent (`packages/vm-agent/`) code whose **output
crosses into product data or a browser** and is derived from a host-provided OS
file or database that is NOT guaranteed to exist across every runtime the
vm-agent runs in. The canonical case is content-type resolution via Go's
`mime.TypeByExtension`, which reads `/etc/mime.types` /
`/etc/apache2/mime.types` — files present on the full Ubuntu VM host (via the
`media-types` package) but ABSENT on the minimal Debian cf-container Instant
image.

Other host-DB dependencies in this class: `/etc/passwd`/`/etc/group` lookups,
timezone DBs (`/usr/share/zoneinfo`), `/etc/os-release`-driven branching,
locale/charset tables, and any `exec`-of-a-host-binary whose presence differs
between the VM image and the container image.

## Why This Rule Exists

Agent uploads of `.md`/`.txt`/`.yaml`/etc. into the project file library landed
as `application/octet-stream` and refused to preview. Root cause:
`handleFileDownload`/`handleFileRaw` derived the Content-Type via
`mime.TypeByExtension`, which returns `""` for those extensions on the
cf-container image (no `/etc/mime.types`); the code fell back to
`application/octet-stream`; `upload_to_library` stored that as the library
`mimeType`; and both the web preview and the API preview endpoint gate strictly
on the MIME type. The behavior was correct on VM nodes and broken on Instant
containers — a silent, runtime-dependent divergence that only surfaced weeks
after sessions moved to containers. See
`tasks/archive/2026-07-23-fix-library-octet-stream-preview.md`.

## Class of Bug

**vm-agent behavior that silently changes with the runtime/base image** because
it reads a host-provided OS file/DB that is not guaranteed across runtimes. The
code "works" wherever the file happens to exist and "breaks" where it doesn't —
with no error, just wrong output.

## Hard Requirements

1. **Register the mappings you depend on in-process.** For any host DB whose
   contents affect product output, ship a curated in-process table checked
   BEFORE the host lookup, so the result is identical on every runtime. The
   host lookup may remain as a secondary source for values you do not curate,
   but it must never be the ONLY source for a value the product relies on.

2. **Curated-first, not host-first, for the values you care about.** Consulting
   the host DB first leaves a residual runtime dependency for the exact values
   you are trying to make deterministic, and makes the host-independence test
   non-discriminating on a host that happens to have the DB. Check the curated
   table first.

3. **A curated static table is not a Principle XI hardcoded value.** IANA MIME
   types, canonical charsets, and similar fixed vocabularies are protocol
   constants, not configuration. Do not route them through env vars.

4. **Prove host-independence with a discriminating test.** The test MUST fail on
   a host-first implementation. Poison the host table (e.g.
   `mime.AddExtensionType(".md", "application/x-poisoned")`) and assert the
   resolver still returns the curated value. A test that merely asserts
   `resolve(".md") == "text/markdown"` passes vacuously on any host that ships
   the DB and is NOT discriminating.

5. **Keep it DRY across call sites.** If more than one handler derives the same
   host-dependent output, extract ONE shared resolver and route every caller
   through it, so a future runtime change is fixed in one place.

## Quick Compliance Check

Before merging vm-agent code that derives product-visible output from a host
file/DB or host binary:
- [ ] The values the product relies on come from an in-process curated table
      checked before any host lookup
- [ ] A discriminating test poisons the host source and proves the curated
      value wins (fails on a host-first implementation)
- [ ] All call sites share ONE resolver (no copy-paste of the host lookup)
- [ ] The curated table is documented as a protocol constant, not config

## References

- Post-mortem/task: `tasks/archive/2026-07-23-fix-library-octet-stream-preview.md`
- `.claude/rules/02-quality-gates.md` — template-output verification + discriminating regression tests
- `.claude/rules/06-vm-agent-patterns.md` — runcmd interpreter contract (the Dash-vs-Bash analogue: runtime-shell divergence)
