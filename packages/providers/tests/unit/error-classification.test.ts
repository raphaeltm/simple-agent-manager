import { describe, expect, it } from 'vitest';

import { classifyGcpError } from '../../src/gcp';
import { classifyHetznerError, isTransientCapacityError } from '../../src/hetzner';
import { classifyScalewayError } from '../../src/scaleway';
import { ProviderError } from '../../src/types';

describe('classifyHetznerError', () => {
  describe('structured error code (primary signal)', () => {
    it('resource_unavailable → transient_capacity', () => {
      expect(classifyHetznerError(422, 'resource_unavailable', 'unsupported location for server type')).toBe(
        'transient_capacity',
      );
    });

    it('server_limit_exceeded → quota_exceeded', () => {
      expect(classifyHetznerError(403, 'server_limit_exceeded', 'server limit exceeded')).toBe('quota_exceeded');
    });

    it('uniqueness_error → invalid_config', () => {
      expect(classifyHetznerError(409, 'uniqueness_error', 'server name already used')).toBe('invalid_config');
    });

    it('invalid_input → invalid_config', () => {
      expect(classifyHetznerError(422, 'invalid_input', 'invalid server_type')).toBe('invalid_config');
    });

    it('forbidden → auth_error', () => {
      expect(classifyHetznerError(403, 'forbidden', 'insufficient permissions')).toBe('auth_error');
    });

    it('unauthorized → auth_error', () => {
      expect(classifyHetznerError(401, 'unauthorized', 'invalid token')).toBe('auth_error');
    });

    it('rate_limit_exceeded → rate_limited', () => {
      expect(classifyHetznerError(429, 'rate_limit_exceeded', 'too many requests')).toBe('rate_limited');
    });

    it('conflict → invalid_config', () => {
      expect(classifyHetznerError(409, 'conflict', 'action conflict')).toBe('invalid_config');
    });

    it('placement_error → invalid_config', () => {
      expect(classifyHetznerError(412, 'placement_error', 'error during placement')).toBe('invalid_config');
    });
  });

  describe('HTTP status code heuristics', () => {
    it('401 without code → auth_error', () => {
      expect(classifyHetznerError(401, undefined, 'invalid token')).toBe('auth_error');
    });

    it('403 without code → auth_error', () => {
      expect(classifyHetznerError(403, undefined, 'forbidden')).toBe('auth_error');
    });

    it('429 without code → rate_limited', () => {
      expect(classifyHetznerError(429, undefined, 'rate limit')).toBe('rate_limited');
    });
  });

  describe('message fallback for 422 without recognized code', () => {
    it('"unavailable" in message → transient_capacity', () => {
      expect(classifyHetznerError(422, undefined, 'Server type cx33 unavailable in fsn1')).toBe(
        'transient_capacity',
      );
    });

    it('"unsupported location for server type" → transient_capacity (the root-cause bug)', () => {
      expect(
        classifyHetznerError(422, undefined, 'unsupported location for server type'),
      ).toBe('transient_capacity');
    });

    it('"no capacity" → transient_capacity', () => {
      expect(classifyHetznerError(422, undefined, 'no capacity for this server type')).toBe('transient_capacity');
    });

    it('"not enough resources" → transient_capacity', () => {
      expect(classifyHetznerError(422, undefined, 'not enough resources available')).toBe('transient_capacity');
    });

    it('non-capacity 422 message → unknown', () => {
      expect(classifyHetznerError(422, undefined, 'some other error')).toBe('unknown');
    });
  });

  describe('unknown errors', () => {
    it('500 without code → unknown', () => {
      expect(classifyHetznerError(500, undefined, 'internal error')).toBe('unknown');
    });

    it('unrecognized code → falls through to status/message heuristics', () => {
      // Unknown code with 422 and non-matching message
      expect(classifyHetznerError(422, 'some_new_code', 'some error')).toBe('unknown');
    });
  });
});

