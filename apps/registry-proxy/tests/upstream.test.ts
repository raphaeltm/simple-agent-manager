import { describe, expect, it } from 'vitest';
import { buildUpstreamRequest, rewriteLocation } from '../src/upstream';

describe('rewriteLocation', () => {
  const upstream = 'http://localhost:5000';
  const proxy = 'https://registry.example.com';

  it('keeps relative locations as-is', () => {
    expect(rewriteLocation('/v2/proj-a/app/blobs/uploads/uuid?_state=x', upstream, proxy)).toBe(
      '/v2/proj-a/app/blobs/uploads/uuid?_state=x'
    );
  });

  it('re-roots absolute locations pointing at the upstream host', () => {
    expect(
      rewriteLocation('http://localhost:5000/v2/proj-a/app/blobs/uploads/uuid?_state=x', upstream, proxy)
    ).toBe('https://registry.example.com/v2/proj-a/app/blobs/uploads/uuid?_state=x');
  });

  it('passes through absolute locations pointing elsewhere (signed blob URLs)', () => {
    const signed = 'https://r2.cloudflarestorage.com/bucket/sha256:abc?X-Amz-Signature=zzz';
    expect(rewriteLocation(signed, upstream, proxy)).toBe(signed);
  });

  it('passes through unparseable locations untouched', () => {
    expect(rewriteLocation('::not-a-url::', upstream, proxy)).toBe('::not-a-url::');
  });
});

describe('buildUpstreamRequest', () => {
  const config = {
    upstreamUrl: 'http://localhost:5000',
    username: 'user',
    password: 'pass',
  };

  it('re-roots the URL at the upstream preserving path and query', () => {
    const req = new Request('https://proxy.example.com/v2/proj-a/app/manifests/latest?foo=1');
    const out = buildUpstreamRequest(req, config);
    expect(out.url).toBe('http://localhost:5000/v2/proj-a/app/manifests/latest?foo=1');
  });

  it('strips the client Authorization header and injects upstream Basic auth', () => {
    const req = new Request('https://proxy.example.com/v2/proj-a/app/manifests/latest', {
      headers: { Authorization: 'Bearer client-jwt', Accept: 'application/vnd.oci.image.manifest.v1+json' },
    });
    const out = buildUpstreamRequest(req, config);
    expect(out.headers.get('authorization')).toBe(`Basic ${btoa('user:pass')}`);
    expect(out.headers.get('accept')).toBe('application/vnd.oci.image.manifest.v1+json');
  });

  it('omits upstream auth when no credential is configured', () => {
    const req = new Request('https://proxy.example.com/v2/proj-a/app/manifests/latest', {
      headers: { Authorization: 'Bearer client-jwt' },
    });
    const out = buildUpstreamRequest(req, { upstreamUrl: 'http://localhost:5000' });
    expect(out.headers.get('authorization')).toBeNull();
  });

  it('strips hop headers but forwards content headers', () => {
    const req = new Request('https://proxy.example.com/v2/proj-a/app/blobs/uploads/u', {
      method: 'PATCH',
      headers: {
        Host: 'proxy.example.com',
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/octet-stream',
        'Content-Range': '0-1023',
      },
      body: new Uint8Array(8),
    });
    const out = buildUpstreamRequest(req, config);
    expect(out.headers.get('cf-connecting-ip')).toBeNull();
    expect(out.headers.get('content-type')).toBe('application/octet-stream');
    expect(out.headers.get('content-range')).toBe('0-1023');
    expect(out.method).toBe('PATCH');
  });

  it('does not attach a body to GET/HEAD requests', () => {
    const req = new Request('https://proxy.example.com/v2/proj-a/app/manifests/latest');
    const out = buildUpstreamRequest(req, config);
    expect(out.body).toBeNull();
  });
});
