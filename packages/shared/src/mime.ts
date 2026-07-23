/**
 * MIME-type helpers shared by the API worker and the web app.
 *
 * These exist because agent-uploaded files can land in the project file library
 * with `mimeType = application/octet-stream`: the vm-agent derives the type from
 * the file extension, and on the minimal cf-container image (no /etc/mime.types)
 * text/doc extensions used to fall back to octet-stream. The web preview
 * predicates and the API `/preview` gate both key off the stored MIME type, so
 * those files never previewed. `resolveEffectiveMimeType` lets both surfaces
 * recover the real type from the filename when the stored type is unknown —
 * fixing already-stored files without a re-upload.
 *
 * The extension → media-type mapping corresponds to the Go resolver's curated
 * table in packages/vm-agent/internal/server/content_type.go, with two
 * intentional differences: (1) values here are bare (no `; charset=...`) to match
 * the stored/served base types the preview code compares against, whereas the Go
 * table emits wire Content-Type headers and so charset-qualifies text types; and
 * (2) this table is broader — it also lists image/pdf/html types — because it is
 * the PRIMARY resolver here, whereas the Go table is only a FALLBACK behind Go's
 * built-in table (which already covers html/png/svg/pdf/json/xml).
 */

/** Canonical "unknown / not sniffed" content type. */
export const OCTET_STREAM_MIME = 'application/octet-stream';

/**
 * Curated filename-extension → base MIME type map. Values are bare (no
 * `; charset=...`) to match the stored/served types the preview code compares
 * against. Extensions here that are already previewable (md, html, images, pdf)
 * let an octet-stream-stored file of that type preview; the rest (txt, log,
 * yaml, toml, csv, json, xml) resolve to a correct — but not previewable — type,
 * matching the current preview policy.
 */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Strip MIME parameters (e.g. `; charset=utf-8`), trim, and lowercase. Returns
 * `''` for an empty/whitespace input.
 */
export function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase();
}

/**
 * True when a MIME type carries no useful information for preview decisions —
 * empty, or the generic `application/octet-stream`. These are the only cases in
 * which we fall back to the filename extension.
 */
export function isUnknownMimeType(mimeType: string | null | undefined): boolean {
  const base = normalizeMimeType(mimeType ?? '');
  return base === '' || base === OCTET_STREAM_MIME;
}

/**
 * Resolve a base MIME type from a filename's extension using the curated table.
 * Accepts a bare name or a path; only the final extension is used. Returns
 * `undefined` for an unknown or missing extension.
 */
export function mimeTypeFromFilename(filename: string | null | undefined): string | undefined {
  if (!filename) return undefined;
  const name = filename.split('/').pop() ?? '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return undefined; // no extension (e.g. "README", "Makefile")
  const ext = name.slice(lastDot + 1).toLowerCase();
  // Own-property check only: a filename is attacker-controlled, so an extension
  // like `__proto__`/`constructor`/`toString` must resolve to undefined, not to
  // the inherited Object.prototype member (a non-string, which would violate the
  // declared return type and be a footgun for any future consumer).
  if (!ext || !Object.hasOwn(EXTENSION_MIME_TYPES, ext)) return undefined;
  return EXTENSION_MIME_TYPES[ext];
}

/**
 * Resolve the effective base MIME type for preview/serve decisions:
 *   1. the stored type, when it is meaningful (not empty/octet-stream),
 *   2. otherwise the filename-extension type,
 *   3. otherwise `application/octet-stream`.
 *
 * The result is normalized (parameters stripped, lowercased). A meaningful
 * stored type is always trusted — extension sniffing only fills the gap left by
 * an octet-stream/empty type, so a file explicitly stored as e.g. `text/plain`
 * stays `text/plain` (and thus non-previewable).
 */
export function resolveEffectiveMimeType(
  storedMimeType: string | null | undefined,
  filename?: string | null,
): string {
  const base = normalizeMimeType(storedMimeType ?? '');
  if (!isUnknownMimeType(base)) {
    return base;
  }
  return mimeTypeFromFilename(filename) ?? OCTET_STREAM_MIME;
}
