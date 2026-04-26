/** SSE event types streamed to the browser. */
export type SamSseEvent =
  | { type: 'conversation_started'; conversationId: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Conversation row from SQLite. */
export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/** Message row from SQLite. */
export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  created_at: string;
  sequence: number;
}

/** Anthropic message content block types. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** Anthropic tool definition format. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Tool execution context passed to tool handlers. */
export interface ToolContext {
  env: Record<string, unknown>;
  userId: string;
}

/** A collected tool call from the streaming response. */
export interface CollectedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
