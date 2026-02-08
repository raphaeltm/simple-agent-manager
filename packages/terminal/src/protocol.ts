/**
 * Extended WebSocket protocol for multi-terminal support
 * Adds sessionId routing to all messages
 */

export type TerminalWsServerMessage =
  | { type: 'output'; sessionId?: string; data?: { data?: string } }
  | { type: 'session'; sessionId?: string; data?: { sessionId?: string } }
  | { type: 'error'; sessionId?: string; data?: unknown }
  | { type: 'pong'; sessionId?: string; data?: unknown }
  | { type: 'session_created'; sessionId?: string; data?: { sessionId: string; workingDirectory?: string; shell?: string } }
  | { type: 'session_closed'; sessionId?: string; data?: { sessionId: string; reason: string; exitCode?: number } }
  | { type: 'session_renamed'; sessionId?: string; data?: { sessionId: string; name: string } }
  | { type: 'session_list'; data?: { sessions: Array<{ sessionId: string; name?: string; workingDirectory?: string; createdAt: string; lastActivityAt?: string }> } }
  | { type: string; sessionId?: string; data?: unknown };

export type TerminalWsClientMessage =
  | { type: 'input'; sessionId?: string; data: { data: string } }
  | { type: 'resize'; sessionId?: string; data: { rows: number; cols: number } }
  | { type: 'ping'; sessionId?: string }
  | { type: 'create_session'; data: { sessionId: string; rows: number; cols: number; name?: string } }
  | { type: 'close_session'; data: { sessionId: string } }
  | { type: 'rename_session'; data: { sessionId: string; name: string } }
  | { type: string; sessionId?: string; data?: unknown };

export function parseTerminalWsServerMessage(text: string): TerminalWsServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;

    const msg = parsed as { type?: unknown; sessionId?: unknown; data?: unknown };
    if (typeof msg.type !== 'string') return null;

    return {
      type: msg.type,
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
      data: msg.data
    } as TerminalWsServerMessage;
  } catch {
    return null;
  }
}

/**
 * Encode messages with optional sessionId for multi-terminal support
 */

export function encodeTerminalWsInput(data: string, sessionId?: string): string {
  return JSON.stringify({
    type: 'input',
    ...(sessionId && { sessionId }),
    data: { data }
  });
}

export function encodeTerminalWsResize(rows: number, cols: number, sessionId?: string): string {
  return JSON.stringify({
    type: 'resize',
    ...(sessionId && { sessionId }),
    data: { rows, cols }
  });
}

export function encodeTerminalWsPing(sessionId?: string): string {
  return JSON.stringify({
    type: 'ping',
    ...(sessionId && { sessionId })
  });
}

/**
 * New message encoders for multi-terminal operations
 */

export function encodeTerminalWsCreateSession(sessionId: string, rows: number, cols: number, name?: string): string {
  return JSON.stringify({
    type: 'create_session',
    data: { sessionId, rows, cols, ...(name && { name }) }
  });
}

export function encodeTerminalWsCloseSession(sessionId: string): string {
  return JSON.stringify({
    type: 'close_session',
    data: { sessionId }
  });
}

export function encodeTerminalWsRenameSession(sessionId: string, name: string): string {
  return JSON.stringify({
    type: 'rename_session',
    data: { sessionId, name }
  });
}

/**
 * Helper to check if a message is for a specific session
 */
export function isMessageForSession(msg: TerminalWsServerMessage, sessionId: string): boolean {
  // If no sessionId in message, it's for the default/first session
  if (!msg.sessionId) return false;
  return msg.sessionId === sessionId;
}

/**
 * Type guards for specific message types
 */
export function isOutputMessage(msg: TerminalWsServerMessage): msg is { type: 'output'; sessionId?: string; data?: { data?: string } } {
  return msg.type === 'output';
}

export function isSessionCreatedMessage(msg: TerminalWsServerMessage): msg is { type: 'session_created'; sessionId?: string; data?: { sessionId: string; workingDirectory?: string; shell?: string } } {
  return msg.type === 'session_created';
}

export function isSessionClosedMessage(msg: TerminalWsServerMessage): msg is { type: 'session_closed'; sessionId?: string; data?: { sessionId: string; reason: string; exitCode?: number } } {
  return msg.type === 'session_closed';
}

export function isErrorMessage(msg: TerminalWsServerMessage): msg is { type: 'error'; sessionId?: string; data?: unknown } {
  return msg.type === 'error';
}

