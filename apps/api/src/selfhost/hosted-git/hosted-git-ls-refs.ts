/**
 * `ref-prefix` for protocol v2 `ls-refs` on SAM-hosted repositories.
 *
 * The vendored dgit server (`vendor/dgit/git/protocol.ts`, `lsRefs`) ignores `ref-prefix` and
 * always answers HEAD plus every ref. Git's protocol v2 says a server given `ref-prefix` arguments
 * shows only refs that start with one of them (gitprotocol-v2, "ls-refs"). Clients that rely on it,
 * such as isomorphic-git's `listServerRefs({ prefix: 'refs/heads/' })` behind the project's branch
 * list, then saw "HEAD" as a branch (box round R13 D11). The vendored files stay a byte copy of
 * upstream (UPSTREAM.md), so the filter lives here, applied by the Durable Object to the answer.
 */
import { FLUSH, pkt, PktParser } from '../../vendor/dgit/git/pktline';
import { concat } from '../../vendor/dgit/git/util';

/** Upper bound on one ls-refs answer the filter buffers (refs only, no objects). */
const MAX_LS_REFS_RESPONSE_BYTES = 16 * 1024 * 1024;

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
    else if (p.text.startsWith('ref-prefix ')) prefixes.push(p.text.slice('ref-prefix '.length));
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
  if (body.length > MAX_LS_REFS_RESPONSE_BYTES) return response;
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
