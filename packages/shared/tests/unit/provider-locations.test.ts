import { describe, it, expect } from 'vitest';
import {
  isValidLocationForProvider,
  getLocationsForProvider,
  getDefaultLocationForProvider,
  PROVIDER_LOCATIONS,
  PROVIDER_DEFAULT_LOCATIONS,
  VM_LOCATIONS,
  resolveProjectScalingConfig,
  SCALING_PARAMS,
} from '../../src/constants';

describe('Provider-Location Validation', () => {
  describe('isValidLocationForProvider', () => {
    it('accepts valid Hetzner locations', () => {
      expect(isValidLocationForProvider('hetzner', 'nbg1')).toBe(true);
      expect(isValidLocationForProvider('hetzner', 'fsn1')).toBe(true);
      expect(isValidLocationForProvider('hetzner', 'ash')).toBe(true);
    });

    it('rejects Hetzner location for GCP provider', () => {
      expect(isValidLocationForProvider('gcp', 'nbg1')).toBe(false);
    });

    it('rejects GCP location for Hetzner provider', () => {
      expect(isValidLocationForProvider('hetzner', 'us-central1-a')).toBe(false);
    });

    it('accepts valid GCP locations', () => {
      expect(isValidLocationForProvider('gcp', 'us-central1-a')).toBe(true);
      expect(isValidLocationForProvider('gcp', 'europe-west3-a')).toBe(true);
    });

    it('accepts valid Scaleway locations', () => {
      expect(isValidLocationForProvider('scaleway', 'fr-par-1')).toBe(true);
      expect(isValidLocationForProvider('scaleway', 'nl-ams-1')).toBe(true);
    });

    it('rejects Scaleway location for Hetzner', () => {
      expect(isValidLocationForProvider('hetzner', 'fr-par-1')).toBe(false);
    });

    it('returns false for unknown provider', () => {
      expect(isValidLocationForProvider('aws', 'us-east-1')).toBe(false);
    });

    it('returns false for empty location', () => {
      expect(isValidLocationForProvider('hetzner', '')).toBe(false);
    });
  });

  describe('getLocationsForProvider', () => {
    it('returns Hetzner locations', () => {
      const locations = getLocationsForProvider('hetzner');
      expect(locations.length).toBeGreaterThan(0);
      expect(locations.map((l) => l.id)).toContain('nbg1');
    });

    it('returns empty array for unknown provider', () => {
      expect(getLocationsForProvider('aws')).toEqual([]);
    });
  });

  describe('getDefaultLocationForProvider', () => {
    it('returns fsn1 for Hetzner', () => {
      expect(getDefaultLocationForProvider('hetzner')).toBe('fsn1');
    });

    it('returns fr-par-1 for Scaleway', () => {
      expect(getDefaultLocationForProvider('scaleway')).toBe('fr-par-1');
    });

    it('returns us-central1-a for GCP', () => {
      expect(getDefaultLocationForProvider('gcp')).toBe('us-central1-a');
    });

    it('returns undefined for unknown provider', () => {
      expect(getDefaultLocationForProvider('aws')).toBeUndefined();
    });
  });

  describe('VM_LOCATIONS derived from PROVIDER_LOCATIONS', () => {
    it('contains all provider locations', () => {
      for (const [, locations] of Object.entries(PROVIDER_LOCATIONS)) {
        for (const loc of locations) {
          expect(VM_LOCATIONS[loc.id]).toBeDefined();
          expect(VM_LOCATIONS[loc.id].name).toBe(loc.name);
          expect(VM_LOCATIONS[loc.id].country).toBe(loc.country);
        }
      }
    });
  });

  describe('PROVIDER_DEFAULT_LOCATIONS', () => {
    it('every default is valid for its provider', () => {
      for (const [provider, location] of Object.entries(PROVIDER_DEFAULT_LOCATIONS)) {
        expect(isValidLocationForProvider(provider, location)).toBe(true);
      }
    });
  });
});

describe('resolveProjectScalingConfig', () => {
  it('uses project value when set', () => {
    expect(resolveProjectScalingConfig(42, '100', 200)).toBe(42);
  });

  it('falls back to env var when project is null', () => {
    expect(resolveProjectScalingConfig(null, '100', 200)).toBe(100);
  });

  it('falls back to default when both are null/undefined', () => {
    expect(resolveProjectScalingConfig(null, undefined, 200)).toBe(200);
  });

  it('falls back to default when env var is non-numeric', () => {
    expect(resolveProjectScalingConfig(null, 'abc', 200)).toBe(200);
  });

  it('falls back to default when env var is empty', () => {
    expect(resolveProjectScalingConfig(null, '', 200)).toBe(200);
  });
});

describe('SCALING_PARAMS registry', () => {
  it('has 8 scaling parameters', () => {
    expect(SCALING_PARAMS).toHaveLength(8);
  });

  it('every param has valid min < max', () => {
    for (const p of SCALING_PARAMS) {
      expect(p.min).toBeLessThan(p.max);
    }
  });

  it('every param default is within [min, max]', () => {
    for (const p of SCALING_PARAMS) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
    }
  });
});
