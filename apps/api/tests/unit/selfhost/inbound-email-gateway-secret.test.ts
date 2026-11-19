/**
 * The Worker-loaded inbound email gate (services/agent-email/self-host-inbound.ts) mirrors the
 * self-host gateway's minimum secret length without importing the self-host module. Pin them.
 */
import { describe, expect, it } from 'vitest';

import { MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH } from '../../../src/selfhost/reverse-tunnel/config';
import { MIN_GATEWAY_SECRET_LENGTH } from '../../../src/services/agent-email/self-host-inbound';

describe('inbound email gateway secret length', () => {
  it('gates on the same minimum gateway-secret length the self-host gateway enforces', () => {
    expect(MIN_GATEWAY_SECRET_LENGTH).toBe(MIN_REVERSE_TUNNEL_GATEWAY_SECRET_LENGTH);
  });
});
