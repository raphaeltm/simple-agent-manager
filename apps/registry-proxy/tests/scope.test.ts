import { describe, expect, it } from 'vitest';
import { parseScope, parseV2Path, projectNamespace, requiredAction } from '../src/scope';

describe('parseScope', () => {
  it('parses a simple repository scope', () => {
    expect(parseScope('repository:proj-abc/app:push,pull')).toEqual({
      type: 'repository',
      name: 'proj-abc/app',
      actions: ['push', 'pull'],
    });
  });

  it('parses resource names containing colons (host:port prefixes)', () => {
    expect(parseScope('repository:localhost:5000/proj-abc/app:pull')).toEqual({
      type: 'repository',
      name: 'localhost:5000/proj-abc/app',
      actions: ['pull'],
    });
  });

  it('rejects malformed scopes', () => {
    expect(parseScope('')).toBeNull();
    expect(parseScope('repository')).toBeNull();
    expect(parseScope('repository:name')).toBeNull();
    expect(parseScope('repository:name:')).toBeNull();
    expect(parseScope(':name:pull')).toBeNull();
  });

  it('trims and drops empty actions', () => {
    expect(parseScope('repository:foo/bar: pull , push ,')).toEqual({
      type: 'repository',
      name: 'foo/bar',
      actions: ['pull', 'push'],
    });
  });
});

describe('projectNamespace', () => {
  it('lowercases the project id and appends a slash', () => {
    expect(projectNamespace('01KHRJGAN')).toBe('proj-01khrjgan/');
  });
});

describe('parseV2Path', () => {
  it('recognizes the ping path with and without trailing slash', () => {
    expect(parseV2Path('/v2')).toEqual({ kind: 'ping' });
    expect(parseV2Path('/v2/')).toEqual({ kind: 'ping' });
  });

  it('recognizes the catalog path', () => {
    expect(parseV2Path('/v2/_catalog')).toEqual({ kind: 'catalog' });
  });

  it('parses manifest paths for repositories containing slashes', () => {
    expect(parseV2Path('/v2/proj-abc/my/app/manifests/latest')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/my/app',
      resource: 'manifests/latest',
    });
  });

  it('parses blob paths', () => {
    expect(parseV2Path('/v2/proj-abc/app/blobs/sha256:deadbeef')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/app',
      resource: 'blobs/sha256:deadbeef',
    });
  });

  it('parses blob upload session paths', () => {
    expect(parseV2Path('/v2/proj-abc/app/blobs/uploads/')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/app',
      resource: 'blobs/uploads/',
    });
    expect(parseV2Path('/v2/proj-abc/app/blobs/uploads/some-uuid')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/app',
      resource: 'blobs/uploads/some-uuid',
    });
  });

  it('parses tags list paths', () => {
    expect(parseV2Path('/v2/proj-abc/app/tags/list')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/app',
      resource: 'tags/list',
    });
  });

  it('uses the LAST resource segment when a repo name contains a resource word', () => {
    // A repository literally named "proj-abc/blobs" pulling a manifest
    expect(parseV2Path('/v2/proj-abc/blobs/manifests/latest')).toEqual({
      kind: 'repository',
      repository: 'proj-abc/blobs',
      resource: 'manifests/latest',
    });
  });

  it('returns unknown for unparseable paths', () => {
    expect(parseV2Path('/v2/justonething')).toEqual({ kind: 'unknown' });
    expect(parseV2Path('/healthz')).toEqual({ kind: 'unknown' });
    expect(parseV2Path('/v2/manifests/latest')).toEqual({ kind: 'unknown' });
  });
});

describe('requiredAction', () => {
  it('maps read methods to pull', () => {
    expect(requiredAction('GET')).toBe('pull');
    expect(requiredAction('HEAD')).toBe('pull');
  });

  it('maps write methods to push', () => {
    expect(requiredAction('POST')).toBe('push');
    expect(requiredAction('PUT')).toBe('push');
    expect(requiredAction('PATCH')).toBe('push');
    expect(requiredAction('DELETE')).toBe('push');
  });
});
