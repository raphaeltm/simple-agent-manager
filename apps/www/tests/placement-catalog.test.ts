/**
 * Drift guard for the placement explorer's machine catalog.
 *
 * `apps/www` is a static marketing build and deliberately does NOT depend on
 * `@simple-agent-manager/providers` — pulling a Workers-oriented package into the site bundle to
 * render a teaching widget would be the wrong trade. `catalog.ts` is therefore a snapshot, and
 * this test is what stops the snapshot going stale silently.
 *
 * It reads the provider SOURCE as text rather than importing it. Importing would work for the
 * `*-metadata.ts` files (type-only imports) but not for `scaleway.ts`, which imports a runtime
 * value from `@simple-agent-manager/shared` and so needs that package built first. Making a
 * marketing-site test depend on a build of two other packages is worse than parsing four
 * well-known literal blocks — and text extraction cannot be broken by a future provider adding
 * an import.
 *
 * Every extraction asserts a non-trivial match count, so a regex that silently matches nothing
 * fails loudly instead of reporting "no drift" (rule 02: the absence of results and the absence
 * of failures are not the same thing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_CATALOG, type ProviderId, type Tier } from '../src/components/placement/catalog';
import {
  HOST_MEMORY_RESERVE_MB,
  MAX_CO_TENANTS,
  MAX_WORKSPACES_PER_NODE,
} from '../src/components/placement/types';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const PROVIDERS_SRC = join(REPO_ROOT, 'packages', 'providers', 'src');

interface SourceSpec {
  file: string;
  sizeSymbol: string;
  locationSymbol: string;
}

const SOURCES: Record<ProviderId, SourceSpec> = {
  hetzner: {
    file: 'hetzner-metadata.ts',
    sizeSymbol: 'HETZNER_SIZE_CONFIGS',
    locationSymbol: 'HETZNER_LOCATIONS',
  },
  scaleway: {
    file: 'scaleway.ts',
    sizeSymbol: 'SCALEWAY_SIZE_CONFIGS',
    locationSymbol: 'SCALEWAY_LOCATIONS',
  },
  digitalocean: {
    file: 'digitalocean-metadata.ts',
    sizeSymbol: 'DIGITALOCEAN_SIZE_CONFIGS',
    locationSymbol: 'DIGITALOCEAN_LOCATIONS',
  },
  vultr: {
    file: 'vultr-metadata.ts',
    sizeSymbol: 'VULTR_SIZE_CONFIGS',
    locationSymbol: 'VULTR_LOCATIONS',
  },
};

function readProviderSource(spec: SourceSpec): string {
  return readFileSync(join(PROVIDERS_SRC, spec.file), 'utf8');
}

/**
 * Extract the balanced `{ ... }` or `[ ... ]` literal following `export const <symbol>`.
 *
 * The symbol match is WORD-ANCHORED. A plain `indexOf` substring search silently matched
 * `HETZNER_SIZE_CONFIGS` inside a renamed `HETZNER_SIZE_CONFIGS_V2` and reported "no drift" —
 * the guard passed while the thing it guards had been renamed out from under it.
 *
 * Known limitation: the brace counter below is not string-aware, so a brace inside a string
 * literal (e.g. `price: '{promo}'`) would desync the depth count. No provider currently has one;
 * if that changes, this needs a real tokenizer rather than a counter.
 */
function extractLiteral(source: string, symbol: string, open: '{' | '['): string {
  const anchored = new RegExp(`export const ${symbol}\\b`).exec(source);
  expect(anchored, `${symbol} not found — the provider source moved or was renamed`).not.toBeNull();
  const declaration = anchored?.index ?? -1;
  const start = source.indexOf(open, declaration);
  expect(start, `no ${open} after ${symbol}`).toBeGreaterThan(-1);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated literal for ${symbol}`);
}

interface ParsedSize {
  type: string;
  vcpu: number;
  ramGb: number;
  storageGb: number;
}

function parseSizeConfigs(literal: string): Record<string, ParsedSize> {
  const out: Record<string, ParsedSize> = {};
  for (const tier of ['small', 'medium', 'large']) {
    const entry = new RegExp(`\\b${tier}:\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(literal);
    expect(entry, `no ${tier} entry in size configs`).not.toBeNull();
    const body = entry?.[1] ?? '';
    const field = (name: string): string => {
      const match = new RegExp(`\\b${name}:\\s*([^,\\n]+)`).exec(body);
      expect(match, `no ${name} on ${tier}`).not.toBeNull();
      return (match?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
    };
    out[tier] = {
      type: field('type'),
      vcpu: Number(field('vcpu')),
      ramGb: Number(field('ramGb')),
      storageGb: Number(field('storageGb')),
    };
  }
  return out;
}

