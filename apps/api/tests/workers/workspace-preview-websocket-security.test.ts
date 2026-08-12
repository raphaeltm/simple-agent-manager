import { describe, expect, it } from 'vitest';

import { isolatePreviewResponse } from '../../src/lib/workspace-preview-security';

describe('workspace preview WebSocket response isolation', () => {
  it('preserves the real workerd WebSocket slot and status 101 while filtering response headers', () => {
    const pair = new WebSocketPair();
    const response = new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: {
        'Set-Cookie': 'sam_port_access=evil; Path=/',
        'Clear-Site-Data': '"cookies"',
        'X-App-Protocol': 'preview',
      },
    });

    const isolated = isolatePreviewResponse(response);

    expect(isolated.status).toBe(101);
    expect(isolated.webSocket).toBe(pair[0]);
    expect(isolated.headers.get('set-cookie')).toBeNull();
    expect(isolated.headers.get('clear-site-data')).toBeNull();
    expect(isolated.headers.get('x-app-protocol')).toBe('preview');
  });
});
