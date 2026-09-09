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

const PROVIDERS_SRC = join(__dirname, '..', '..', '..', 'packages', 'providers', 'src');

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

/** Extract the balanced `{ ... }` or `[ ... ]` literal following `export const <symbol>`. */
function extractLiteral(source: string, symbol: string, open: '{' | '['): string {
  const declaration = source.indexOf(`export const ${symbol}`);
  expect(declaration, `${symbol} not found — the provider source moved or was renamed`).toBeGreaterThan(-1);
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
    expect(Object.keys(SOURCES).sort()).toEqual(Object.keys(PROVIDER_CATALOG).sort());
  });
});
