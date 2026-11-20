/**
 * `ref-prefix` for protocol v2 ls-refs on SAM-hosted repositories (hosted-git-ls-refs.ts): the
 * vendored dgit server ignores it, so "HEAD" came back for `refs/heads/` (box round R13 D11).
 * The conformance suite drives the same filter through the real Durable Object and git.
 */
import { describe, expect, it } from 'vitest';

import {
  filterLsRefsResponse,
  lsRefsPrefixes,
} from '../../../src/selfhost/hosted-git/hosted-git-ls-refs';
import { FLUSH, pkt, PktParser } from '../../../src/vendor/dgit/git/pktline';
import { concat } from '../../../src/vendor/dgit/git/util';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const DELIM = new TextEncoder().encode('0001');

function lsRefsRequest(...args: string[]): Uint8Array {
  return concat([
    pkt('command=ls-refs\n'),
    pkt('agent=git/2.45\n'),
    DELIM,
    ...args.map((a) => pkt(`${a}\n`)),
    FLUSH,
  ]);
}

function lines(body: Uint8Array): string[] {
  const parser = new PktParser(body);
  const out: string[] = [];
  for (let p = parser.read(); p !== null; p = parser.read()) {
    out.push(p.kind === 'line' ? p.text : p.kind);
  }
  return out;
}

const answer = () =>
  new Response(
    concat([
      pkt(`${A} HEAD symref-target:refs/heads/main\n`),
      pkt(`${A} refs/heads/main\n`),
      pkt(`${B} refs/heads/feature/x\n`),
      pkt(`${B} refs/tags/v1 peeled:${A}\n`),
      FLUSH,
    ]),
    { headers: { 'content-type': 'application/x-git-upload-pack-result' } }
  );

describe('ls-refs ref-prefix', () => {
  it('reads the prefixes of an ls-refs request, and none from other requests', () => {
    expect(lsRefsPrefixes(lsRefsRequest('symrefs', 'ref-prefix refs/heads/'))).toEqual([
      'refs/heads/',
    ]);
    expect(lsRefsPrefixes(lsRefsRequest('ref-prefix HEAD', 'ref-prefix refs/tags/'))).toEqual([
      'HEAD',
      'refs/tags/',
    ]);
    // No prefix: every ref, as the protocol says.
    expect(lsRefsPrefixes(lsRefsRequest('symrefs'))).toBeNull();
    const fetch = concat([pkt('command=fetch\n'), DELIM, pkt(`want ${A}\n`), FLUSH]);
    expect(lsRefsPrefixes(fetch)).toBeNull();
  });

  it('refs/heads/ keeps the branches only: no HEAD, no tags', async () => {
    const filtered = await filterLsRefsResponse(answer(), ['refs/heads/']);
    expect(lines(new Uint8Array(await filtered.arrayBuffer()))).toEqual([
      `${A} refs/heads/main`,
      `${B} refs/heads/feature/x`,
      'flush',
    ]);
    expect(filtered.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
  });

  it('keeps attributes and every matching prefix (HEAD with its symref, peeled tags)', async () => {
    const filtered = await filterLsRefsResponse(answer(), ['HEAD', 'refs/tags/']);
    expect(lines(new Uint8Array(await filtered.arrayBuffer()))).toEqual([
      `${A} HEAD symref-target:refs/heads/main`,
      `${B} refs/tags/v1 peeled:${A}`,
      'flush',
    ]);
  });
});

it('rejects an oversized advertisement with a readable response', async () => {
  const response = await filterLsRefsResponse(new Response(new Uint8Array(16 * 1024 * 1024 + 1)), [
    'refs/heads/',
  ]);
  expect(response.status).toBe(413);
  expect(await response.text()).toContain('advertisement exceeds');
});

describe('ls-refs ref-prefix count bound (Codex r4636317748)', () => {
  it('honors up to the bound and answers unfiltered past it, as git does', async () => {
    const { MAX_LS_REFS_PREFIXES } =
      await import('../../../src/selfhost/hosted-git/hosted-git-ls-refs');
    const prefixes = (n: number) =>
      Array.from({ length: n }, (_, i) => `ref-prefix refs/heads/p${i}/`);
    expect(lsRefsPrefixes(lsRefsRequest(...prefixes(MAX_LS_REFS_PREFIXES)))).toHaveLength(
      MAX_LS_REFS_PREFIXES
    );
    // One more and the filter is skipped, so its cost is bounded by the cap, not the request size.
    expect(lsRefsPrefixes(lsRefsRequest(...prefixes(MAX_LS_REFS_PREFIXES + 1)))).toBeNull();
  });
});
