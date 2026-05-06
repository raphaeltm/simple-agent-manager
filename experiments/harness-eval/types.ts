/**
 * Core types for the harness model evaluation suite.
 */

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Chat messages (OpenAI format)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
  /** Gemma 4 returns reasoning traces in this field. */
  reasoning?: string;
}

export interface ToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---------------------------------------------------------------------------
// API response (OpenAI chat completion format)
// ---------------------------------------------------------------------------

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  model: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export type GatewayPath = 'workers-ai' | 'unified';

export interface ModelConfig {
  /** Human-friendly display name */
  displayName: string;
  /** Model ID for the API request */
  modelId: string;
  /** Unified API model ID (provider/model) for unified path, raw model ID for workers-ai */
  apiModelId: string;
  /** Which AI Gateway endpoint path to use */
  path: GatewayPath;
  /** Cost per 1K input tokens (USD). Workers AI = estimated Cloudflare cost, not $0. */
  costPer1kInput: number;
  /** Cost per 1K output tokens (USD). Workers AI = estimated Cloudflare cost, not $0. */
  costPer1kOutput: number;
  /** Provider name */
  provider: 'workers-ai' | 'anthropic' | 'openai';
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/** Mock tool handler — returns a string result given parsed arguments. */
export type ToolHandler = (args: Record<string, unknown>) => string;

/** A tool with its definition and mock handler. */
export interface EvalTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

export interface EvalScenario {
  /** Unique scenario identifier (kebab-case) */
  id: string;
  /** Human-friendly name */
  name: string;
  /** Category for grouping */
  category: 'baseline' | 'coding' | 'error-handling';
  /** What this scenario tests */
  description: string;
  /** System prompt for the model */
  systemPrompt: string;
  /** User prompt that starts the conversation */
  userPrompt: string;
  /** Tools available in this scenario */
  tools: EvalTool[];
  /** Maximum turns before declaring failure */
  maxTurns: number;
  /** Rubric: evaluate whether the run passed */
  evaluate: (run: ScenarioRun) => RubricResult;
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

export interface ScenarioRun {
  /** Which scenario was run */
  scenarioId: string;
  /** Which model was used */
  model: ModelConfig;
  /** All messages exchanged (full conversation) */
  messages: ChatMessage[];
  /** Tool calls made during the run */
  toolCalls: ToolCallRecord[];
  /** Total token usage across all turns */
  totalUsage: TokenUsage;
  /** Per-turn usage for detailed analysis */
  turnUsage: Array<{ turn: number; usage: TokenUsage | null }>;
  /** Total wall-clock time in milliseconds */
  totalLatencyMs: number;
  /** Per-turn latency */
  turnLatency: Array<{ turn: number; latencyMs: number }>;
  /** How the run ended */
  stopReason: 'complete' | 'max_turns' | 'error';
  /** Number of turns used */
  turnsUsed: number;
  /** Error message if the run failed with an exception */
  error?: string;
}

export interface ToolCallRecord {
  turn: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Rubric / scoring
// ---------------------------------------------------------------------------

export interface RubricResult {
  /** Whether the scenario passed */
  pass: boolean;
  /** Human-readable explanation */
  reason: string;
  /** Optional structured checks */
  checks?: Array<{ name: string; pass: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Trace (persisted to JSON)
// ---------------------------------------------------------------------------

export interface EvalTrace {
  /** Trace format version */
  version: '1.0';
  /** When the trace was generated */
  timestamp: string;
  /** Suite-level metadata */
  suite: {
    /** Git commit hash */
    commitHash: string;
    /** Prompt/tool schema version (incremented when prompts or tool defs change) */
    schemaVersion: string;
  };
  /** Individual scenario results */
  results: ScenarioResult[];
  /** Aggregate summary */
  summary: EvalSummary;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  model: {
    displayName: string;
    modelId: string;
    provider: string;
    path: GatewayPath;
  };
  /** Pass/fail and reason */
  rubric: RubricResult;
  /** Token usage */
  usage: TokenUsage;
  /** Derived cost in USD */
  costUsd: number;
  /** Wall-clock latency in ms */
  latencyMs: number;
  /** Number of turns used */
  turnsUsed: number;
  /** How the run stopped */
  stopReason: string;
  /** Full conversation (messages, tool calls, results) */
  conversation: ChatMessage[];
  /** Tool call records */
  toolCalls: ToolCallRecord[];
  /** Per-turn token usage */
  turnUsage: Array<{ turn: number; usage: TokenUsage | null }>;
  /** Per-turn latency */
  turnLatency: Array<{ turn: number; latencyMs: number }>;
  /** Error if the run errored */
  error?: string;
}

export interface EvalSummary {
  /** Total scenarios run */
  totalScenarios: number;
  /** Scenarios that passed */
  passedScenarios: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Total cost across all runs (USD) */
  totalCostUsd: number;
  /** Cost per successful task (total cost / passed scenarios), Infinity if none passed */
  costPerSuccessUsd: number;
  /** Average latency across all runs (ms) */
  avgLatencyMs: number;
  /** Per-model breakdown */
  perModel: Array<{
    model: string;
    provider: string;
    totalRuns: number;
    passed: number;
    successRate: number;
    totalCostUsd: number;
    costPerSuccessUsd: number;
    avgLatencyMs: number;
    totalTokens: number;
  }>;
}
