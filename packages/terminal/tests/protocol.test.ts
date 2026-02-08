import { describe, it, expect } from 'vitest';
import {
  encodeTerminalWsInput,
  encodeTerminalWsPing,
  encodeTerminalWsResize,
  parseTerminalWsServerMessage,
} from '../src/protocol';

describe('terminal WebSocket protocol', () => {
  it('encodes input messages expected by the VM Agent', () => {
    expect(encodeTerminalWsInput('ls\n')).toBe(JSON.stringify({ type: 'input', data: { data: 'ls\n' } }));
  });

  it('encodes resize messages expected by the VM Agent', () => {
    expect(encodeTerminalWsResize(24, 80)).toBe(JSON.stringify({ type: 'resize', data: { rows: 24, cols: 80 } }));
  });

  it('encodes ping messages expected by the VM Agent', () => {
    expect(encodeTerminalWsPing()).toBe(JSON.stringify({ type: 'ping' }));
  });

  it('parses server output messages', () => {
    const msg = parseTerminalWsServerMessage('{"type":"output","data":{"data":"hello"}}');
    expect(msg).toEqual({ type: 'output', data: { data: 'hello' } });
  });

  it('returns null for invalid payloads', () => {
    expect(parseTerminalWsServerMessage('not json')).toBeNull();
    expect(parseTerminalWsServerMessage('123')).toBeNull();
    expect(parseTerminalWsServerMessage('{"data":{}}')).toBeNull();
  });
});

