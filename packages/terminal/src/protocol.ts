export type TerminalWsServerMessage =
  | { type: 'output'; data?: { data?: string } }
  | { type: 'session'; data?: { sessionId?: string } }
  | { type: 'error'; data?: unknown }
  | { type: 'pong'; data?: unknown }
  | { type: string; data?: unknown };

export function parseTerminalWsServerMessage(text: string): TerminalWsServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;

    const msg = parsed as { type?: unknown; data?: unknown };
    if (typeof msg.type !== 'string') return null;

    return { type: msg.type, data: msg.data } as TerminalWsServerMessage;
  } catch {
    return null;
  }
}

export function encodeTerminalWsInput(data: string): string {
  return JSON.stringify({ type: 'input', data: { data } });
}

export function encodeTerminalWsResize(rows: number, cols: number): string {
  return JSON.stringify({ type: 'resize', data: { rows, cols } });
}

export function encodeTerminalWsPing(): string {
  return JSON.stringify({ type: 'ping' });
}