describe('isTransientCapacityError (updated)', () => {
  it('returns true when category is already transient_capacity', () => {
    const err = new ProviderError('hetzner', 422, 'resource unavailable', {
      category: 'transient_capacity',
      providerCode: 'resource_unavailable',
    });
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('returns true for 422 with resource_unavailable code even without category set', () => {
    const err = new ProviderError('hetzner', 422, 'unsupported location for server type', {
      providerCode: 'resource_unavailable',
    });
    // category defaults to 'unknown', but fallback classification should detect it
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('returns true for 422 with "unsupported location" message (no code)', () => {
    const err = new ProviderError('hetzner', 422, 'hetzner API error (422): unsupported location for server type');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('returns false for quota_exceeded category', () => {
    const err = new ProviderError('hetzner', 403, 'server limit exceeded', {
      category: 'quota_exceeded',
    });
    expect(isTransientCapacityError(err)).toBe(false);
  });

  it('returns false for invalid_config category', () => {
    const err = new ProviderError('hetzner', 422, 'invalid input', {
      category: 'invalid_config',
      providerCode: 'invalid_input',
    });
    expect(isTransientCapacityError(err)).toBe(false);
  });

  it('returns false for non-422 errors', () => {
    const err = new ProviderError('hetzner', 403, 'forbidden');
    expect(isTransientCapacityError(err)).toBe(false);
  });
});

describe('classifyScalewayError', () => {
  it('transient type → transient_capacity', () => {
    expect(classifyScalewayError(503, 'transient', 'service temporarily unavailable')).toBe('transient_capacity');
  });

  it('quota_exceeded type → quota_exceeded', () => {
    expect(classifyScalewayError(403, 'quota_exceeded', 'quota exceeded')).toBe('quota_exceeded');
  });

  it('invalid_request_error type → invalid_config', () => {
    expect(classifyScalewayError(400, 'invalid_request_error', 'bad request')).toBe('invalid_config');
  });

  it('permission_denied type → auth_error', () => {
    expect(classifyScalewayError(403, 'permission_denied', 'access denied')).toBe('auth_error');
  });

  it('denied type → auth_error', () => {
    expect(classifyScalewayError(403, 'denied', 'access denied')).toBe('auth_error');
  });

  it('503 without type → transient_capacity', () => {
    expect(classifyScalewayError(503, undefined, 'service unavailable')).toBe('transient_capacity');
  });

  it('401 without type → auth_error', () => {
    expect(classifyScalewayError(401, undefined, 'unauthorized')).toBe('auth_error');
  });

  it('429 without type → rate_limited', () => {
    expect(classifyScalewayError(429, undefined, 'too many requests')).toBe('rate_limited');
  });

  it('unknown type and status → unknown', () => {
    expect(classifyScalewayError(500, undefined, 'internal error')).toBe('unknown');
  });

  it('not_found type → invalid_config', () => {
    expect(classifyScalewayError(404, 'not_found', 'resource not found')).toBe('invalid_config');
  });

  it('message fallback for capacity-related 400', () => {
    expect(classifyScalewayError(400, undefined, 'insufficient capacity in zone')).toBe('transient_capacity');
  });
});

describe('classifyGcpError', () => {
  it('UNAVAILABLE → transient_capacity', () => {
    expect(classifyGcpError(503, 'UNAVAILABLE', 'zone unavailable')).toBe('transient_capacity');
  });

  it('ZONE_RESOURCE_POOL_EXHAUSTED → transient_capacity', () => {
    expect(
      classifyGcpError(429, 'ZONE_RESOURCE_POOL_EXHAUSTED', 'zone resource pool exhausted'),
    ).toBe('transient_capacity');
  });

  it('ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS → transient_capacity', () => {
    expect(
      classifyGcpError(429, 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS', 'exhausted with details'),
    ).toBe('transient_capacity');
  });

  it('RESOURCE_EXHAUSTED → quota_exceeded', () => {
    expect(classifyGcpError(429, 'RESOURCE_EXHAUSTED', 'quota exceeded')).toBe('quota_exceeded');
  });

  it('QUOTA_EXCEEDED → quota_exceeded', () => {
    expect(classifyGcpError(429, 'QUOTA_EXCEEDED', 'quota limit reached')).toBe('quota_exceeded');
  });

  it('PERMISSION_DENIED → auth_error', () => {
    expect(classifyGcpError(403, 'PERMISSION_DENIED', 'access denied')).toBe('auth_error');
  });

  it('UNAUTHENTICATED → auth_error', () => {
    expect(classifyGcpError(401, 'UNAUTHENTICATED', 'invalid credentials')).toBe('auth_error');
  });

  it('INVALID_ARGUMENT → invalid_config', () => {
    expect(classifyGcpError(400, 'INVALID_ARGUMENT', 'invalid parameter')).toBe('invalid_config');
  });

  it('NOT_FOUND → invalid_config', () => {
    expect(classifyGcpError(404, 'NOT_FOUND', 'resource not found')).toBe('invalid_config');
  });

  it('ALREADY_EXISTS → invalid_config', () => {
    expect(classifyGcpError(409, 'ALREADY_EXISTS', 'resource already exists')).toBe('invalid_config');
  });

  it('RATE_LIMIT_EXCEEDED → rate_limited', () => {
    expect(classifyGcpError(429, 'RATE_LIMIT_EXCEEDED', 'rate limit exceeded')).toBe('rate_limited');
  });

  it('503 without code → transient_capacity', () => {
    expect(classifyGcpError(503, undefined, 'service unavailable')).toBe('transient_capacity');
  });

  it('401 without code → auth_error', () => {
    expect(classifyGcpError(401, undefined, 'unauthorized')).toBe('auth_error');
  });

  it('429 without code → rate_limited', () => {
    expect(classifyGcpError(429, undefined, 'too many requests')).toBe('rate_limited');
  });

  it('message fallback: zone resource pool exhausted → transient_capacity', () => {
    expect(classifyGcpError(200, undefined, 'zone resource pool exhausted for type e2-standard-4')).toBe(
      'transient_capacity',
    );
  });

  it('message fallback: resource exhausted → quota_exceeded', () => {
    expect(classifyGcpError(200, undefined, 'Resource exhausted: CPU quota')).toBe('quota_exceeded');
  });

  it('unknown code and status → unknown', () => {
    expect(classifyGcpError(500, undefined, 'internal error')).toBe('unknown');
  });
});