function parseLocations(literal: string): string[] {
  return [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

const GB = 1024;

describe('placement catalog snapshot matches packages/providers', () => {
  for (const [id, spec] of Object.entries(SOURCES) as [ProviderId, SourceSpec][]) {
    describe(id, () => {
      const source = readProviderSource(spec);
      const snapshot = PROVIDER_CATALOG[id];

      it('extracts a non-empty catalog from the provider source', () => {
        // Guards the guard: a regex that matched nothing must not read as "no drift".
        const sizes = parseSizeConfigs(extractLiteral(source, spec.sizeSymbol, '{'));
        const locations = parseLocations(extractLiteral(source, spec.locationSymbol, '['));
        expect(Object.keys(sizes)).toHaveLength(3);
        expect(locations.length).toBeGreaterThanOrEqual(2);
      });

      it('matches SKU, vCPU, memory and disk for every tier', () => {
        const sizes = parseSizeConfigs(extractLiteral(source, spec.sizeSymbol, '{'));
        for (const tier of ['small', 'medium', 'large'] as Tier[]) {
          const upstream = sizes[tier];
          const local = snapshot.offerings.find((item) => item.tier === tier);
          expect(local, `${id}/${tier} missing from the snapshot`).toBeDefined();
          if (!upstream || !local) continue;
          expect(local.instanceType, `${id}/${tier} SKU drifted`).toBe(upstream.type);
          expect(local.vcpu, `${id}/${tier} vCPU drifted`).toBe(upstream.vcpu);
          expect(local.memoryMb, `${id}/${tier} memory drifted`).toBe(upstream.ramGb * GB);
          expect(local.diskMb, `${id}/${tier} disk drifted`).toBe(upstream.storageGb * GB);
        }
      });

      it('matches the region list', () => {
        const locations = parseLocations(extractLiteral(source, spec.locationSymbol, '['));
        expect(snapshot.regions, `${id} regions drifted`).toEqual(locations);
      });
    });
  }

  it('covers every provider the explorer offers', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(SOURCES).sort(byName)).toEqual(Object.keys(PROVIDER_CATALOG).sort(byName));
  });

  it('does not match a symbol that is merely a PREFIX of the real declaration', () => {
    // Guard-the-guard. With an unanchored `indexOf`, renaming FOO to FOO_V2 upstream left this
    // whole suite green: the search matched the prefix and happily parsed the renamed object.
    const fixture = "export const FOO_V2 = {\n  small: { type: 'x' },\n};\n";
    expect(() => extractLiteral(fixture, 'FOO', '{')).toThrow();
    // Owner control: the real symbol still extracts.
    expect(extractLiteral(fixture, 'FOO_V2', '{')).toContain("type: 'x'");
  });
});

/**
 * The explorer states these three as REAL SAM defaults rather than illustrative values — the
 * widget's model-note and the blog post both say so in as many words. A claim made that
 * confidently deserves at least the same drift protection as the machine catalog above. Same
 * text-extraction technique, for the same reason: `apps/www` must not take a build dependency on
 * `apps/api` or `packages/shared`.
 */
describe('real SAM defaults mirrored by the explorer', () => {
  function readNumericConst(relativePath: string, symbol: string): number {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    const match = new RegExp(`export const ${symbol}\\s*(?::\\s*\\w+\\s*)?=\\s*([\\d_]+)`).exec(source);
    expect(
      match,
      `${symbol} not found in ${relativePath} — moved, renamed, or no longer a plain numeric literal`
    ).not.toBeNull();
    return Number((match?.[1] ?? '').replace(/_/g, ''));
  }

  it('HOST_MEMORY_RESERVE_MB matches DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB', () => {
    const upstream = readNumericConst(
      'apps/api/src/services/workspace-resource-capacity.ts',
      'DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB'
    );
    expect(upstream).toBeGreaterThan(0);
    expect(HOST_MEMORY_RESERVE_MB).toBe(upstream);
  });

  it('MAX_WORKSPACES_PER_NODE matches DEFAULT_MAX_WORKSPACES_PER_NODE', () => {
    const upstream = readNumericConst(
      'packages/shared/src/constants/task-execution.ts',
      'DEFAULT_MAX_WORKSPACES_PER_NODE'
    );
    expect(upstream).toBeGreaterThan(0);
    expect(MAX_WORKSPACES_PER_NODE).toBe(upstream);
  });

  it('MAX_CO_TENANTS matches PLATFORM_RESOURCE_DEFAULTS.maxCoTenants', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'shared', 'src', 'constants', 'resource-defaults.ts'),
      'utf8'
    );
    const block = /export const PLATFORM_RESOURCE_DEFAULTS[^{]*\{([\s\S]*?)\}/.exec(source);
    expect(block, 'PLATFORM_RESOURCE_DEFAULTS not found').not.toBeNull();
    const match = /maxCoTenants:\s*(\d+)/.exec(block?.[1] ?? '');
    expect(match, 'maxCoTenants not found in PLATFORM_RESOURCE_DEFAULTS').not.toBeNull();
    const upstream = Number(match?.[1]);
    expect(upstream).toBeGreaterThan(0);
    expect(MAX_CO_TENANTS).toBe(upstream);
  });

  it('the node-wide cap is the stricter of the two, which is why the model enforces it first', () => {
    expect(MAX_WORKSPACES_PER_NODE).toBeLessThan(MAX_CO_TENANTS);
  });
});
