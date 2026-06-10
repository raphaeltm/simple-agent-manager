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

  // Table-driven: [description, path, expected repository, expected resource]
  it.each([
    ['manifest path with slash-containing repo', '/v2/proj-abc/my/app/manifests/latest', 'proj-abc/my/app', 'manifests/latest'],
    ['blob path', '/v2/proj-abc/app/blobs/sha256:deadbeef', 'proj-abc/app', 'blobs/sha256:deadbeef'],
    ['blob upload session start', '/v2/proj-abc/app/blobs/uploads/', 'proj-abc/app', 'blobs/uploads/'],
    ['blob upload session continuation', '/v2/proj-abc/app/blobs/uploads/some-uuid', 'proj-abc/app', 'blobs/uploads/some-uuid'],
    ['tags list path', '/v2/proj-abc/app/tags/list', 'proj-abc/app', 'tags/list'],
    // Uses the LAST resource segment: a repo literally named "proj-abc/blobs"
    ['repo name containing a resource word', '/v2/proj-abc/blobs/manifests/latest', 'proj-abc/blobs', 'manifests/latest'],
  ])('parses %s', (_description, path, repository, resource) => {
    expect(parseV2Path(path)).toEqual({ kind: 'repository', repository, resource });
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
