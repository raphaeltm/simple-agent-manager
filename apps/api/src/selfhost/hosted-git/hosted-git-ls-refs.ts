/**
 * `ref-prefix` for protocol v2 `ls-refs` on SAM-hosted repositories.
 *
 * The vendored dgit server (`vendor/dgit/git/protocol.ts`, `lsRefs`) ignores `ref-prefix` and
 * always answers HEAD plus every ref. Git's protocol v2 says a server given `ref-prefix` arguments
 * shows only refs that start with one of them (gitprotocol-v2, "ls-refs"). Clients that rely on it,
 * such as isomorphic-git's `listServerRefs({ prefix: 'refs/heads/' })` behind the project's branch
 * list, then saw "HEAD" as a branch (box round R13 D11). The SAM adaptation is recorded in UPSTREAM.md; this filter is applied by the Durable Object.
 */
import { FLUSH, pkt, PktParser } from '../../vendor/dgit/git/pktline';
import { concat } from '../../vendor/dgit/git/util';

/** Upper bound on one ls-refs answer the filter buffers (refs only, no objects). */
const MAX_LS_REFS_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Most `ref-prefix` arguments honored. Past this the request is answered unfiltered, as git does
 * past its own limit (upload-pack TOO_MANY_PREFIXES), which bounds the filter at this many prefix
 * checks per ref instead of one per packet a 16 MiB request can carry. Clients send a handful.
 */
export const MAX_LS_REFS_PREFIXES = 256;

/**
 * The `ref-prefix` arguments of a protocol v2 `ls-refs` request, or null when the request is not
 * `ls-refs` or names no prefix (then every ref is shown, as the protocol says).
 */
export function lsRefsPrefixes(body: Uint8Array): string[] | null {
  const parser = new PktParser(body);
  let lsRefs = false;
  const prefixes: string[] = [];
  for (let p = parser.read(); p !== null; p = parser.read()) {
    if (p.kind !== 'line') continue;
    if (p.text === 'command=ls-refs') lsRefs = true;
    else if (p.text.startsWith('ref-prefix ')) {
      if (prefixes.length === MAX_LS_REFS_PREFIXES) return null; // too many: show every ref
      prefixes.push(p.text.slice('ref-prefix '.length));
    }
  }
  return lsRefs && prefixes.length > 0 ? prefixes : null;
}

/**
 * Keeps the lines of an `ls-refs` answer (`<oid> <refname>[ <attributes>]`) whose ref name starts
 * with one of the prefixes; the flush packet that ends the answer is kept.
 */
export async function filterLsRefsResponse(
  response: Response,
  prefixes: readonly string[]
): Promise<Response> {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > MAX_LS_REFS_RESPONSE_BYTES)
    return new Response('error: ref advertisement exceeds maximum size\n', { status: 413 });
  const parser = new PktParser(body);
  const kept: Uint8Array[] = [];
  for (let p = parser.read(); p !== null; p = parser.read()) {
    if (p.kind !== 'line') continue;
    const name = p.text.split(' ')[1] ?? '';
    if (prefixes.some((prefix) => name.startsWith(prefix))) kept.push(pkt(p.raw));
  }
  return new Response(concat([...kept, FLUSH]), {
    status: response.status,
    headers: response.headers,
  });
}
